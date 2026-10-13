import { expect, test } from "bun:test";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

const ConnectorSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

test.each(["Build", "Staging"] as const)(
  "%s reconnects both Connector roles without replacing compute or replaying work",
  async (target) => {
    const process = await factoryProcess();
    const database = process.connect();
    const sockets: WebSocket[] = [];
    try {
      const token = crypto.randomUUID();
      const owned = await fixture(undefined, undefined, database, token);
      if (target === "Staging") {
        // Use an independent Staging attempt; the Ticket runtime remains untouched.
        await database.client`INSERT INTO factory.runtime_attempt(id, project_id, isolated_kind,
          generation, revision, state, kubernetes_namespace, kubernetes_pod_name,
          parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
          SELECT ${crypto.randomUUID()}, project_id, 'staging', generation, revision, 'ready',
            'owned-staging-not-created', 'never-created', parent_connector_token_hash,
            child_connector_token_hash, now(), created_by FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
        await database.client`INSERT INTO factory.staging_preview(project_id, revision, runtime_attempt_id)
          SELECT project_id, revision, id FROM factory.runtime_attempt
          WHERE project_id = ${owned.projectID} AND isolated_kind = 'staging'`;
      }
      const [attempt] = await database.client<{ id: string }[]>`
        SELECT id FROM factory.runtime_attempt WHERE project_id = ${owned.projectID}
          AND (${target} = 'Build' AND id = ${owned.attemptID} OR ${target} = 'Staging' AND isolated_kind = 'staging')`;
      if (!attempt) throw new Error("Owned reconnect attempt missing");
      const attemptID = attempt.id;
      await process.start();
      const cookie = await process.signIn();
      const headers = { cookie, origin: process.base, "content-type": "application/json" };
      let promptID: string | undefined;
      let promptCalls = 0;
      let mutationCalls = 0;
      let activeReads = 0;
      async function connect(role: "parent" | "child") {
        const socket = new ConnectorSocket(
          `${process.base.replace("http:", "ws:")}/internal/runtime-connect`,
          {
            protocols: [RuntimeHub.protocol()],
            headers: {
              authorization: `Bearer ${token}`,
              "x-factory-connector-role": role,
              "x-factory-runtime-attempt": attemptID,
              "x-factory-runtime-generation": "1",
            },
          },
        );
        sockets.push(socket);
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as {
            type: string;
            path: string;
            method: string;
            data: string;
            streamId: string;
          };
          if (frame.type === "operation-request") {
            mutationCalls += 1;
            return;
          }
          if (frame.type !== "http-request") return;
          const path = new URL(frame.path, "http://owned.invalid").pathname;
          if (frame.method !== "GET" && frame.method !== "HEAD") mutationCalls += 1;
          let data: unknown = [];
          if (path === "/api/model") data = [{ providerID: "factory", id: buildModelID }];
          else if (path.endsWith(`/${owned.sessionID}`))
            data = {
              id: owned.sessionID,
              location: { directory: "/workspace/project" },
              model: { providerID: "factory", id: buildModelID },
            };
          else if (path.endsWith("/active")) {
            activeReads += 1;
            data = promptID ? { [owned.sessionID]: {} } : {};
          } else if (path.endsWith("/prompt")) {
            promptCalls += 1;
            promptID = (JSON.parse(Buffer.from(frame.data, "base64").toString()) as { id: string })
              .id;
            data = { id: promptID };
          } else if (path.endsWith("/message"))
            data = promptID
              ? [{ id: promptID, type: "user", time: { created: 1 }, text: "Owned reconnect" }]
              : [
                  {
                    id: "msg_owned_boundary",
                    type: "agent-selected",
                    agent: "build",
                    time: { created: 0 },
                  },
                ];
          socket.send(
            JSON.stringify({
              type: "http-response",
              streamId: frame.streamId,
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "stream-data",
              streamId: frame.streamId,
              data: Buffer.from(JSON.stringify({ data })).toString("base64"),
            }),
          );
          socket.send(JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
        });
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("Owned Connector failed")), {
            once: true,
          });
        });
        socket.send(JSON.stringify({ type: "hello", role, channels: [] }));
        return socket;
      }
      const state = async () => {
        const [row] = await database.client<{ state: string; failure: string | null }[]>`
          SELECT state, failure FROM factory.runtime_attempt WHERE id = ${attempt.id}`;
        return row;
      };
      const identity = async () => database.client`
        SELECT id, generation, revision, workspace_id, kubernetes_namespace, kubernetes_pod_name,
          parent_connector_token_hash, child_connector_token_hash
        FROM factory.runtime_attempt WHERE project_id = ${owned.projectID} ORDER BY id`;
      const before = await identity();
      let parent = await connect("parent");
      let child = await connect("child");
      await eventually(state, (row) => row?.state === "ready", "Initial readiness missing");
      const commandID = crypto.randomUUID();
      if (target === "Build") {
        const response = await fetch(`${process.base}/api/changes/${owned.changeID}/agent/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ commandId: commandID, text: "Owned reconnect" }),
        });
        expect(response.status).toBe(202);
        await eventually(
          () => owned.turn(commandID),
          (turn) => turn?.state === "running",
          "Build dispatch missing",
        );
        expect(promptCalls).toBe(1);
      }
      const turn = target === "Build" ? await owned.turn(commandID) : undefined;
      const beforeMutations = mutationCalls;
      const beforeReads = activeReads;
      parent.close();
      child.close();
      await eventually(
        state,
        (row) =>
          row?.state === "starting" && Boolean(row.failure?.endsWith("connector reconnecting")),
        "Reconnect grace missing",
      );
      if (target === "Build") {
        const response = await fetch(`${process.base}/api/changes/${owned.changeID}/agent`, {
          headers,
        });
        expect(await response.json()).toMatchObject({
          state: "working",
          sessionAvailable: true,
          runtimeConnected: false,
          turn: { id: turn?.id, state: "running" },
        });
      }
      parent = await connect("parent");
      child = await connect("child");
      await eventually(
        state,
        (row) => row?.state === "ready" && row.failure === null,
        "Same attempt did not reconnect",
      );
      expect(await identity()).toEqual(before);
      if (target === "Build") {
        await eventually(
          async () => activeReads,
          (reads) => reads > beforeReads,
          "Same Build observer did not resume after reconnect",
        );
        const response = await fetch(`${process.base}/api/changes/${owned.changeID}/agent`, {
          headers,
        });
        expect(await response.json()).toMatchObject({
          state: "working",
          runtimeConnected: true,
          turn: { id: turn?.id, state: "running" },
        });
        expect(await owned.turn(commandID)).toEqual(turn);
      } else {
        const [preview] = await database.client<
          { id: string }[]
        >`SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id = ${owned.projectID}`;
        expect(preview?.id).toBe(attempt.id);
      }
      expect(promptCalls).toBe(target === "Build" ? 1 : 0);
      expect(mutationCalls).toBe(beforeMutations);
    } finally {
      await process.shutdown();
      for (const socket of sockets) socket.close();
      await database.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  30_000,
);
