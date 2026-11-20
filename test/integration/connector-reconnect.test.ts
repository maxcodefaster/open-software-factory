import { expect, test } from "bun:test";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { buildModelID } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { controlledForgeProtection } from "../fixtures/forge-protection";
import { nativeBuildProcessFixture } from "../fixtures/native-build-process";
import { nativeProcessProtocol } from "../fixtures/native-process-protocol";
import { callFactoryFunction } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

test.each(["Build", "Staging"] as const)(
  "%s reconnects both Connector roles without replacing compute or replaying work",
  async (target) => {
    const forge = controlledForgeProtection();
    const process = await factoryProcess(undefined, {
      FACTORY_FORGEJO_ADMIN_TOKEN: forge.FACTORY_FORGEJO_ADMIN_TOKEN,
      FACTORY_FORGEJO_API_URL: forge.FACTORY_FORGEJO_API_URL,
      FACTORY_FORGEJO_PUBLIC_URL: "https://owned-build.factory.invalid",
    });
    const database = process.connect();
    const sockets: WebSocket[] = [];
    let native: Awaited<ReturnType<typeof nativeProcessProtocol>> | undefined;
    let ownedFixture: Awaited<ReturnType<typeof nativeBuildProcessFixture>> | undefined;
    try {
      native = await nativeProcessProtocol(process, database);
      const peer = native;
      const initialized = await process.start();
      await process.kill(initialized);
      const owned = await nativeBuildProcessFixture(database, peer);
      ownedFixture = owned;
      if (target === "Staging") {
        // Use an independent Staging attempt; the Ticket runtime remains untouched.
        await database.client`INSERT INTO factory.staging_preview(project_id,revision)
          VALUES(${owned.projectID},${"a".repeat(40)})`;
        await peer.startStaging(owned.projectID, owned.userID, {
          version: 1,
          primaryApp: "web",
          apps: [
            {
              id: "web",
              label: "Owned Web",
              command: ["node", "web.js"],
              port: 4321,
              healthPath: "/",
            },
          ],
        });
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
      let queuedInput: unknown;
      let promptCalls = 0;
      let mutationCalls = 0;
      let activeReads = 0;
      let installedSkills: string[] = [];
      let permissions: unknown[] | undefined;
      const instructions = new Map<string, unknown>();
      const mcpServers = new Set<string>();
      async function connect(role: "parent" | "child") {
        return peer.connect(attemptID, role, (socket) => {
          sockets.push(socket);
          socket.addEventListener("message", async (event) => {
            const frame = JSON.parse(String(event.data)) as {
              type: string;
              path: string;
              method: string;
              data: string;
              streamId: string;
              operationId: string;
              action: string;
              channel: string;
            };
            if (frame.channel === "source") {
              await peer.sourceFence(socket, frame);
              return;
            }
            if (frame.type === "operation-request") {
              // Grant renewal and closing its ephemeral browser are not model
              // inference, Runtime Stop or an App action.
              if (["browser-renew", "browser-close"].includes(frame.action)) {
                socket.send(
                  JSON.stringify({
                    type: "operation-response",
                    operationId: frame.operationId,
                    action: frame.action,
                  }),
                );
                return;
              }
              mutationCalls += 1;
              if (frame.action !== "skills-install")
                throw new Error(`Unexpected owned Connector operation: ${frame.action}`);
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
              return;
            }
            if (frame.type !== "http-request") return;
            const path = new URL(frame.path, "http://owned.invalid").pathname;
            if (path.endsWith("/log")) {
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
                    `data: ${JSON.stringify({
                      type: "log.synced",
                      aggregateID: owned.sessionID,
                      seq: 1,
                    })}\n\n`,
                  ).toString("base64"),
                }),
              );
              socket.send(JSON.stringify({ type: "stream-end", streamId: frame.streamId }));
              return;
            }
            if (frame.method !== "GET" && frame.method !== "HEAD") mutationCalls += 1;
            let data: unknown = [];
            let status = 200;
            if (path.includes("/instructions/entries")) {
              if (frame.method === "GET")
                data = [...instructions].map(([key, value]) => ({ key, value }));
              else {
                status = 204;
                const key = decodeURIComponent(
                  fixtureValue(path.split("/").at(-1), 'path.split("/").at(-1)'),
                );
                if (frame.method === "PUT")
                  instructions.set(
                    key,
                    (JSON.parse(Buffer.from(frame.data, "base64").toString()) as { value: unknown })
                      .value,
                  );
                else instructions.delete(key);
              }
            } else if (
              [
                "/api/experimental/mcp/factory_browser",
                "/api/experimental/mcp/factory_sources",
              ].includes(path) &&
              frame.method === "PUT"
            ) {
              mcpServers.add(fixtureValue(path.split("/").at(-1), 'path.split("/").at(-1)'));
              status = 204;
            } else if (path === "/api/mcp") {
              data = [...mcpServers].map((name) => ({ name, status: { status: "connected" } }));
            } else if (path === "/api/info") {
              data = { version: "2.0.27" };
            } else if (path === "/api/skill") {
              data = installedSkills.map((id) => ({
                id,
                name: id,
                path: `/opt/factory/admitted-skills/${id}/SKILL.md`,
                content: "",
              }));
            } else if (path.endsWith("/agent")) {
              status = 204;
            } else if (path === "/api/model") data = [{ providerID: "factory", id: buildModelID }];
            else if (path === `/api/session/${owned.sessionID}`) {
              if (frame.method === "PATCH") {
                const body = JSON.parse(Buffer.from(frame.data, "base64").toString()) as {
                  permissions?: unknown[];
                };
                if (body.permissions) permissions = structuredClone(body.permissions);
                status = 204;
              } else
                data = {
                  id: owned.sessionID,
                  ...(permissions ? { permissions: structuredClone(permissions) } : {}),
                  location: { directory: "/workspace/project" },
                  model: { providerID: "factory", id: buildModelID },
                };
            } else if (path.endsWith("/active")) {
              activeReads += 1;
              data = promptID ? { [owned.sessionID]: { type: "running" } } : {};
            } else if (path.endsWith("/prompt")) {
              promptCalls += 1;
              promptID = (
                JSON.parse(Buffer.from(frame.data, "base64").toString()) as { id: string }
              ).id;
              data = {
                id: promptID,
                sessionID: owned.sessionID,
                type: "user",
                time: { created: 1 },
                delivery: "queue",
                payload: JSON.parse(Buffer.from(frame.data, "base64").toString()),
              };
              queuedInput = data;
            } else if (path.endsWith("/inbox")) {
              data = queuedInput ? [queuedInput] : [];
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
        });
      }
      const state = async () => {
        const [row] = await database.client<
          { state: string; failure: string | null; updatedAt: string }[]
        >`
          SELECT state, failure, updated_at::text AS "updatedAt" FROM factory.runtime_attempt WHERE id = ${attempt.id}`;
        return row;
      };
      const identity = async () => [
        ...(await database.client`
        SELECT attempt.id,attempt.generation,attempt.revision,attempt.workspace_id,
          binding.atespace,binding.actor_name,binding.actor_uid,binding.intent,
          attempt.parent_connector_token_hash,attempt.child_connector_token_hash,
          COALESCE(workspace.atespace,isolated.atespace)#>>'{metadata,uid}' AS atespace_uid,
          COALESCE(workspace.template,isolated.template)#>>'{metadata,uid}' AS template_uid
        FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
        LEFT JOIN factory.substrate_workspace workspace ON workspace.workspace_id=attempt.workspace_id AND workspace.generation=attempt.generation
        LEFT JOIN factory.substrate_isolated isolated ON isolated.runtime_attempt_id=attempt.id
        WHERE attempt.project_id=${owned.projectID} ORDER BY attempt.id`),
      ];
      const before = await identity();
      expect(
        before.every(
          (row) =>
            row["actor_uid"] &&
            row["atespace_uid"] &&
            row["template_uid"] &&
            row["parent_connector_token_hash"] !== row["child_connector_token_hash"],
        ),
      ).toBe(true);
      const lifecycleBefore = peer.calls.filter((call) => !call.method.startsWith("Get"));
      const beforeConnection = await state();
      let parent = await connect("parent");
      let child = await connect("child");
      // Prior work retained a ready row. Wait for this process to observe the
      // current hello, not that stale row while native recovery still owns Source.
      await eventually(
        state,
        (row) => row?.state === "ready" && row.updatedAt !== beforeConnection?.updatedAt,
        "Current Connector readiness was not observed",
      );
      const parentHeaders = await peer.connectorHeaders(attemptID, "parent");
      for (const invalid of [
        { "x-factory-runtime-actor-uid": crypto.randomUUID() },
        { "x-factory-runtime-actor-uid": "" },
        { "x-factory-runtime-generation": "2" },
        { "x-factory-connector-role": "child" },
      ]) {
        const rejected = await fetch(`${process.base}/internal/runtime-connect`, {
          headers: { ...parentHeaders, ...invalid },
        });
        expect(rejected.status).toBe(401);
      }
      const commandID = crypto.randomUUID();
      if (target === "Build") {
        const response = await callFactoryFunction(
          process.base,
          "sendCodingPrompt",
          [owned.changeID, { commandId: commandID, text: "Owned reconnect" }],
          headers,
        );
        expect(response).toMatchObject({ ok: true });
        if (!response.ok) throw new Error(response.message);
        expect(response.value.turn?.commandId).toBe(commandID);
        expect(await owned.turn(commandID)).toMatchObject({ id: response.value.turn?.id });
        await eventually(
          async () => {
            const turn = await owned.turn(commandID);
            if (turn && ["failed", "uncertain", "needs-resolution"].includes(turn.state))
              throw new Error(
                `Owned reconnect admission ${turn.state}: ${turn.summary ?? "No summary"}`,
              );
            return turn;
          },
          (turn) => turn?.state === "running",
          "Build dispatch missing",
          30_000,
        );
        expect(promptCalls).toBe(1);
        const [writer] = await database.client<{ epoch: number }[]>`
          SELECT epoch::float8 AS epoch FROM factory.change_writer WHERE change_id=${owned.changeID}`;
        if (!writer) throw Error("Owned reconnect Source writer is missing");
        const fence = {
          attemptID,
          workspaceID: owned.workspaceID,
          writerEpoch: writer.epoch,
          writable: false,
        };
        expect(peer.sourceFences).toEqual([fence, fence]);
        expect(permissions).toContainEqual({
          action: "question",
          resource: "*",
          effect: "deny",
        });
      }
      const turn = target === "Build" ? await owned.turn(commandID) : undefined;
      const beforeMutations = mutationCalls;
      const beforeReads = activeReads;
      const beforeFences = [...peer.sourceFences];
      parent.close();
      child.close();
      await eventually(
        state,
        (row) =>
          row?.state === "starting" && Boolean(row.failure?.endsWith("connector reconnecting")),
        "Reconnect grace missing",
      );
      if (target === "Build") {
        const response = await callFactoryFunction(
          process.base,
          "getAgentView",
          [owned.changeID],
          headers,
        );
        expect(await serverCall(Promise.resolve(response))).toMatchObject({
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
        const response = await callFactoryFunction(
          process.base,
          "getAgentView",
          [owned.changeID],
          headers,
        );
        expect(await serverCall(Promise.resolve(response))).toMatchObject({
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
      expect(peer.sourceFences).toEqual(beforeFences);
      expect(peer.calls.filter((call) => !call.method.startsWith("Get"))).toEqual(lifecycleBefore);
    } finally {
      await process.shutdown();
      for (const socket of sockets) socket.close();
      await ownedFixture?.shutdown();
      ownedFixture?.restoreEnvironment();
      await native?.close();
      await database.client.end({ timeout: 0 });
      await process.dispose();
      await forge.dispose();
    }
  },
  120_000,
);
