import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { createMonitoringController } from "../../apps/factory/src/monitoring/controller";
import { createMonitoringRoutes } from "../../apps/factory/src/monitoring/routes";
import { factoryProcess } from "./factory-process";
import type { AgentTurnTransaction } from "../../apps/factory/src/agent/turn-store";
import { monitoringDigest } from "../../apps/factory/src/monitoring/payload";
import { mcpDigest } from "../../apps/factory/src/mcp/controller";

// Exact synthetic authorization state for the existing native Build/reviewer
// fixture. Transport/authentication itself uses monitoringFixture below.
export async function seedMonitoringDelegation(
  sql: AgentTurnTransaction,
  context: {
    userID: string;
    projectID: string;
    ticketID: string;
    delegation?: "prepare-ticket" | "application-fix-and-delivery";
  },
) {
  const connectionID = crypto.randomUUID(),
    revisionID = crypto.randomUUID();
  const hookID = crypto.randomUUID(),
    policyID = crypto.randomUUID(),
    incidentID = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const content = {
    name: "Owned delegated source",
    description: "Synthetic source for delivery gates",
    provider: "custom",
    endpoint: "https://source.example/mcp",
    authentication: "none",
    roles: ["planning", "build"],
  };
  const tool = {
    name: "read_issue",
    description: "Read an owned issue",
    inputSchema: { type: "object", properties: {} },
    readOnlyHint: true,
    digest: "b".repeat(64),
  };
  const assignment = {
    connectionId: connectionID,
    credentialEpoch: epoch,
    revisionId: revisionID,
    policyVersion: 1,
    tools: [tool],
    required: true,
  };
  await sql`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${context.projectID} AND user_id=${context.userID}`;
  await sql`INSERT INTO factory.mcp_library(id,scope,project_id) VALUES(${connectionID},'project',${context.projectID})`;
  await sql`INSERT INTO factory.mcp_revision(id,library_id,revision,content,digest,created_by)
    VALUES(${revisionID},${connectionID},1,${JSON.stringify(content)}::jsonb,${mcpDigest(content)},${context.userID})`;
  await sql`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,allowed_tools,authorized_by)
    VALUES(${connectionID},${revisionID},'ready',1,${epoch},${JSON.stringify([tool])}::jsonb,
      ${JSON.stringify([{ name: tool.name, digest: tool.digest }])}::jsonb,${context.userID})`;
  await sql`INSERT INTO factory.monitoring_hook(id,project_id,name,version,enabled,secret_digest,policy_id)
    VALUES(${hookID},${context.projectID},'Owned delegated Autofix',1,true,${monitoringDigest("owned-key")},${policyID})`;
  await sql`INSERT INTO factory.monitoring_policy(id,hook_id,connection_id,assignment,delegated_by,delegation)
    VALUES(${policyID},${hookID},${connectionID},${JSON.stringify(assignment)}::jsonb,${context.userID},${context.delegation ?? "application-fix-and-delivery"})`;
  await sql`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,fingerprint,payload_digest,title,context,state,ticket_id)
    VALUES(${incidentID},${hookID},${context.projectID},${policyID},1,${monitoringDigest("owned-defect")},
      ${monitoringDigest("owned-payload")},'Owned delegated defect','Owned diagnostic context','implementing',${context.ticketID})`;
  return { incidentID, policyID, hookID, connectionID };
}

export async function monitoringFixture(options: { readIssue?: (id: string) => string } = {}) {
  const host = await factoryProcess();
  const database = host.connect();
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const hookId = crypto.randomUUID();
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "Owned monitoring source", version: "1" });
    server.registerTool(
      "read_issue",
      {
        description:
          "Read one monitoring incident by its exact issue identifier from the alert reference or context.",
        inputSchema: z.object({
          id: z
            .string()
            .describe("Exact monitoring issue identifier, not a Project ID or file path."),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        calls++;
        return {
          content: [
            {
              type: "text",
              text:
                options.readIssue?.(id) ?? `Owned issue ${id}: invoice is null at src/invoice.ts:1`,
            },
          ],
        };
      },
    );
    return server;
  });
  const mcp = createMCPConnections(
    database,
    {
      configured: false,
      read: async () => undefined,
      create: async () => {
        throw new Error("The owned public source has no credentials");
      },
    },
    "owned-monitoring-secret",
    "https://factory.example",
    (url, init) => handler.fetch(new Request(url, init)),
  );
  const controller = createMonitoringController(
    database,
    "owned-monitoring-secret",
    "https://factory.example",
    () => {},
  );
  const routes = createMonitoringRoutes(controller);
  async function addSource(scope: "personal" | "project") {
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    await mcp.library.save(
      {
        libraryId: id,
        revisionId,
        expectedRevision: 0,
        scope,
        ...(scope === "project" ? { projectId } : {}),
        content: {
          name: `Owned ${scope} monitoring source`,
          description: "Owned monitoring fixture",
          endpoint: "https://owned.example/mcp",
          provider: "custom",
          authentication: "none",
          roles: ["planning", "build"],
        },
      },
      userId,
    );
    await mcp.connect(id, userId, {
      commandId: crypto.randomUUID(),
      revisionId,
      expectedVersion: 0,
    });
    const full = await database.client.begin((sql) => mcp.library.connectionIn(sql, id));
    const tool = full.tools[0];
    if (!tool) throw new Error("Owned source tool missing");
    await mcp.library.review(id, userId, full.version, [{ name: tool.name, digest: tool.digest }]);
    return { id, revisionId };
  }
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userId},'Owned Autofix manager',${`${userId}@monitoring.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userId})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectId},${`monitoring-${projectId}`},'Owned Autofix Project',
      'https://forge.example/owned/monitoring.git','main','.devcontainer/devcontainer.json',${userId})`;
    const source = await addSource("project");
    const saved = await controller.save(projectId, userId, {
      id: hookId,
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Owned Autofix",
      connectionIds: [source.id],
      enabled: true,
      delegation: "application-fix-and-delivery",
    });
    if (!saved.url) throw new Error("Owned webhook URL missing");
    const url = saved.url;
    async function receive(fingerprint = "invoice-error") {
      const response = await routes.intake(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Invoice exception",
            fingerprint,
            url: "https://owned.example/issues/42",
            context: { stack: "src/invoice.ts:1" },
          }),
        }),
      );
      if (response?.status !== 202) throw new Error("Owned webhook delivery failed");
      const [row] = await database.client<{ id: string }[]>`
        SELECT id FROM factory.monitoring_incident WHERE hook_id=${hookId} ORDER BY received_at DESC,id DESC LIMIT 1`;
      if (!row) throw new Error("Owned incident missing");
      return row.id;
    }
    return {
      database,
      userId,
      projectId,
      hookId,
      source,
      url,
      mcp,
      controller,
      routes,
      addSource,
      receive,
      sourceCalls: () => calls,
      async dispose() {
        await handler.close();
        await database.client.end();
        await host.dispose();
      },
    };
  } catch (cause) {
    await handler.close();
    await database.client.end();
    await host.dispose();
    throw cause;
  }
}
