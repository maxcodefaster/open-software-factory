import { expect, test } from "bun:test";
import { streamConversation } from "../../apps/factory/src/conversation-stream";
import { eventually, factoryProcess } from "../fixtures/factory-process";

// Real authenticated HTTP, native Mastra streaming and an owned PostgreSQL database.
test.each(["complete", "disconnect", "invalid", "revoked"] as const)(
  "Project answer stream: %s",
  async (outcome) => {
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const body = (await request.json()) as { stream: boolean };
        expect(body.stream).toBe(true);
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              const emit = (content: string, finished = false) =>
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: "owned-stream",
                      object: "chat.completion.chunk",
                      created: 1,
                      model: "owned-stream",
                      choices: [
                        {
                          index: 0,
                          delta: finished ? {} : { role: "assistant", content },
                          finish_reason: finished ? "stop" : null,
                        },
                      ],
                      ...(finished
                        ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
                        : {}),
                    })}\n\n`,
                  ),
                );
              emit('{"output":{"kind":"answer","message":"**Hello**');
              await release.promise;
              emit(
                outcome === "invalid"
                  ? ' world[^1]","citations":[{"source":"knowledge","id":"00000000-0000-4000-8000-000000000000","label":"Unread source","reference":1}]}}'
                  : ' world","citations":[]}}',
              );
              emit("", true);
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const isolated = await factoryProcess(undefined, {
      FACTORY_PROJECT_AGENT_MODEL: "owned-stream",
      FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    });
    const database = isolated.connect();
    const projectID = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const firstText = Promise.withResolvers<string>();
    const abort = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await isolated.start();
      const cookie = await isolated.signIn();
      const session = (await fetch(`${isolated.base}/api/session`, { headers: { cookie } }).then(
        (response) => response.json(),
      )) as { session: { user: { id: string } } };
      const userID = session.session.user.id;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES (${projectID},${`stream-${projectID.slice(0, 8)}`},'Owned Streaming','https://example.invalid/stream.git','main','.devcontainer/devcontainer.json',${userID})`;
      pending = streamConversation(
        `${isolated.base}/api/projects/${projectID}/conversation/message`,
        {
          method: "POST",
          signal: abort.signal,
          headers: { cookie, origin: isolated.base, "content-type": "application/json" },
          body: JSON.stringify({ text: "Say hello", commandId }),
        },
        (event) => {
          if (event.type === "answer") firstText.resolve(event.text);
        },
      );
      void pending.catch(() => {});
      expect(
        await Promise.race([
          firstText.promise,
          Bun.sleep(5000).then(() => {
            throw new Error("No live answer before completion");
          }),
        ]),
      ).toBe("**Hello**");
      const before =
        await database.client`SELECT kind FROM factory.conversation_entry entry JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id WHERE conversation.project_id=${projectID}`;
      expect(before.map((entry) => entry["kind"])).toEqual(["user-message"]);
      if (outcome === "disconnect") abort.abort();
      if (outcome === "revoked")
        await database.client`DELETE FROM factory.administrator WHERE user_id=${userID}`;
      release.resolve();
      if (outcome === "complete")
        expect(await pending).toMatchObject({
          entries: [{ kind: "user-message" }, { kind: "agent-message", body: "**Hello** world" }],
        });
      else await expect(pending).rejects.toThrow();
      const state = await eventually(
        async () => {
          const [row] =
            await database.client`SELECT state FROM factory.agent_turn WHERE command_id=${commandId}`;
          return row?.["state"];
        },
        (value) => value === "completed" || value === "failed",
        "Owned streaming turn did not settle",
      );
      expect(state).toBe(outcome === "invalid" || outcome === "revoked" ? "failed" : "completed");
      const after =
        await database.client`SELECT kind FROM factory.conversation_entry entry JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id WHERE conversation.project_id=${projectID} ORDER BY ordinal`;
      expect(after.map((entry) => entry["kind"])).toEqual(
        state === "completed" ? ["user-message", "agent-message"] : ["user-message"],
      );
      expect(requests).toBe(1);
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      await database.client.end();
      await isolated.dispose();
      await provider.stop(true);
    }
  },
  30_000,
);
