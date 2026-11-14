import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { eventually } from "../fixtures/factory-process";
import { substrateFixture } from "../fixtures/substrate";
import { fixtureValue } from "../fixtures/value";

test("native source rejects timed-out human saves after Agent takeover and retains files through service restart", async () => {
  const owner = crypto.randomUUID();
  const container = `factory-owned-writer-source-${owner}`;
  const imageTag = `factory-owned-writer-source:${owner}`;
  const temporary = await mkdtemp(join(tmpdir(), "factory-writer-source-"));
  const owned = await substrateFixture("a".repeat(40), "ticket");
  let sources: ReturnType<typeof createWorkspaceSourceController> | undefined;
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
    await mkdir(join(temporary, "project"));
    const access = {
      workspaceId: workspace.id,
      serviceId: "owned-source",
      epoch: 1,
      token: "owned-source-capability-with-thirty-two-characters",
      ownerEpoch: 1,
      writerEpoch: 1,
      readOnly: false,
    };
    await writeFile(join(temporary, "access.json"), JSON.stringify(access), { mode: 0o644 });
    await docker(
      "build",
      "--label",
      `factory.owned-writer-source=${owner}`,
      "--tag",
      imageTag,
      "--file",
      "test/fixtures/native-source-service.Dockerfile",
      ".",
    );
    const image = await docker("image", "inspect", "--format", "{{.Id}}", imageTag);
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw Error("Owned native Source image identity missing");
    const evidence = join(".factory/test-results/change-writer-source", owner);
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "intent.json"),
      JSON.stringify({ owner, container, image, temporary }),
    );
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
      image,
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
    const hub = new RuntimeHub(async () => {});
    hub.sourceConnected = () => true;
    hub.request = async (_attempt, channel, request, path) => {
      expect(channel).toBe("source");
      return native(
        path.split("/").at(-1) ?? "",
        await request.json(),
        request.headers.get("X-Factory-Writer-Epoch") ?? undefined,
      );
    };
    const actorUID = crypto.randomUUID();
    // Controlled original-Actor observation for this Source-service proof.
    // No Kubernetes Source client, native Actor or model is created here.
    await owned.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${owned.workspaceID},'{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${owned.attemptID},${owned.projectID},${owned.workspaceID},${owned.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID})`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at)
        VALUES(${owned.attemptID},${owned.atespace},${`runtime-${owned.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${owned.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${owned.attemptID} WHERE id=${owned.changeID}`;
    });
    const source = createSubstrateSources(owned.database, hub);
    await source.attach(workspace.id, actorUID, owned.database.client);
    sources = createWorkspaceSourceController(owned.database, hub, source);
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
    // The restarted host receives the current recorded Change fence, not its
    // original human's access epoch. No Source epoch or filesystem is replaced.
    const [writer] = await owned.database.client<{ epoch: number; writable: boolean }[]>`
      SELECT epoch::float8 AS epoch,state='human' AS writable FROM factory.change_writer WHERE change_id=${owned.changeID}`;
    if (!writer) throw Error("Owned native Source writer disappeared");
    access.writerEpoch = writer.epoch;
    access.readOnly = !writer.writable;
    await writeFile(join(temporary, "access.json"), JSON.stringify(access), { mode: 0o644 });
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
      await docker("exec", container, "chmod", "-R", "a+rwX", "/workspace/project");
      await docker("rm", "--force", container);
    }
    if (await docker("image", "ls", "--quiet", imageTag)) {
      expect(
        await docker(
          "image",
          "inspect",
          "--format",
          '{{index .Config.Labels "factory.owned-writer-source"}}',
          imageTag,
        ),
      ).toBe(owner);
      await docker("image", "rm", imageTag);
    }
    await owned.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}, 300_000);
