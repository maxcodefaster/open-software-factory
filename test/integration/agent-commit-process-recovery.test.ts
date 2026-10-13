import { expect, test } from "bun:test";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

// lib.dom narrows the global constructor, but Bun supports authenticated client options.
const ConnectorSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

test.each(["restore", "mode revoked", "Session replaced"] as const)(
  "actual Factory commit recovery under %s waits for Connector readiness without paid replay",
  async (boundary) => {
    const process = await factoryProcess();
    try {
      const initialized = await process.start();
      await process.kill(initialized);
      const token = crypto.randomUUID();
      const owned = await fixture(undefined, undefined, process.connect(), token);
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
        const conversationID = crypto.randomUUID();
        await owned.database
          .client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
        VALUES (${conversationID}, ${owned.projectID}, ${owned.ticketID}, 'build', ${owned.userID})`;
        const commandID = crypto.randomUUID();
        await controller.prompt(owned.changeID, "Owned process recovery", owned.userID, commandID);
        await owned.requested;
        owned.finish();
        owned.release();
        await eventually(
          async () => {
            const rows = await owned.database.client<{ id: string; error: string | null }[]>`
        SELECT id, last_error AS error FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
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
          const socket = new ConnectorSocket(
            `${process.base.replace("http:", "ws:")}/internal/runtime-connect`,
            {
              protocols: [RuntimeHub.protocol()],
              headers: {
                authorization: `Bearer ${token}`,
                "x-factory-connector-role": role,
                "x-factory-runtime-attempt": owned.attemptID,
                "x-factory-runtime-generation": "1",
              },
            },
          );
          sockets.push(socket);
          socket.addEventListener("message", (event) => {
            const frame = JSON.parse(String(event.data)) as {
              type: string;
              operationId: string;
              action: string;
              method: string;
              path: string;
              streamId: string;
            };
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
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
              "error",
              () => reject(new Error("Owned Connector did not connect")),
              { once: true },
            );
          });
          socket.send(JSON.stringify({ type: "hello", role, channels: [] }));
          return socket;
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
            SELECT last_error AS error FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
              return rows[0]?.error;
            },
            (error) => error?.includes("authority changed") === true,
            "Revoked recovery was not observed",
          );
          expect(frames).toEqual([]);
          const response = await fetch(`${process.base}/api/changes/${owned.changeID}/agent`, {
            headers,
          });
          expect(response.status).toBe(200);
          const view = (await response.json()) as {
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
              const response = await fetch(`${process.base}/api/changes/${owned.changeID}/agent`, {
                headers,
              });
              expect(response.status).toBe(200);
              return response.json() as Promise<{
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
        expect(owned.requests()).toBe(1);
        expect(childRequests.every(({ method }) => method === "GET" || method === "HEAD")).toBe(
          true,
        );
        expect((await owned.turn(commandID))?.state).toBe("completed");
      } finally {
        releasePush.resolve();
        for (const socket of sockets) socket.close();
        await process.shutdown();
        await owned.dispose();
      }
    } finally {
      await process.dispose();
    }
  },
  30_000,
);
