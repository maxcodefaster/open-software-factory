import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { createMCPService } from "../../apps/factory/src/mcp/service";
import { createMonitoringController } from "../../apps/factory/src/monitoring/controller";
import { createInputService } from "../../apps/factory/src/monitoring/service";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { mcpLibraryView } from "../../packages/conversation-domain/src/mcp-library";
import { monitoringView } from "../../packages/conversation-domain/src/monitoring";
import { factoryProcess } from "../fixtures/factory-process";
import { factoryFunctionRequest } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

test("compiled MCP and Input commands enforce current SQL authority, exact revisions, CAS and no inference on settings changes", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const manager = crypto.randomUUID(),
    member = crypto.randomUUID(),
    outsider = crypto.randomUUID();
  const project = crypto.randomUUID(),
    libraryID = crypto.randomUUID(),
    revisionID = crypto.randomUUID();
  const inputID = crypto.randomUUID(),
    epoch = crypto.randomUUID();
  const origin = "https://factory.test";
  const wake: string[] = [];
  const connections = createMCPConnections(
    database,
    {
      configured: false,
      read: async () => undefined,
      create: async () => {
        throw new Error("This SQL proof performs no credential exchange");
      },
    },
    "owned-native-sql-key",
    origin,
  );
  const monitoring = createMonitoringController(database, "owned-native-input-key", origin, (id) =>
    wake.push(id),
  );
  const entry: typeof import("../../apps/factory/src/start-server") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  const actors: readonly string[] = [manager, member, outsider];
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: {
      mcp: createMCPService(connections),
      inputs: createInputService(monitoring, createAccessController(database)),
    } as FactoryServices,
    session: async (request) => {
      const actor = request.headers.get("x-owned-sql-actor");
      return actor && actors.includes(actor) ? { user: { id: actor } } : null;
    },
    maintenance: async () => false,
    requireFresh: async () => {},
    handle: async (request, options) => entry.default.fetch(request, options),
  });
  async function call(
    actor: string,
    name: string,
    args: unknown[],
  ): Promise<ServerResult<unknown>> {
    const value = await decodeResponse<ServerResult<unknown>>(
      await endpoint(
        await factoryFunctionRequest(origin, name, args, { "x-owned-sql-actor": actor }),
      ),
    );
    if (!value) throw new Error("Compiled SQL command returned no result");
    return value as ServerResult<unknown>;
  }
  const definition = {
    libraryId: libraryID,
    revisionId: revisionID,
    expectedRevision: 0,
    scope: "personal",
    content: {
      name: "Owned SQL source",
      description: "Read approved context",
      endpoint: "https://source.example/mcp",
      provider: "custom",
      authentication: "none",
      roles: ["planning", "build"],
    },
  };
  try {
    for (const id of [manager, member, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},'Owned native SQL account',${`${id}@owned-native.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`native-${project}`},'Owned native SQL Project','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${project},${member},'product-contributor',false,${manager})`;
    expect(await call(member, "saveMCPDefinition", [definition])).toMatchObject({ ok: true });
    expect(await call(member, "saveMCPDefinition", [definition])).toMatchObject({ ok: true });
    expect(
      await call(member, "saveMCPDefinition", [{ ...definition, scope: "system" }]),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      mcpLibraryView.parse(await serverCall(call(outsider, "getMCPLibrary", []))).entries,
    ).toEqual([]);
    expect(
      await call(member, "saveMCPDefinition", [
        {
          ...definition,
          content: { ...definition.content, name: "Changed exact command" },
        },
      ]),
    ).toMatchObject({ ok: false, status: 409 });
    const sharedID = crypto.randomUUID(),
      sharedRevision = crypto.randomUUID();
    await serverCall(
      call(manager, "saveMCPDefinition", [
        {
          ...definition,
          libraryId: sharedID,
          revisionId: sharedRevision,
          scope: "system",
        },
      ]),
    );
    const tools = [
      {
        name: "read_issue",
        description: "Read context",
        inputSchema: { type: "object" },
        digest: "a".repeat(64),
        readOnlyHint: true,
      },
      {
        name: "delete_issue",
        description: "Never approved",
        inputSchema: { type: "object" },
        digest: "b".repeat(64),
        readOnlyHint: false,
      },
    ];
    // Only provider discovery is seeded. Human approvals, grants, CAS and
    // execution eligibility below all run through the real controllers.
    await database.client`INSERT INTO factory.mcp_connection(id,revision_id,state,version,credential_epoch,tools,authorized_by)
      VALUES(${sharedID},${sharedRevision},'review',1,${epoch},${JSON.stringify(tools)}::jsonb,${manager})`;
    const review = {
      expectedVersion: 1,
      confirmReadOnlyAccess: true,
      tools: [{ name: "read_issue", digest: fixtureValue(tools[0], "tools[0]").digest }],
    };
    expect(await call(member, "reviewMCPAccess", [sharedID, review])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await call(manager, "reviewMCPAccess", [
        sharedID,
        {
          ...review,
          tools: [{ name: "read_issue", digest: "wrong" }],
        },
      ]),
    ).toMatchObject({ ok: false, status: 409 });
    await serverCall(call(manager, "reviewMCPAccess", [sharedID, review]));
    const grant = { projectId: project, enabled: true, expectedVersion: 2 };
    expect(await call(member, "grantMCPProject", [sharedID, grant])).toMatchObject({
      ok: false,
      status: 403,
    });
    await serverCall(call(manager, "grantMCPProject", [sharedID, grant]));
    const choices = {
      libraryId: sharedID,
      revisionId: sharedRevision,
      scope: "personal",
      projectId: project,
      role: "planning",
      state: "enable",
      expectedVersion: 0,
    };
    await serverCall(call(member, "saveMCPChoice", [choices]));
    expect(await call(member, "saveMCPChoice", [choices])).toMatchObject({
      ok: false,
      status: 409,
    });
    const save = {
      id: inputID,
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Owned Input",
      enabled: true,
      connectionIds: [sharedID],
    };
    expect(await call(member, "saveProjectInput", [project, save])).toMatchObject({
      ok: false,
      status: 403,
    });
    const created = z
      .object({ url: z.url() })
      .parse(await serverCall(call(manager, "saveProjectInput", [project, save])));
    expect(await serverCall(call(manager, "saveProjectInput", [project, save]))).toEqual(created);
    expect(
      await call(manager, "saveProjectInput", [project, { ...save, name: "Changed command" }]),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await call(outsider, "getProjectInputs", [project])).toMatchObject({
      ok: false,
      status: 404,
    });
    const disable = { commandId: crypto.randomUUID(), expectedVersion: 1 };
    await serverCall(call(manager, "disableProjectInput", [project, inputID, disable]));
    await serverCall(call(manager, "disableProjectInput", [project, inputID, disable]));
    const rotation = { commandId: crypto.randomUUID(), expectedVersion: 2 };
    const rotated = z
      .object({ url: z.url() })
      .parse(await serverCall(call(manager, "rotateProjectInput", [project, inputID, rotation])));
    expect(rotated.url).not.toBe(created.url);
    expect(
      await serverCall(call(manager, "rotateProjectInput", [project, inputID, rotation])),
    ).toEqual(rotated);
    const view = monitoringView.parse(
      await serverCall(call(manager, "getProjectInputs", [project])),
    );
    expect(view.hooks).toMatchObject([{ id: inputID, enabled: false, version: 3 }]);
    expect(JSON.stringify(view)).not.toContain(new URL(rotated.url).pathname.split("/").at(-1));
    await serverCall(call(manager, "disconnectMCP", [sharedID]));
    const current = mcpLibraryView.parse(
      await serverCall(call(manager, "getMCPLibrary", [project])),
    );
    expect(current.entries.find((entry) => entry.id === sharedID)?.connection).toMatchObject({
      state: "revoked",
      allowedTools: [],
    });
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${member}`;
    expect(await call(member, "getMCPLibrary", [project])).toMatchObject({
      ok: false,
      status: 403,
    });
    const [counts] = await database.client`SELECT
      (SELECT count(*)::int FROM factory.monitoring_command WHERE hook_id=${inputID}) AS commands,
      (SELECT count(*)::int FROM factory.agent_turn WHERE project_id=${project}) AS turns`;
    expect(counts).toMatchObject({ commands: 3, turns: 0 });
    expect(wake).toEqual([]);
  } finally {
    await database.client.end();
    await owned.dispose();
  }
}, 60_000);
