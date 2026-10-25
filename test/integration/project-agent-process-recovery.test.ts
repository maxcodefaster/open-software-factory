import { callFactoryFunction, conversationCommand } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { expect, test } from "bun:test";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { createDatabase } from "../../packages/db/src/client";
import { factoryProcessCommand } from "../fixtures/factory-process";

const postgresImage =
  "docker.io/library/postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
const runtimeImage =
  "registry.localhost:5443/open-factory/runtime-host@sha256:f1197f0228478aa4d3876b8adfd5961776775f79d37d49839cf411c0e28e997a";

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Owned process database ${args[0]} failed: ${error}`);
  return output.trim();
}

async function removeOwnedDatabase(container: string, id: string) {
  const owner = await docker(
    "inspect",
    "--format",
    '{{index .Config.Labels "factory.owned-project-process"}}',
    container,
  );
  if (owner !== id) throw new Error("Owned process database cleanup refused");
  await docker("rm", "--force", container);
}

async function until<T>(observe: () => Promise<T>, accepts: (value: T) => boolean) {
  const deadline = Date.now() + 45_000;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await observe();
      if (accepts(value)) return value;
    } catch (error) {
      cause = error;
    }
    await Bun.sleep(50);
  }
  throw new Error("Owned Factory-process recovery timed out", { cause });
}

async function diagnosticTail(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of stream)
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4000);
  return (tail + decoder.decode()).slice(-4000);
}

test("actual Factory startup recovers Project input and never replays dispatched inference after SIGKILL", async () => {
  const id = crypto.randomUUID();
  const container = `factory-owned-project-process-${id}`;
  let created = false;
  let database: ReturnType<typeof createDatabase> | undefined;
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const requests: string[] = [];
  const release = Promise.withResolvers<void>();
  let holdNext = false;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Not found", { status: 404 });
      }
      const body = (await request.json()) as { model: string; stream?: boolean };
      requests.push(body.model);
      if (holdNext) {
        holdNext = false;
        await release.promise;
      }
      const content = JSON.stringify({
        output: { kind: "answer", message: "Owned Factory-process response", citations: [] },
      });
      const common = { id: "chatcmpl_owned_process", created: 1, model: body.model };
      if (!body.stream) {
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        });
      }
      return new Response(
        `data: ${JSON.stringify({
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        })}\n\ndata: ${JSON.stringify({
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  try {
    await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `factory.owned-project-process=${id}`,
      "--env",
      "POSTGRES_USER=factory",
      "--env",
      "POSTGRES_PASSWORD=owned-process-not-a-secret",
      "--env",
      "POSTGRES_DB=factory",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
      "postgres",
      "-c",
      "wal_level=logical",
    );
    created = true;
    const databasePort = (await docker("port", container, "5432/tcp")).split(":").at(-1);
    if (!databasePort || !/^\d+$/.test(databasePort))
      throw new Error("Owned database port missing");
    const databaseURL = `postgresql://factory:owned-process-not-a-secret@127.0.0.1:${databasePort}/factory`;
    const migration = Bun.spawn(factoryProcessCommand("packages/db/src/migrate.ts"), {
      env: { ...process.env, DATABASE_URL: databaseURL },
      stdout: "pipe",
      stderr: "pipe",
    });
    const migrationOutput = new Response(migration.stdout).text();
    const migrationError = new Response(migration.stderr).text();
    expect(await migration.exited).toBe(0);
    await Promise.all([migrationOutput, migrationError]);

    const previousURL = process.env["DATABASE_URL"];
    try {
      process.env["DATABASE_URL"] = databaseURL;
      database = createDatabase();
    } finally {
      if (previousURL === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previousURL;
    }
    const ownedDatabase = database;
    // Reserve a loopback port, then release it for the real Factory listener.
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    await reservation.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const environment = {
      ...process.env,
      DATABASE_URL: databaseURL,
      FACTORY_HOST: "127.0.0.1",
      FACTORY_PORT: String(port),
      FACTORY_BASE_URL: base,
      FACTORY_ADMIN_EMAIL: `owned-${id}@factory.local`,
      FACTORY_ADMIN_PASSWORD: "owned-process-password-not-a-secret",
      FACTORY_AUTH_SECRET: "owned-process-auth-secret-not-a-production-credential",
      FACTORY_FORGEJO_API_URL: "http://127.0.0.1:9/api/v1",
      FACTORY_FORGEJO_TOKEN: "owned-unused-forge-token",
      FACTORY_FORGEJO_OWNER: "owned-process-fixture",
      FACTORY_RUNTIME_HOST_IMAGE: runtimeImage,
      FACTORY_BUILD_RUNTIME_HOST_IMAGE: `registry.example.invalid/owned-build@sha256:${"b".repeat(64)}`,
      FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE: `registry.example.invalid/owned-verification@sha256:${"c".repeat(64)}`,
      FACTORY_EXECUTION_RESERVE_TARGET: "0",
      FACTORY_PLANNING_MODEL_BASE_URL: "",
      FACTORY_PLANNING_MODEL_API_KEY: "",
      FACTORY_ZERO_CACHE_URL: "",
      FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
      FACTORY_MODEL_API_KEY: "owned-process-model-not-a-secret",
      FACTORY_PROJECT_AGENT_MODEL: "changed-process-default",
    };
    async function start() {
      const child = Bun.spawn(factoryProcessCommand("apps/factory/src/server.ts"), {
        env: environment,
        stdout: "ignore",
        stderr: "pipe",
      });
      processes.push(child);
      // Bound stderr while live; redact credentials before reporting an early exit.
      const diagnostics = diagnosticTail(child.stderr);
      await until(
        async () => {
          if (child.exitCode !== null) {
            let output = await diagnostics;
            for (const [key, value] of Object.entries(environment)) {
              if (value && /KEY|TOKEN|PASSWORD|SECRET|DATABASE_URL/.test(key)) {
                output = output.replaceAll(value, "<redacted>");
              }
            }
            throw new Error(`Owned Factory exited: ${child.exitCode}\n${output.slice(-4000)}`);
          }
          return fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1_000) });
        },
        (response) => response.ok,
      );
      return child;
    }
    async function kill(child: ReturnType<typeof Bun.spawn>) {
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
    }
    const initial = await start();
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        email: environment.FACTORY_ADMIN_EMAIL,
        password: environment.FACTORY_ADMIN_PASSWORD,
      }),
    });
    expect(signIn.status).toBe(200);
    const signedIn = (await signIn.json()) as { user: { id: string } };
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie.length).toBeGreaterThan(0);
    const projectID = crypto.randomUUID();
    await ownedDatabase.client`INSERT INTO factory.project (
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (${projectID}, ${`owned-${id}`}, 'Owned process Project',
      'https://example.invalid/owned-process.git', 'main', '.devcontainer/devcontainer.json', ${signedIn.user.id})`;
    const controller = createProjectAgentController(ownedDatabase, { start: async () => null });
    const conversation = await controller.setMode(
      projectID,
      undefined,
      "investigate",
      signedIn.user.id,
    );
    if (!conversation) throw new Error("Owned process Conversation missing");
    await kill(initial);
    // Seed the admitted-before-dispatch crash window through the real atomic store.
    // This is retained-intent fixture setup, not a claim of a crash inside an HTTP admission.
    const store = createAgentTurnStore(ownedDatabase);
    const command = {
      kind: "project-message" as const,
      commandId: crypto.randomUUID(),
      projectId: projectID,
      ticketId: null,
      conversationId: conversation.id,
      createdBy: signedIn.user.id,
      text: "Recover this saved process input",
    };
    const admitted = await store.admit(
      command,
      {
        mode: "investigate",
        conversationVersion: conversation.version,
        modelId: "admitted-process-model",
      },
      async (sql, turn) => {
        await appendConversationEntry(sql, conversation.id, {
          kind: "user-message",
          actor: "user",
          mode: "investigate",
          body: command.text,
          payload: { commandId: command.commandId, turnId: turn.id },
          citations: [],
          inReplyToEntryId: null,
          requirementRevisionId: null,
          createdBy: signedIn.user.id,
        });
      },
    );
    const recovered = await start();
    expect(recovered.pid).not.toBe(initial.pid);
    await until(
      () => store.get(admitted.turn.id),
      (turn) => turn?.state === "completed",
    );
    expect(requests).toEqual(["admitted-process-model"]);
    const headers = { "content-type": "application/json", origin: base, cookie };
    const replay = await conversationCommand(
      base,
      projectID,
      {
        commandId: command.commandId,
        text: command.text,
      },
      headers,
    );
    expect(replay.id).toBe(conversation.id);
    expect(requests).toHaveLength(1);

    // The real compiled native message stream dispatches before actual SIGKILL.
    holdNext = true;
    const lostCommand = crypto.randomUUID();
    const lostResponse = conversationCommand(
      base,
      projectID,
      {
        commandId: lostCommand,
        text: "Held process input",
      },
      headers,
      AbortSignal.timeout(45_000),
    ).then(
      () => "returned",
      () => "lost",
    );
    await until(
      async () => requests.length,
      (count) => count === 2,
    );
    const dispatched = await store.getByCommand(lostCommand);
    expect(dispatched?.state).toBe("dispatching");
    if (!dispatched) throw new Error("Owned dispatched Turn missing");
    const expiry = new Date(dispatched.ownerExpiresAt ?? 0).getTime();
    await kill(recovered);
    expect(await lostResponse).toBe("lost");
    const restarted = await start();
    expect(restarted.pid).not.toBe(recovered.pid);
    expect(requests).toHaveLength(2);
    // Wait for the real persisted lease, not a fixture-written SQL expiry.
    await until(
      () => store.get(dispatched.id),
      (turn) => turn?.state === "uncertain",
    );
    expect(Date.now()).toBeGreaterThanOrEqual(expiry);
    release.resolve();
    expect(requests).toHaveLength(2);
    const historyResponse = await callFactoryFunction(
      base,
      "getConversation",
      [projectID],
      headers,
    );
    expect(historyResponse).toMatchObject({ ok: true });
    const history = (await serverCall(Promise.resolve(historyResponse))) as {
      entries: Array<{ kind: string; body: string }>;
    };
    expect(history.entries.filter((entry) => entry.kind === "user-message")).toHaveLength(2);
    expect(history.entries.filter((entry) => entry.kind === "agent-message")).toHaveLength(1);
    const retry = await conversationCommand(
      base,
      projectID,
      {
        commandId: crypto.randomUUID(),
        text: "Explicit process retry",
      },
      headers,
    );
    expect(retry.id).toBe(conversation.id);
    expect(requests).toEqual([
      "admitted-process-model",
      "changed-process-default",
      "changed-process-default",
    ]);
    expect((await store.get(dispatched.id))?.state).toBe("uncertain");
    console.log("Owned real Factory Project recovery passed", {
      generations: processes.length,
      providerRequests: requests.length,
      naturalLeaseExpiry: true,
      postgresImage,
      fullRuntime: false,
      genuineInference: false,
    });
  } finally {
    release.resolve();
    for (const child of processes) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    await model.stop(true);
    await database?.client.end();
    if (created) await removeOwnedDatabase(container, id);
  }
}, 90_000);
