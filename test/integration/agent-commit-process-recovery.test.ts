import { expect, test } from "bun:test";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { controlledForgeProtection } from "../fixtures/forge-protection";
import { nativeBuildProcessFixture } from "../fixtures/native-build-process";
import { nativeProcessProtocol } from "../fixtures/native-process-protocol";
import { callFactoryFunction } from "../fixtures/server-functions";

test.each(["restore", "mode revoked", "Session replaced"] as const)(
  "actual Factory commit recovery under %s waits for Connector readiness without paid replay",
  async (boundary) => {
    const forge = controlledForgeProtection();
    const process = await factoryProcess(undefined, {
      FACTORY_FORGEJO_ADMIN_TOKEN: forge.FACTORY_FORGEJO_ADMIN_TOKEN,
      FACTORY_FORGEJO_API_URL: forge.FACTORY_FORGEJO_API_URL,
      FACTORY_FORGEJO_PUBLIC_URL: "https://owned-build.factory.invalid",
    });
    const database = process.connect();
    let native: Awaited<ReturnType<typeof nativeProcessProtocol>> | undefined;
    let ownedFixture: Awaited<ReturnType<typeof nativeBuildProcessFixture>> | undefined;
    try {
      native = await nativeProcessProtocol(process, database);
      const peer = native;
      const initialized = await process.start();
      await process.kill(initialized);
      const owned = await nativeBuildProcessFixture(database, peer);
      ownedFixture = owned;
      const lifecycleBefore = peer.calls.filter((call) => !call.method.startsWith("Get"));
      const sockets: WebSocket[] = [];
      const frames: Array<{ operationId: string; action: string }> = [];
      const childRequests: Array<{ method: string; path: string }> = [];
      const pushEntered = Promise.withResolvers<void>();
      const releasePush = Promise.withResolvers<void>();
      try {
        // Real admission/controller creates the retained intent. Git/compute are controlled here.
        const install = owned.hub.parentOperation.bind(owned.hub);
        owned.hub.parentOperation = async (...args) => {
          if (args[1].action === "skills-install") return install(...args);
          throw new Error("Owned pending commit fixture");
        };
        const controller = owned.controller();
        const [conversation] = await database.client<{ id: string }[]>`
          SELECT id FROM factory.ticket_conversation WHERE ticket_id=${owned.ticketID}`;
        if (!conversation) throw Error("Controlled native Coding conversation missing");
        const conversationID = conversation.id;
        const commandID = crypto.randomUUID();
        await controller.prompt(owned.changeID, "Owned process recovery", owned.userID, commandID);
        await owned.requested;
        owned.finish();
        owned.release();
        await eventually(
          async () => {
            const rows = await owned.database.client<{ id: string; error: string | null }[]>`
        SELECT id, last_error AS error FROM factory.change_commit_operation
          WHERE change_id=${owned.changeID} AND id=(SELECT id FROM factory.agent_turn WHERE command_id=${commandID})`;
            return rows[0];
          },
          (row) => row?.error?.includes("not confirmed") === true,
          "Owned commit intent missing",
        );
        await controller.shutdown();
        const first = await process.start();
        await process.kill(first);
        if (boundary === "mode revoked")
          await owned.database
            .client`UPDATE factory.ticket_conversation SET mode = 'plan', version = version + 1
          WHERE id = ${conversationID}`;
        if (boundary === "Session replaced")
          await owned.database
            .client`UPDATE factory.change_agent_session SET opencode_session_id = 'ses_owned_replacement',
          last_error = 'Retain replacement Session' WHERE change_id = ${owned.changeID}`;
        const recovered = await process.start();
        expect(recovered.pid).not.toBe(first.pid);
        const cookie = await process.signIn();
        const headers = { cookie, origin: process.base, "content-type": "application/json" };
        async function connect(role: "parent" | "child") {
          return peer.connect(owned.attemptID, role, (socket) => {
            sockets.push(socket);
            socket.addEventListener("message", async (event) => {
              const frame = JSON.parse(String(event.data)) as {
                type: string;
                operationId: string;
                action: string;
                method: string;
                path: string;
                streamId: string;
                channel: string;
              };
              if (frame.channel === "source") {
                await peer.sourceFence(socket, frame);
                return;
              }
              if (role === "child" && frame.type === "http-request") {
                childRequests.push({ method: frame.method, path: frame.path });
                socket.send(
                  JSON.stringify({
                    type: "http-response",
                    streamId: frame.streamId,
                    status: 503,
                    headers: {},
                  }),
                );
                socket.send(JSON.stringify({ type: "stream-close", streamId: frame.streamId }));
              }
              if (frame.type !== "operation-request") return;
              frames.push({ operationId: frame.operationId, action: frame.action });
              const acknowledge = () =>
                socket.send(
                  JSON.stringify({
                    type: "operation-response",
                    operationId: frame.operationId,
                    action: frame.action,
                    commitSha: "d".repeat(40),
                    remoteSha: "d".repeat(40),
                  }),
                );
              if (frame.action === "git-push") {
                pushEntered.resolve();
                void releasePush.promise.then(acknowledge);
              } else acknowledge();
            });
          });
        }
        await connect("parent");
        const child = await connect("child");
        await eventually(
          async () => {
            const rows = await owned.database.client<
              { state: string }[]
            >`SELECT state FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
            return rows[0]?.state;
          },
          (state) => state === "ready",
          "Owned runtime did not become ready",
        );
        if (boundary !== "restore") {
          await eventually(
            async () => {
              const rows = await owned.database.client<{ error: string | null }[]>`
            SELECT last_error AS error FROM factory.change_commit_operation
              WHERE change_id=${owned.changeID} AND id=(SELECT id FROM factory.agent_turn WHERE command_id=${commandID})`;
              return rows[0]?.error;
            },
            (error) => error?.includes("The work changed while this was running") === true,
            "Revoked recovery was not observed",
          );
          expect(frames).toEqual([]);
          const response = await callFactoryFunction(
            process.base,
            "getAgentView",
            [owned.changeID],
            headers,
          );
          expect(response).toMatchObject({ ok: true });
          const view = (await serverCall(Promise.resolve(response))) as {
            state: string;
            lastError: string;
            commitOperation?: { id: string };
          };
          expect(view.state).toBe("waiting");
          expect(view.commitOperation?.id).toBe((await owned.turn(commandID))?.id);
          if (boundary === "Session replaced")
            expect(view.lastError).toBe("Retain replacement Session");
        } else {
          await eventually(
            async () => frames.some(({ action }) => action === "git-push"),
            (entered) => entered,
            "Owned push was not reached",
          );
          await pushEntered.promise;
          // Duplicate ready observations while the acknowledgement is outstanding must join it.
          for (let count = 0; count < 3; count += 1)
            child.send(JSON.stringify({ type: "status", phase: "ready" }));
          releasePush.resolve();
          await eventually(
            async () => {
              const response = await callFactoryFunction(
                process.base,
                "getAgentView",
                [owned.changeID],
                headers,
              );
              expect(response).toMatchObject({ ok: true });
              return serverCall(Promise.resolve(response)) as Promise<{
                state: string;
                commitOperation?: { id: string };
              }>;
            },
            (view) => view.state === "committed" && !view.commitOperation,
            "Factory left the commit pending after Connector readiness",
            3_000,
          );
          expect(frames.map(({ action }) => action)).toEqual(["git-observe-commit", "git-push"]);
          expect(new Set(frames.map(({ operationId }) => operationId)).size).toBe(1);
        }
        // One controlled prior input, then this case's exact retained input.
        expect(owned.requests()).toBe(2);
        expect(childRequests.every(({ method }) => method === "GET" || method === "HEAD")).toBe(
          true,
        );
        expect((await owned.turn(commandID))?.state).toBe("completed");
        expect(peer.calls.filter((call) => !call.method.startsWith("Get"))).toEqual(
          lifecycleBefore,
        );
      } finally {
        releasePush.resolve();
        for (const socket of sockets) socket.close();
        await process.shutdown();
      }
    } finally {
      await process.shutdown();
      await ownedFixture?.shutdown();
      ownedFixture?.restoreEnvironment();
      await native?.close();
      await database.client.end({ timeout: 1 });
      await process.dispose();
      await forge.dispose();
    }
  },
  120_000,
);
