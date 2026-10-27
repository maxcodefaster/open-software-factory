import { callFactoryFunction, conversationCommand } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { expect, test } from "bun:test";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import type { createDatabase } from "../../packages/db/src/client";
import { factoryProcess } from "../fixtures/factory-process";

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

test("actual Factory startup recovers Project input and never replays dispatched inference after SIGKILL", async () => {
  let isolated: Awaited<ReturnType<typeof factoryProcess>> | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  let controller: ReturnType<typeof createProjectAgentController> | undefined;
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
    isolated = await factoryProcess(undefined, {
      FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
      FACTORY_MODEL_API_KEY: "owned-process-model-not-a-secret",
      FACTORY_PROJECT_AGENT_MODEL: "changed-process-default",
    });
    const owned = isolated;
    const { id, base, processes } = owned;
    database = owned.connect();
    const ownedDatabase = database;
    const start = () => owned.start();
    async function kill(child: ReturnType<typeof Bun.spawn>) {
      await owned.kill(child);
      expect(child.signalCode).toBe("SIGKILL");
    }
    const initial = await start();
    const cookie = await owned.signIn();
    const [actor] = await database.client<{ id: string }[]>`
      SELECT id FROM auth."user" WHERE email=${`owned-${id}@factory.local`}`;
    if (!actor) throw new Error("Owned process actor missing");
    expect(cookie.length).toBeGreaterThan(0);
    const projectID = crypto.randomUUID();
    await ownedDatabase.client`INSERT INTO factory.project (
      id, slug, name, repository_url, default_branch, devcontainer_path, created_by
    ) VALUES (${projectID}, ${`owned-${id}`}, 'Owned process Project',
      'https://example.invalid/owned-process.git', 'main', '.devcontainer/devcontainer.json', ${actor.id})`;
    controller = createProjectAgentController(ownedDatabase, { start: async () => null });
    const conversation = await controller.setMode(projectID, undefined, "investigate", actor.id);
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
      createdBy: actor.id,
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
          createdBy: actor.id,
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
      fullRuntime: false,
      genuineInference: false,
    });
  } finally {
    release.resolve();
    await controller?.shutdown();
    await isolated?.shutdown();
    await model.stop(true);
    await database?.client.end();
    await isolated?.dispose();
  }
}, 90_000);
