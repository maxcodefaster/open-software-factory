import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("native source rejects timed-out human saves after Agent takeover and retains files through service restart", async () => {
  const owner = crypto.randomUUID();
  const container = `factory-owned-writer-source-${owner}`;
  const temporary = await mkdtemp(join(tmpdir(), "factory-writer-source-"));
  const databaseFixture = await factoryProcess();
  const owned = await fixture(undefined, undefined, databaseFixture.connect());
  let sources: ReturnType<typeof createWorkspaceSourceController> | undefined;
  const previousImage = process.env["FACTORY_WORKSPACE_FILES_IMAGE"];
  async function docker(...args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [output, error, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status) throw new Error(`Owned source ${args[0]} failed: ${error.slice(-1200)}`);
    return output.trim();
  }
  try {
    const [workspace] = await owned.database.client<
      { id: string }[]
    >`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`;
    if (!workspace) throw new Error("Owned source Workspace missing");
    await chmod(temporary, 0o777);
    const access = {
      workspaceId: workspace.id,
      serviceId: "owned-source",
      epoch: 1,
      token: "owned-source-capability-with-thirty-two-characters",
    };
    await writeFile(join(temporary, "access.json"), JSON.stringify(access), { mode: 0o644 });
    const image =
      process.env["FACTORY_WORKSPACE_FILES_TEST_IMAGE"] ??
      (await readFile(".factory/workspace-files-image", "utf8")).trim();
    if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Owned source proof requires an exact image digest");
    const evidence = join(".factory/test-results/change-writer-source", owner);
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "intent.json"),
      JSON.stringify({ owner, container, image, temporary }),
    );
    process.env["FACTORY_WORKSPACE_FILES_IMAGE"] = image;
    await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `factory.owned-writer-source=${owner}`,
      "--volume",
      `${temporary}:/workspace`,
      "--publish",
      "127.0.0.1::4600",
      image.replace(
        "registry.open-factory-envbox-smoke.svc.cluster.local:5000",
        "registry.localhost:5443",
      ),
      "--root",
      "/workspace",
      "--assignment",
      "/workspace/access.json",
      "--listen",
      "0.0.0.0:4600",
    );
    const port = (await docker("port", container, "4600/tcp")).split(":").at(-1);
    let origin = `http://127.0.0.1:${port}`;
    const native = async (operation: string, body: unknown, epoch?: string) =>
      fetch(`${origin}/v1/workspaces/${workspace.id}/${operation}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${access.token}`,
          "content-type": "application/json",
          "X-Factory-Source-Service": access.serviceId,
          "X-Factory-Source-Epoch": "1",
          ...(epoch ? { "X-Factory-Writer-Epoch": epoch } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      });
    await eventually(
      () => native("stat", { path: "" }).catch(() => null),
      (value) => value?.ok === true,
      "Native source did not start",
    );
    sources = createWorkspaceSourceController(owned.database, "owned-source-secret", {
      async executionNode() {
        return "owned-node";
      },
      async prepare() {
        return {
          namespaceUID: "owned-namespace",
          claimUID: "owned-claim",
          podUID: "owned-pod",
          storageNode: "owned-node",
          ready: true,
          failed: false,
        };
      },
      async observe() {
        return null;
      },
      async connect() {},
      async stop() {},
      close() {},
      async request(_input, operation, request) {
        return native(
          operation,
          await request.json(),
          request.headers.get("X-Factory-Writer-Epoch") ?? undefined,
        );
      },
    });
    await sources.ensure(workspace.id, owned.userID);
    await eventually(
      () => fixtureValue(sources, "sources").get(workspace.id, owned.userID),
      (value) => value.state === "ready",
      "Source SQL not ready",
    );
    const writers = createChangeWriterController({
      database: owned.database,
      agentUsername: "owned-agent",
      runtime: {
        async stop() {},
        async get() {
          return { state: "stopped" };
        },
      },
      stopAgent: async () => {},
      protect: async () => {},
      fenceSource: sources.fenceChange,
    });
    const human = await writers.takeOver(owned.changeID, owned.userID, crypto.randomUUID());
    const save = (text: string) =>
      new Request("http://factory.invalid/write", {
        method: "POST",
        body: JSON.stringify({
          path: "human.txt",
          content: Buffer.from(text).toString("base64"),
          version: "",
        }),
      });
    expect(
      (await sources.forward(workspace.id, owned.userID, "write", save("retained human work"))).ok,
    ).toBe(true);
    const turnID = crypto.randomUUID();
    await owned.database.client.begin((sql) =>
      claimAgentWriterIn(sql, owned.changeID, turnID, owned.userID),
    );
    await writers.prepareAgent(owned.changeID, turnID);
    expect(
      (
        await native(
          "write",
          { path: "late.txt", content: Buffer.from("late").toString("base64") },
          String(human.epoch),
        )
      ).status,
    ).toBe(409);
    expect((await native("read", { path: "human.txt" })).ok).toBe(true);
    await expect(
      sources.forward(workspace.id, owned.userID, "write", save("late")),
    ).rejects.toThrow("observation-only");
    const previousStart = await docker("inspect", "--format", "{{.State.StartedAt}}", container);
    const restart = Bun.spawn(["docker", "restart", "--timeout", "0", container], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const restartOutput = Promise.all([
      new Response(restart.stdout).text(),
      new Response(restart.stderr).text(),
    ]);
    try {
      // The local Docker restart acknowledgement can outlive the actual restart.
      // Confirm a different process start identity instead of resending the command.
      await eventually(
        () => docker("inspect", "--format", "{{.State.StartedAt}}", container),
        (started) => started !== previousStart,
        "The owned source process did not restart",
        30_000,
      );
    } finally {
      if (restart.exitCode === null) restart.kill("SIGKILL");
      await restart.exited;
      await restartOutput;
    }
    origin = `http://127.0.0.1:${(await docker("port", container, "4600/tcp")).split(":").at(-1)}`;
    await eventually(
      () => native("stat", { path: "" }).catch(() => null),
      (value) => value?.ok === true,
      "Restarted source unavailable",
    );
    expect(
      (
        await native(
          "write",
          { path: "late.txt", content: Buffer.from("late").toString("base64") },
          String(human.epoch),
        )
      ).status,
    ).toBe(409);
    const retained = await (await native("read", { path: "human.txt" })).json();
    expect(Buffer.from(retained.content, "base64").toString()).toBe("retained human work");
  } finally {
    await sources?.close();
    const existing = await docker(
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${container}$`,
      "--format",
      "{{.Names}}",
    );
    if (existing) {
      expect(existing).toBe(container);
      expect(
        await docker(
          "inspect",
          "--format",
          '{{index .Config.Labels "factory.owned-writer-source"}}',
          container,
        ),
      ).toBe(owner);
      await docker("rm", "--force", container);
    }
    await owned.dispose();
    await databaseFixture.dispose();
    await rm(temporary, { recursive: true, force: true });
    if (previousImage === undefined) delete process.env["FACTORY_WORKSPACE_FILES_IMAGE"];
    else process.env["FACTORY_WORKSPACE_FILES_IMAGE"] = previousImage;
  }
}, 120_000);
