import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  ensureOpenCodeMessageBoundary,
  interruptOpenCodeSession,
} from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { docker, observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

// Previous accepted Build artifact. Only this migration proof starts the old release.
const previousImage =
  "registry.localhost:5443/open-factory/build-runtime-host@sha256:c15240d9a089fa0493ea5dcf0df1f33039c106920e62441153427c22fa2d7c85";
const candidateImage = process.env["FACTORY_OPENCODE_UPGRADE_IMAGE"];

test.skipIf(!candidateImage)(
  "candidate OpenCode preserves 2.0.3 history, usage, queued identity and developer files",
  async () => {
    if (!candidateImage) throw new Error("An exact candidate Build artifact is required");
    const owner = crypto.randomUUID();
    const container = `factory-owned-opencode-upgrade-${owner}`;
    const scratch = await realpath(await mkdtemp(resolve(tmpdir(), "factory-opencode-upgrade-")));
    const project = resolve(scratch, "project");
    await mkdir(project);
    const sessionID = `ses_owned_${owner.replaceAll("-", "")}`;
    const input = {
      sessionID,
      promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Retained queued input",
      bootstrap: false,
    };
    let created = false;
    let upgraded: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
    async function disposePrevious() {
      if (!created) return;
      const label = await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-process-test"}}',
        container,
      );
      if (label !== owner) throw new Error("Previous process cleanup refused");
      await docker("rm", "--force", container);
    }
    try {
      await docker(
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        `factory.owned-process-test=${owner}`,
        "--env",
        "FACTORY_PROCESS_PACKAGED_SERVER=1",
        "--env",
        `FACTORY_PROCESS_MODEL_ID=${buildModelID}`,
        "--publish",
        "127.0.0.1::4096",
        "--publish",
        "127.0.0.1::4097",
        "--mount",
        `type=bind,src=${project},dst=/workspace/project`,
        "--mount",
        `type=bind,src=${resolve("test/fixtures")},dst=/owned-fixture,readonly`,
        "--entrypoint",
        "node",
        previousImage,
        "/owned-fixture/opencode-process.mjs",
      );
      created = true;
      const port = (await docker("port", container, "4096/tcp")).split(":").at(-1);
      const controlPort = (await docker("port", container, "4097/tcp")).split(":").at(-1);
      const transport = (request: Request, path: string) => {
        const target = new Request(`http://127.0.0.1:${port}${path}`, request);
        target.headers.set(
          "authorization",
          `Basic ${Buffer.from("opencode:owned-opencode-server-password").toString("base64")}`,
        );
        return fetch(target, { signal: AbortSignal.timeout(15_000) })
          .then((response) => {
            if (!response.ok) throw new Error(`Previous OpenCode ${path}: HTTP ${response.status}`);
            return response;
          })
          .catch((cause) => {
            throw new Error(`Previous OpenCode request failed: ${path}`, { cause });
          });
      };
      const raw = (path: string, method = "GET") =>
        transport(new Request(`http://owned${path}`, { method }), path);
      const control = (action: string) =>
        fetch(`http://127.0.0.1:${controlPort}/control${action}`, { method: "POST" });
      await observe(
        async () =>
          raw("/api/health")
            .then((r) => r.json())
            .catch(() => null),
        (value) => value?.version === "2.0.3",
        "Previous exact server did not become ready",
        45_000,
      );
      const client = createOpenCodeClient(transport);
      await client.session.create({
        id: sessionID,
        location: { directory: "/workspace/project" },
        model: { providerID: "factory", id: buildModelID },
      });
      expect(
        (
          await raw(
            "/api/plugin/await-activation?location[directory]=%2Fworkspace%2Fproject",
            "POST",
          )
        ).ok,
      ).toBe(true);
      await client.session.switchAgent({ sessionID, agent: "build" });
      await control("/usage");
      await control("/release");
      await client.session.prompt({ sessionID, text: "Previous completed input" });
      await observe(
        () => client.message.list({ sessionID, limit: 100 }),
        (page) =>
          page.data.some(
            (message) => message.type === "assistant" && Boolean(message.time.completed),
          ),
      );
      await observe(
        () => client.session.active(),
        (active) => !Object.hasOwn(active, sessionID),
      );
      const history = await client.message.list({ sessionID, limit: 100 });
      const oldReceipt = await client.session.prompt({
        sessionID,
        id: input.promptID,
        text: input.text,
        delivery: "queue",
        resume: false,
      });
      expect(oldReceipt.id).toBe(input.promptID);
      const logs = await Array.fromAsync(client.session.log({ sessionID, follow: false }));
      expect(logs.some((event) => event.type === "session.step.ended")).toBe(true);
      await Bun.write(resolve(project, "manual.txt"), "Retained developer edits\n");
      await control("/kill");
      upgraded = await pinnedOpenCode(
        candidateImage,
        undefined,
        undefined,
        undefined,
        project,
        "2.0.27",
      );
      expect(await upgraded.client.message.list({ sessionID, limit: 100 })).toEqual(history);
      const retainedLogs = await Array.fromAsync(
        upgraded.client.session.log({ sessionID, follow: false }),
      );
      // Native stream errors must not be mistaken for an empty usage journal.
      const failure = retainedLogs.find((event) => Array.isArray(event));
      if (failure)
        throw new Error(
          `Candidate cannot replay retained native events: ${JSON.stringify(failure)}`,
        );
      expect(retainedLogs).toEqual(
        logs.map((event) =>
          event.type === "session.step.started"
            ? { ...event, data: { ...event.data, started: event.created } }
            : event,
        ),
      );
      const backups = await Array.fromAsync(
        new Bun.Glob(".git/factory-opencode.db.before-2.0.27-*.sqlite").scan(project),
      );
      expect(backups).toHaveLength(1);
      const queued = await upgraded.client.session.inbox.list({ sessionID });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        id: input.promptID,
        sessionID,
        payload: { text: input.text },
      });
      expect((await upgraded.control()).providerRequests).toBe(0);
      await upgraded.control("/release", "POST");
      await upgraded.client.session.prompt({
        sessionID,
        id: input.promptID,
        text: input.text,
        delivery: "queue",
        resume: true,
      });
      const upgradedClient = upgraded.client;
      await observe(
        () => upgradedClient.message.list({ sessionID, limit: 100 }),
        (page) =>
          page.data.filter((message) => message.type === "assistant" && message.time.completed)
            .length >
          history.data.filter((message) => message.type === "assistant" && message.time.completed)
            .length,
      );
      await upgraded.client.session.prompt({
        sessionID,
        id: input.promptID,
        text: input.text,
        delivery: "queue",
        resume: false,
      });
      expect(await upgraded.client.session.inbox.list({ sessionID })).toHaveLength(0);
      expect((await upgraded.control()).providerRequests).toBe(1);
      expect(await Bun.file(resolve(project, "manual.txt")).text()).toBe(
        "Retained developer edits\n",
      );
    } finally {
      await upgraded?.dispose();
      await disposePrevious();
      await rm(scratch, { recursive: true, force: true });
    }
  },
  180_000,
);

test("native background shell cannot release a Change writer before it stops", async () => {
  const process = await pinnedOpenCode();
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await process.client.session.create({
      id: sessionID,
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(process.client, sessionID);
    const shell = await process.client.shell.create({
      location: { directory: "/workspace/project" },
      command: "sleep 60",
      timeout: 0,
      metadata: { sessionID },
    });
    expect((await process.client.session.active())[sessionID]).toBeUndefined();
    expect(await confirmSettledOpenCodeInput(process.client, sessionID, "msg_owned_unused")).toBe(
      false,
    );
    expect(await interruptOpenCodeSession(process.client, sessionID)).toBe("interrupted");
    expect(
      (
        await process.client.shell.list({ location: { directory: "/workspace/project" } })
      ).data.some((item) => item.id === shell.data.id),
    ).toBe(false);
    expect(await confirmSettledOpenCodeInput(process.client, sessionID, "msg_owned_unused")).toBe(
      true,
    );
  } finally {
    await process.dispose();
  }
}, 120_000);
