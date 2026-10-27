import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMCPService } from "../../apps/factory/src/mcp/service";
import { createInputService } from "../../apps/factory/src/monitoring/service";
import type { createMonitoringController } from "../../apps/factory/src/monitoring/controller";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { factoryFunctionRequest } from "../fixtures/server-functions";

test("native MCP and Inputs retain host validation, immutable commands, actor binding and browser-independent admission", async () => {
  const origin = "https://factory.test",
    actor = crypto.randomUUID(),
    project = crypto.randomUUID();
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    commandID = crypto.randomUUID();
  const effects: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => effects.push({ method, args });
  const admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let maintenance = true,
    signedIn = true;
  const mcp = createMCPService({
    library: {
      async view(...args: unknown[]) {
        record("mcp-read", args);
        return {
          canManageSystem: false,
          canManageProject: true,
          choices: [],
          entries: [],
          proposals: Object.assign([], { command: "SELECT", count: 0 }),
          token: "not-a-projection",
        };
      },
      async save(...args: unknown[]) {
        record("mcp-save", args);
        return { saved: true };
      },
      async choose(...args: unknown[]) {
        record("mcp-choice", args);
        return { saved: true };
      },
      async propose(...args: unknown[]) {
        record("mcp-share", args);
        return { saved: true };
      },
      async accept(...args: unknown[]) {
        record("mcp-accept", args);
        return { libraryId: id };
      },
      async review(...args: unknown[]) {
        record("mcp-review", args);
        return { saved: true };
      },
      async grant(...args: unknown[]) {
        record("mcp-grant", args);
        return { saved: true };
      },
      async disconnect(...args: unknown[]) {
        record("mcp-disconnect", args);
        return { saved: true };
      },
    },
    async connect(...args: unknown[]) {
      record("mcp-connect", args);
      admitted.resolve();
      await release.promise;
      return { authorizationUrl: null };
    },
  } as unknown as Parameters<typeof createMCPService>[0]);
  const inputs = createInputService(
    {
      async view(...args: unknown[]) {
        record("input-read", args);
        return { canManage: true, canDelegate: true, canDisable: true, hooks: [], incidents: [] };
      },
      async save(...args: unknown[]) {
        record("input-save", args);
        return { url: null };
      },
      async change(...args: unknown[]) {
        record("input-change", args);
        return { url: null };
      },
    } as unknown as Pick<ReturnType<typeof createMonitoringController>, "view" | "save" | "change">,
    {
      async requireProject(userID, projectID) {
        expect(userID).toBe(actor);
        expect(projectID).toBe(project);
      },
    },
  );
  const entry: typeof import("../../apps/factory/src/start-server") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: { mcp, inputs } as FactoryServices,
    session: async () => (signedIn ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("MCP and Inputs do not add Fresh Auth");
    },
    handle: async (request, options) => entry.default.fetch(request, options),
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const definition = {
    libraryId: id,
    revisionId: revision,
    expectedRevision: 0,
    scope: "personal",
    content: {
      name: "Owned source",
      description: "Read exact context",
      endpoint: "https://source.example/mcp",
      provider: "custom",
      authentication: "none",
      roles: ["planning", "build"],
    },
  };
  const connect = { commandId: commandID, revisionId: revision, expectedVersion: 0 };
  const input = {
    id,
    commandId: commandID,
    expectedVersion: 0,
    name: "Owned Input",
    enabled: true,
  };
  const decision = { commandId: commandID, expectedVersion: 1 };
  const choice = {
    libraryId: id,
    revisionId: revision,
    scope: "project",
    projectId: project,
    role: "build",
    state: "enable",
    expectedVersion: 0,
  };
  const share = { id: commandID, revisionId: revision, target: "project", projectId: project };
  const review = {
    expectedVersion: 1,
    confirmReadOnlyAccess: true,
    tools: [{ name: "read_issue", digest: "a".repeat(64) }],
  };
  const grant = { projectId: project, enabled: true, expectedVersion: 1 };
  for (const [name, args] of [
    ["saveMCPDefinition", [1n]],
    ["saveProjectInput", [project, 1n]],
    ["saveMCPDefinition", [definition]],
    ["saveMCPChoice", [choice]],
    ["proposeMCPSharing", [share]],
    ["acceptMCPSharing", [commandID]],
    ["connectMCP", [id, connect]],
    ["reviewMCPAccess", [id, review]],
    ["grantMCPProject", [id, grant]],
    ["disconnectMCP", [id]],
    ["saveProjectInput", [project, input]],
    ["disableProjectInput", [project, id, decision]],
    ["rotateProjectInput", [project, id, decision]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["saveMCPDefinition", [1n]],
    ["saveProjectInput", [project, 1n]],
    ["saveMCPDefinition", [{ ...definition, actorID: "forged" }]],
    ["connectMCP", [id, { ...connect, userId: actor }]],
    ["reviewMCPAccess", [id, { ...review, confirmReadOnlyAccess: false }]],
    ["grantMCPProject", [id, { ...grant, expectedVersion: -1 }]],
    ["saveProjectInput", [project, { ...input, projectId: actor }]],
    ["rotateProjectInput", [project, id, { ...decision, expectedVersion: 0 }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  expect(
    await call("reviewMCPAccess", [
      id,
      {
        ...review,
        tools: [{ name: "x".repeat(128_000), digest: "a".repeat(64) }],
      },
    ]),
  ).toMatchObject({ ok: false, status: 409 });
  expect(
    await call("saveProjectInput", [project, { ...input, name: " ".repeat(16_000) }]),
  ).toMatchObject({ ok: false, status: 409 });
  expect(effects).toEqual([]);
  await call("saveMCPDefinition", [definition]);
  await call("saveMCPChoice", [choice]);
  await call("proposeMCPSharing", [share]);
  await call("acceptMCPSharing", [commandID]);
  await call("reviewMCPAccess", [id, review]);
  await call("grantMCPProject", [id, grant]);
  await call("disconnectMCP", [id]);
  await call("saveProjectInput", [project, input]);
  await call("disableProjectInput", [project, id, decision]);
  await call("rotateProjectInput", [project, id, decision]);
  expect(effects).toEqual([
    { method: "mcp-save", args: [definition, actor] },
    { method: "mcp-choice", args: [choice, actor] },
    { method: "mcp-share", args: [commandID, revision, "project", project, actor] },
    { method: "mcp-accept", args: [commandID, actor] },
    { method: "mcp-review", args: [id, actor, 1, review.tools] },
    { method: "mcp-grant", args: [id, project, actor, true, 1] },
    { method: "mcp-disconnect", args: [id, actor] },
    {
      method: "input-save",
      args: [
        project,
        actor,
        {
          ...input,
          instructions: expect.any(String),
          connectionIds: [],
          delegation: "prepare-ticket",
        },
      ],
    },
    { method: "input-change", args: [project, id, actor, "disable", decision] },
    { method: "input-change", args: [project, id, actor, "rotate", decision] },
  ]);
  const cancel = new AbortController();
  const pending = endpoint(
    await factoryFunctionRequest(origin, "connectMCP", [id, connect], {}, cancel.signal),
  );
  void pending.catch(() => {});
  await admitted.promise;
  cancel.abort();
  release.resolve();
  await pending.catch(() => undefined);
  expect(effects.at(-1)).toEqual({ method: "mcp-connect", args: [id, actor, connect] });
  const read = await call("getMCPLibrary", [project]);
  expect(read).toMatchObject({ ok: true, value: { entries: [], proposals: [] } });
  expect(JSON.stringify(read)).not.toMatch(/SELECT|not-a-projection/);
  expect(await call("getProjectInputs", [project])).toMatchObject({
    ok: true,
    value: { hooks: [] },
  });
  signedIn = false;
  expect((await endpoint(await factoryFunctionRequest(origin, "getMCPLibrary", []))).status).toBe(
    401,
  );
});
