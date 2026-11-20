import { expect, test } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { createMCPSourceEndpoint, mcpSourceAlias } from "../../apps/factory/src/mcp/sources";
import { mcpDigest } from "../../apps/factory/src/mcp/controller";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { seedMonitoringDelegation } from "../fixtures/monitoring";
import { fixtureValue } from "../fixtures/value";

test("a human-approved Build retains the prepared Input's exact shared sources independently of hook activation", async () => {
  const f = await fixture();
  try {
    const seeded = await f.database.client.begin((sql) =>
      seedMonitoringDelegation(sql, {
        userID: f.userID,
        projectID: f.projectID,
        ticketID: f.ticketID,
        delegation: "prepare-ticket",
      }),
    );
    await f.database
      .client`UPDATE factory.monitoring_incident SET state='prepared' WHERE id=${seeded.incidentID}`;
    await f.database
      .client`UPDATE factory.monitoring_hook SET enabled=false WHERE id=${seeded.hookID}`;
    const admission = createChangeAdmission(f.database, buildModelID);
    const first = await admission.admit(f.changeID, f.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    const library = createMCPConnections(
      f.database,
      {
        configured: false,
        read: async () => undefined,
        create: async () => {
          throw new Error("No new provider authorization");
        },
      },
      "owned-input-admission",
      "https://factory.example",
    ).library;
    const assignments = await library.assignments(first.turn.id);
    expect(assignments.map((source) => source.connectionId)).toEqual([seeded.connectionID]);
    expect(first.turn.authority.mode).toBe("build");
    if (first.turn.authority.mode === "build")
      expect(first.turn.authority.monitoringIncidentId).toBeUndefined();
  } finally {
    await f.dispose();
  }
});

test.each([true, false])(
  "Build corrections retain the initial MCP selection, including an empty selection: %s",
  async (initiallyEnabled) => {
    const f = await fixture();
    const turns = createAgentTurnStore(f.database);
    const admission = createChangeAdmission(f.database, buildModelID);
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const [manager] = await f.database.client<
      Array<{ id: string }>
    >`SELECT user_id AS id FROM factory.administrator LIMIT 1`;
    if (!manager) throw new Error("Owned fixture manager missing");
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "Owned admission source", version: "1" });
      server.registerTool(
        "read",
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "Owned read" }] }),
      );
      return server;
    });
    const connections = createMCPConnections(
      f.database,
      {
        configured: false,
        read: async () => undefined,
        create: async () => {
          throw new Error("This public source needs no credentials");
        },
      },
      "owned-build-mcp-key",
      "https://factory.example",
      async (url, init) => handler.fetch(new Request(url, init)),
    );
    async function setup() {
      await connections.library.save(
        {
          libraryId: id,
          revisionId,
          expectedRevision: 0,
          scope: "system",
          content: {
            name: "Owned frozen source",
            description: "Owned admission proof",
            endpoint: "https://source.example/mcp",
            provider: "custom",
            authentication: "none",
            roles: ["build"],
          },
        },
        fixtureValue(manager, "manager").id,
      );
      await connections.connect(id, fixtureValue(manager, "manager").id, {
        commandId: crypto.randomUUID(),
        revisionId,
        expectedVersion: 0,
      });
      const connection = await f.database.client.begin((sql) =>
        connections.library.connectionIn(sql, id),
      );
      const tool = connection.tools[0];
      if (!tool) throw new Error("Owned source tool missing");
      await connections.library.review(
        id,
        fixtureValue(manager, "manager").id,
        connection.version,
        [{ name: tool.name, digest: tool.digest }],
      );
      await connections.library.grant(
        id,
        f.projectID,
        fixtureValue(manager, "manager").id,
        true,
        connection.version + 1,
      );
      await connections.library.choose(
        {
          libraryId: id,
          revisionId,
          projectId: f.projectID,
          scope: "project",
          role: "build",
          state: "required",
          expectedVersion: 0,
        },
        fixtureValue(manager, "manager").id,
      );
    }
    try {
      if (initiallyEnabled) await setup();
      const first = await admission.admit(f.changeID, f.userID, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      });
      const original = await connections.library.assignments(first.turn.id);
      expect(original).toHaveLength(initiallyEnabled ? 1 : 0);
      const owner = await turns.claimPending(first.turn.id);
      if (!owner?.ownerToken) throw new Error("Owned first turn lease missing");
      await turns.beginDispatch(first.turn.id, owner.ownerToken);
      if (initiallyEnabled) {
        const token = owner.ownerToken;
        const facade = createMCPSourceEndpoint(f.database, connections, {
          authorizeRuntime: async (attemptID, turnID, authorization) =>
            attemptID === f.attemptID &&
            turnID === owner.id &&
            authorization === "Bearer owned-source-capability" &&
            (await turns.validateExecution(owner.id, token))
              ? {
                  ownerToken: token,
                  session: {
                    id: crypto.randomUUID(),
                    ordinal: 1,
                    turnID: owner.id,
                    changeID: f.changeID,
                    attemptID: f.attemptID,
                    generation: 1,
                    agentSessionID: f.sessionID,
                    ownerID: f.userID,
                    state: "intended",
                  },
                }
              : null,
        });
        const response = await facade(
          new Request("https://factory.example/internal/source-proof", {
            method: "POST",
            headers: {
              authorization: "Bearer owned-source-capability",
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: mcpSourceAlias(id, "read"), arguments: {} },
            }),
          }),
          f.attemptID,
          owner.id,
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Owned read");
        const observations = await f.database.client`
          SELECT * FROM factory.mcp_observation WHERE turn_id=${owner.id}`;
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
          connection_id: id,
          tool_name: "read",
          tool_digest: original[0]?.tools[0]?.digest,
          result_digest: mcpDigest("Owned read"),
          is_error: false,
        });
        expect(JSON.stringify(observations)).not.toContain("Owned read");
      }
      await turns.settle(
        first.turn.id,
        owner.ownerToken,
        "completed",
        "Owned admission-only proof",
      );
      if (initiallyEnabled)
        await connections.library.choose(
          {
            libraryId: id,
            revisionId,
            projectId: f.projectID,
            scope: "project",
            role: "build",
            state: "disable",
            expectedVersion: 1,
          },
          manager.id,
        );
      else await setup();
      const correction = await admission.admit(f.changeID, f.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Correct the same approved work",
      });
      expect(await connections.library.assignments(correction.turn.id)).toEqual(original);
    } finally {
      await handler.close();
      await f.dispose();
    }
  },
);
