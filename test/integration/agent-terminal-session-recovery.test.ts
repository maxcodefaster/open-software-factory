import { callFactoryFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

const ConnectorSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

test.each(["failed", "pre-dispatch failed"] as const)(
  "Factory SIGKILL after %s Turn settlement recovers its exact Session without execution replay",
  async (outcome) => {
    const protections = new Map<string, unknown>();
    const forge = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (!path.includes("/branch_protections")) return new Response(null, { status: 404 });
        if (request.method === "POST" || request.method === "PATCH") {
          const rule = (await request.json()) as { rule_name: string };
          const key = `${path.split("/branch_protections")[0]}/branch_protections/${encodeURIComponent(rule.rule_name)}`;
          protections.set(key, rule);
          return Response.json(rule);
        }
        return protections.has(path)
          ? Response.json(protections.get(path))
          : new Response(null, { status: 404 });
      },
    });
    const process = await factoryProcess(undefined, {
      FACTORY_FORGEJO_ADMIN_TOKEN: "owned-forge-control-not-a-secret",
      FACTORY_FORGEJO_API_URL: `http://127.0.0.1:${forge.port}/api/v1/`,
    });
    const database = process.connect();
    const sockets: WebSocket[] = [];
    const latch = await database.client.reserve();
    let creating: ReturnType<typeof callFactoryFunction<"sendCodingPrompt">> | undefined;
    let latchHeld = false;
    try {
      const token = crypto.randomUUID();
      const owned = await fixture(undefined, undefined, database, token);
      const first = await process.start();
      const cookie = await process.signIn();
      const headers = { cookie, origin: process.base, "content-type": "application/json" };
      let promptID: string | undefined;
      let promptText = "";
      let installedSkills: string[] = [];
      const instructions = new Map<string, unknown>();
      const mcpServers = new Set<string>();
      let promptCalls = 0;
      let externalMutations = 0;
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
            streamId: string;
            path: string;
            method: string;
            data: string;
          };
          if (frame.type === "operation-request") {
            externalMutations += 1;
            if (frame.action === "skills-install") {
              const manifest = JSON.parse(frame.data) as { files: { path: string }[] };
              installedSkills = [
                ...new Set(
                  manifest.files.map((file) =>
                    fixtureValue(file.path.split("/")[0], 'file.path.split("/")[0]'),
                  ),
                ),
              ];
              socket.send(
                JSON.stringify({
                  type: "operation-response",
                  operationId: frame.operationId,
                  action: frame.action,
                }),
              );
            }
            return;
          }
          if (frame.type !== "http-request") return;
          const request = {
            path: new URL(frame.path, "http://owned.invalid").pathname,
            method: frame.method,
            body: Buffer.from(frame.data, "base64").toString(),
          };
          if (request.path.endsWith("/log")) {
            socket.send(
              JSON.stringify({
                type: "http-response",
                streamId: frame.streamId,
                status: 200,
                headers: { "content-type": "text/event-stream" },
              }),
            );
            socket.send(
              JSON.stringify({
                type: "stream-data",
                streamId: frame.streamId,
                data: Buffer.from(
                  `data: ${JSON.stringify({ type: "log.synced", aggregateID: owned.sessionID, seq: 1 })}\n\n`,
                ).toString("base64"),
              }),
            );
            socket.send(JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
            return;
          }
          let status = 200;
          let data: unknown = [];
          if (request.method !== "GET" && request.method !== "HEAD") externalMutations += 1;
          if (request.path.includes("/instructions/entries")) {
            if (request.method === "GET")
              data = [...instructions].map(([key, value]) => ({ key, value }));
            else {
              status = 204;
              const key = decodeURIComponent(
                fixtureValue(request.path.split("/").at(-1), 'request.path.split("/").at(-1)'),
              );
              if (request.method === "PUT")
                instructions.set(key, (JSON.parse(request.body) as { value: unknown }).value);
              else instructions.delete(key);
            }
          } else if (
            [
              "/api/experimental/mcp/factory_browser",
              "/api/experimental/mcp/factory_sources",
            ].includes(request.path) &&
            request.method === "PUT"
          ) {
            mcpServers.add(
              fixtureValue(request.path.split("/").at(-1), 'request.path.split("/").at(-1)'),
            );
            status = 204;
          } else if (request.path === "/api/mcp") {
            // OpenCode's native protocol remains unchanged by the UI migration.
            data = [...mcpServers].map((name) => ({ name, status: { status: "connected" } }));
          } else if (request.path === "/api/skill" && outcome === "pre-dispatch failed") {
            status = 503;
            data = { message: "Owned skill discovery failed before dispatch" };
          } else if (request.path === "/api/info") {
            data = { version: "2.0.27" };
          } else if (request.path === "/api/skill") {
            data = installedSkills.map((id) => ({
              id,
              name: id,
              path: `/opt/factory/admitted-skills/${id}/SKILL.md`,
              content: "",
            }));
          } else if (request.path === "/api/session") {
            data = [];
          } else if (request.path === "/api/model") {
            data = [{ providerID: "factory", id: buildModelID }];
          } else if (request.path.endsWith("/agent")) {
            status = 204;
          } else if (request.path.endsWith(`/${owned.sessionID}`)) {
            data = {
              id: owned.sessionID,
              location: { directory: "/workspace/project" },
              model: { providerID: "factory", id: buildModelID },
            };
          } else if (request.path.endsWith("/active")) {
            data = {};
          } else if (request.path.endsWith("/prompt")) {
            promptCalls += 1;
            const input = JSON.parse(request.body) as {
              id: string;
              text: string;
              skills?: { id: string }[];
              metadata?: Record<string, unknown>;
            };
            promptID = input.id;
            promptText = input.text;
            data = {
              id: input.id,
              sessionID: owned.sessionID,
              type: "user",
              time: { created: 1 },
              delivery: "queue",
              payload: {
                text: input.text,
                ...(input.skills ? { skills: input.skills } : {}),
                ...(input.metadata ? { metadata: input.metadata } : {}),
              },
            };
          } else if (request.path.endsWith("/message")) {
            data = promptID
              ? [
                  {
                    id: `${promptID}_assistant`,
                    type: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "error",
                    error: { message: "Owned completed model error" },
                    content: [],
                  },
                  {
                    id: promptID,
                    type: "user",
                    time: { created: 1 },
                    text: promptText,
                  },
                ]
              : [
                  {
                    id: "msg_owned_boundary",
                    type: "agent-selected",
                    agent: "build",
                    time: { created: 0 },
                  },
                ];
          }
          socket.send(
            JSON.stringify({
              type: "http-response",
              streamId: frame.streamId,
              status,
              headers: { "content-type": "application/json" },
            }),
          );
          if (status !== 204)
            socket.send(
              JSON.stringify({
                type: "stream-data",
                streamId: frame.streamId,
                data: Buffer.from(JSON.stringify({ data, cursor: {} })).toString("base64"),
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
      }
      await connect("parent");
      await connect("child");
      await eventually(
        async () => {
          const rows = await database.client<
            { state: string }[]
          >`SELECT state FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
          return rows[0]?.state;
        },
        (state) => state === "ready",
        "Owned runtime readiness missing",
      );
      // Block only the Session projection, not the Turn transaction. Kill the
      // actual server after its terminal Turn commits and before this write.
      await database.client`CREATE FUNCTION factory.owned_terminal_hold() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state = 'failed' AND OLD.state IN ('starting', 'working') THEN
            PERFORM pg_advisory_xact_lock(hashtext('owned-terminal-projection'));
          END IF;
          RETURN NEW;
        END
      $$`;
      await database.client`CREATE TRIGGER owned_terminal_hold BEFORE UPDATE ON factory.change_agent_session
        FOR EACH ROW EXECUTE FUNCTION factory.owned_terminal_hold()`;
      await latch`SELECT pg_advisory_lock(hashtext('owned-terminal-projection'))`;
      latchHeld = true;
      const commandID = crypto.randomUUID();
      creating = callFactoryFunction(
        process.base,
        "sendCodingPrompt",
        [owned.changeID, { commandId: commandID, text: "Owned terminal recovery" }],
        headers,
      );
      void creating.catch(() => undefined);
      expect(await creating).toMatchObject({ ok: true });
      const settled = await eventually(
        async () => owned.turn(commandID),
        (turn) => turn?.state === "failed" || turn?.state === "uncertain",
        "Terminal Turn was not persisted before the held Session update",
        30_000,
      );
      expect({ state: settled?.state, summary: settled?.summary }).toMatchObject({
        state: "failed",
      });
      const [failure] = await database.client<
        { summary: string }[]
      >`SELECT outcome_summary AS summary FROM factory.agent_turn WHERE id=${settled?.id ?? ""}`;
      expect(failure?.summary).toContain(
        outcome === "failed" ? "Owned completed model error" : "UnexpectedStatus: 503",
      );
      const prior = await database.client<{ state: string; turnID: string }[]>`
        SELECT state, active_turn_id AS "turnID" FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
      expect(prior[0]?.state).toBe(outcome === "failed" ? "working" : "starting");
      expect(prior[0]?.turnID).toBe(settled?.id);
      const blockedPID = await eventually(
        async () => {
          const rows = await database.client<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event = 'advisory' AND query LIKE '%UPDATE factory.change_agent_session%'
            AND pid <> pg_backend_pid()`;
          return rows[0]?.pid;
        },
        (pid) => pid !== undefined,
        "Exact Session projection did not reach its SQL hold",
      );
      await process.kill(first);
      // A backend waiting on a PostgreSQL lock need not notice its dead client
      // until the lock releases. Abort only that identified fixture connection
      // so it cannot finish the held write after the replacement server starts.
      await database.client`SELECT pg_terminate_backend(${blockedPID ?? -1})`;
      await creating.catch(() => undefined);
      await latch`SELECT pg_advisory_unlock(hashtext('owned-terminal-projection'))`;
      latchHeld = false;
      await database.client`DROP TRIGGER owned_terminal_hold ON factory.change_agent_session`;
      const beforeMutations = externalMutations;
      const recovered = await process.start();
      expect(recovered.pid).not.toBe(first.pid);
      await eventually(
        async () => {
          const rows = await database.client<
            { state: string; turnID: string; error: string | null }[]
          >`
          SELECT state, active_turn_id AS "turnID", last_error AS error
          FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
          return rows[0];
        },
        (session) => session?.state === "failed",
        "Factory left the terminal Turn's Session busy",
        2_000,
      );
      const response = await callFactoryFunction(
        process.base,
        "getAgentView",
        [owned.changeID],
        headers,
      );
      expect(response).toMatchObject({ ok: true });
      expect(await serverCall(Promise.resolve(response))).toMatchObject({
        state: "failed",
        turn: { id: settled?.id, state: "failed" },
        lastError: expect.any(String),
      });
      expect(externalMutations).toBe(beforeMutations);
      expect(promptCalls).toBe(outcome === "pre-dispatch failed" ? 0 : 1);
      expect((await owned.turn(commandID))?.state).toBe(settled?.state);
      const admitted = await createChangeAdmission(database, buildModelID).admit(
        owned.changeID,
        owned.userID,
        { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Explicit later turn" },
      );
      expect(admitted.turn.id).not.toBe(settled?.id);
      expect(admitted.turn.state).toBe("pending");
      const [writer] = await database.client<{ fence: boolean }[]>`
        SELECT fence_required AS fence FROM factory.change_writer WHERE change_id=${owned.changeID}`;
      expect(writer?.fence).toBe(true);
      expect(promptCalls).toBe(outcome === "pre-dispatch failed" ? 0 : 1);
    } finally {
      for (const socket of sockets) socket.close();
      await process.shutdown();
      await creating?.catch(() => undefined);
      if (latchHeld) await latch`SELECT pg_advisory_unlock(hashtext('owned-terminal-projection'))`;
      latch.release();
      await database.client.end({ timeout: 0 });
      await process.dispose();
      await forge.stop(true);
    }
  },
  120_000,
);

test.each([
  "Session replaced",
  "runtime unassigned",
  "Turn no longer owns Session",
  "input replaced",
  "stopped",
  "mode changed",
] as const)(
  "failed Session projection recovery preserves %s without external execution",
  async (boundary) => {
    const process = await factoryProcess();
    const database = process.connect();
    const owned = await fixture(undefined, undefined, database);
    const controller = owned.controller();
    const requests: string[] = [];
    const requestReady = owned.hub.request.bind(owned.hub);
    owned.hub.request = async (_attempt, _channel, request, path) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new URL(request.url).pathname === "/api/skill"
        ? new Response("Owned pre-dispatch failure", { status: 503 })
        : requestReady(_attempt, _channel, request, path);
    };
    const recovering = createAgentController(
      database,
      owned.hub,
      {
        startPersisted: async () => {
          throw new Error("Unexpected runtime create");
        },
      },
      undefined,
      owned.writers,
    );
    try {
      const commandID = crypto.randomUUID();
      await controller.prompt(owned.changeID, "Owned failure", owned.userID, commandID);
      await eventually(
        () => owned.turn(commandID),
        (turn) => turn?.state === "failed",
        "Owned terminal failure missing",
      );
      await controller.shutdown();
      // The process-loss tests above establish this real crash gap. Recreate
      // that snapshot here only to exercise each contextual negative cheaply.
      await database.client`UPDATE factory.change_agent_session SET state = 'starting',
        active_inbox_id = NULL, last_error = 'Retain replacement state' WHERE change_id = ${owned.changeID}`;
      if (boundary === "Session replaced")
        await database.client`UPDATE factory.change_agent_session
        SET opencode_session_id = 'ses_owned_replacement' WHERE change_id = ${owned.changeID}`;
      if (boundary === "runtime unassigned")
        await database.client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
      if (boundary === "Turn no longer owns Session")
        await database.client`UPDATE factory.change_agent_session
        SET active_turn_id = NULL WHERE change_id = ${owned.changeID}`;
      if (boundary === "input replaced")
        await database.client`UPDATE factory.change_agent_session
        SET state = 'working', active_inbox_id = 'msg_owned_replacement' WHERE change_id = ${owned.changeID}`;
      if (boundary === "stopped")
        await database.client`UPDATE factory.change_agent_session
        SET state = 'stopped' WHERE change_id = ${owned.changeID}`;
      if (boundary === "mode changed")
        await database.client`UPDATE factory.ticket_conversation SET mode='plan', version=version+1
          WHERE ticket_id=${owned.ticketID}`;
      async function snapshot() {
        const rows = await database.client<
          {
            state: string;
            sessionID: string;
            turnID: string | null;
            inputID: string | null;
            error: string | null;
          }[]
        >`
          SELECT state, opencode_session_id AS "sessionID", active_turn_id AS "turnID",
            active_inbox_id AS "inputID", last_error AS error FROM factory.change_agent_session
          WHERE change_id = ${owned.changeID}`;
        return rows[0];
      }
      const before = await snapshot();
      const beforeRequests = [...requests];
      const outcomes = await database.client<{ summary: string | null }[]>`
        SELECT outcome_summary AS summary FROM factory.agent_turn WHERE command_id = ${commandID}`;
      const failedSummary = outcomes[0]?.summary;
      expect(failedSummary).toBeString();
      await recovering.recover();
      await recovering.shutdown();
      const after = await snapshot();
      if (boundary === "mode changed") {
        expect(after).toMatchObject({
          ...before,
          state: "failed",
          error: failedSummary,
        });
      } else expect(after).toEqual(before);
      expect(requests).toEqual(beforeRequests);
      expect((await owned.turn(commandID))?.state).toBe("failed");
    } finally {
      await controller.shutdown();
      await recovering.shutdown();
      await database.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  30_000,
);
