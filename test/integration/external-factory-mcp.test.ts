import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { hashPassword } from "better-auth/crypto";
import { createExternalFactoryMCP } from "../../apps/factory/src/mcp/external";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { emergencyAdministratorID } from "../../packages/auth/src/policy";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedMCPAuthorization } from "../fixtures/mcp-authorization";
import { substrateFixture } from "../fixtures/substrate";

function mcpValue(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (!("content" in result)) throw new Error("Missing MCP content");
  const text = result.content.find((part) => part.type === "text");
  if (text?.type !== "text") throw new Error("Missing MCP text");
  return JSON.parse(text.text);
}

async function mcpFirstStartFixture(kind: "personal" | "ticket" = "personal") {
  const f = await substrateFixture("a".repeat(40), kind);
  const directory = await mkdtemp(join(tmpdir(), "factory-mcp-first-start-"));
  const clients: Client[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  const sources = createSubstrateSources(f.database, f.hub);
  const workspaceSources = createWorkspaceSourceController(f.database, f.hub, sources);
  async function dispose() {
    for (const client of clients) await client.close();
    await server?.stop(true);
    await workspaceSources.close();
    await removeRuntimeRepository(f.attemptID);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await f.database.client`DELETE FROM factory.development_workspace WHERE id=${f.workspaceID}`;
    const repository = join(directory, "repository");
    const ca = join(directory, "ca.pem");
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
    await Bun.$`git init -b main ${repository}`.quiet();
    await Bun.$`mkdir -p ${join(repository, ".factory")}`.quiet();
    await writeFile(
      join(repository, ".factory/system.json"),
      JSON.stringify({
        version: 1,
        primaryApp: "web",
        apps: [
          {
            id: "web",
            label: "Owned",
            command: ["node", "server.mjs"],
            port: 4300,
            healthPath: "/",
          },
        ],
      }),
    );
    await Bun.$`git -C ${repository} add .`.quiet();
    await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
    await f.database
      .client`UPDATE factory.project SET repository_url=${`file://${repository}`} WHERE id=${f.projectID}`;
    const configuration: SubstrateInstallationConfiguration = {
      deployment: "fresh-workspaces",
      database: f.config.database,
      connection: f.config.connection,
      provisioner: { ...f.config.connection, tokenFile: "/unused/owner-token" },
      editorPrincipal: "user:system:serviceaccount:owned:factory-control",
      connectorURL: f.config.connectorURL,
      factoryCAFile: ca,
      workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
      profile: f.config.profile,
      runtime: f.config.runtime,
      workerSelector: {
        "factory.runtime/profile": f.config.profile,
        "factory.dev/deployment": "owned",
      },
      egressHosts: [],
    };
    const objects = new Map<string, Record<string, unknown>>();
    const probe = {
      calls: [] as string[],
      creates: new Map<string, number>(),
      lose: "",
      afterStart: undefined as (() => Promise<void>) | undefined,
      previewGrants: [] as Array<{ attemptID: string; appChannel: string }>,
    };
    async function retainedIntent() {
      const commands = await f.database
        .client`SELECT workspace_id,actor_id,action,dispatch_attempted_at
        FROM factory.workspace_lifecycle_command WHERE workspace_id=${f.workspaceID}`;
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command).toMatchObject({
          workspace_id: f.workspaceID,
          actor_id: f.userID,
          action: "start",
        });
        expect(command["dispatch_attempted_at"]).not.toBeNull();
      }
      expect(
        await f.database
          .client`SELECT workspace_id FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID}`,
      ).toHaveLength(1);
    }
    const call: SubstrateCall = async (method, input) => {
      // Check from another connection before *every* native dispatch, including reads.
      probe.calls.push(method);
      await retainedIntent();
      const request = input as Record<string, Record<string, unknown>>;
      const kind = method.replace(/^(Get|Create)/, "");
      if (method.startsWith("Get")) {
        const object = objects.get(kind);
        if (!object) throw new SubstrateRPCError("NotFound", "absent");
        return structuredClone(object);
      }
      if (method.startsWith("Create")) {
        probe.creates.set(kind, (probe.creates.get(kind) ?? 0) + 1);
        const spec =
          request[
            kind === "AtespaceAccessPolicy"
              ? "accessPolicy"
              : kind === "ActorEgressPolicy"
                ? "egressPolicy"
                : `${kind[0]?.toLowerCase()}${kind.slice(1)}`
          ];
        if (!spec) throw new Error(`Missing owned ${kind}`);
        const object = {
          ...spec,
          metadata: {
            ...(spec["metadata"] as object),
            uid: crypto.randomUUID(),
            version: "1",
            createTime: new Date().toISOString(),
          },
        };
        if (kind === "Actor") Object.assign(object, { status: { state: "ACTOR_STATE_SUSPENDED" } });
        objects.set(kind, object);
        if (probe.lose === method) {
          probe.lose = "";
          throw new SubstrateRPCError("Unavailable", "owned lost native reply");
        }
        return structuredClone(object);
      }
      if (method === "ResumeActor") {
        const actor = nativeActor.parse(objects.get("Actor"));
        actor.metadata.version = "2";
        actor.status = {
          state: "ACTOR_STATE_RUNNING",
          workerAssignment: { sandboxRuntime: f.config.runtime },
        };
        objects.set("Actor", actor);
        return { actor };
      }
      throw new Error(`Unexpected owned native operation ${method}`);
    };
    const runtimeController = createRuntimeController(f.database, f.hub, "owned-native-secret", {
      configuration,
      call,
      provisionerCall: call,
      capacity: {
        async ensure() {
          throw new Error("Unexpected background capacity admission");
        },
        async requireReady() {
          probe.calls.push("requireReady");
          await retainedIntent();
        },
      },
    });
    const principals = new Map<string, { userID: string; scopes: string[] }>();
    // Controlled authenticated principal only. SQL Project/Workspace authority, the MCP
    // transport, lifecycle request retention and normal runtime Start are real.
    const services = {
      database: f.database,
      factoryOrigin: "http://127.0.0.1",
      factoryAuth: {
        async mcpSession(request: Request) {
          const principal = principals.get(request.headers.get("x-owned-test-principal") ?? "");
          if (!principal) throw new Error("Unknown owned test principal");
          return principal;
        },
      },
      workspaceSources,
      workspaceSharing: createWorkspaceSharing(f.database, () => {}),
      runtimeAccess: {
        async issue(input: { attemptID: string; appChannel: string }) {
          probe.previewGrants.push(input);
          return "owned-preview-grant";
        },
      },
      runtimeController: {
        ...runtimeController,
        async start(...args: Parameters<typeof runtimeController.start>) {
          const result = await runtimeController.start(...args);
          await probe.afterStart?.();
          return result;
        },
      },
      runtimeHub: f.hub,
    } as unknown as Parameters<typeof createExternalFactoryMCP>[0];
    let handler = createExternalFactoryMCP(services);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handler(request),
    });
    const origin = `http://127.0.0.1:${server.port}`;
    async function connect(userID = f.userID, work = true) {
      const principal = crypto.randomUUID();
      principals.set(principal, {
        userID,
        scopes: work ? ["factory:read", "factory:work"] : ["factory:read"],
      });
      const client = new Client({ name: "owned-mcp-first-start", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
          requestInit: { headers: { "x-owned-test-principal": principal } },
        }),
      );
      return client;
    }
    return {
      ...f,
      probe,
      connect,
      client: await connect(),
      recreateHandler() {
        handler = createExternalFactoryMCP(services);
      },
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

test("MCP explicit Project Start initializes a fresh personal native Workspace with retained request intent", async () => {
  const f = await mcpFirstStartFixture();
  const { client, probe } = f;
  const requestID = crypto.randomUUID();
  try {
    expect(
      mcpValue(
        await client.callTool({ name: "listWorkspaces", arguments: { projectID: f.projectID } }),
      ),
    ).toEqual({ workspaces: [] });
    const unopened = await client.callTool({
      name: "openWorkspace",
      arguments: { projectID: f.projectID },
    });
    expect(unopened.isError).toBe(true);
    expect(mcpValue(unopened).error.message).toContain(
      "No compute or legacy Workspace was created",
    );
    expect(await f.database.client`SELECT id FROM factory.development_workspace`).toHaveLength(0);
    expect(
      await f.database.client`SELECT id FROM factory.workspace_lifecycle_command`,
    ).toHaveLength(0);
    expect(probe.calls).toHaveLength(0);
    const started = await client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID },
    });
    expect(started.isError, JSON.stringify(started)).not.toBe(true);
    expect(mcpValue(started)).toMatchObject({
      id: f.attemptID,
      workspaceId: f.workspaceID,
      ownerUserId: f.userID,
      native: { state: "ACTOR_STATE_RUNNING" },
    });
    expect(probe.creates.get("Actor")).toBe(1);
    const beforePreview = probe.calls.length;
    const missingApp = await client.callTool({
      name: "getPreview",
      arguments: { workspaceID: f.workspaceID, app: "app-undeclared" },
    });
    expect(missingApp.isError).toBe(true);
    expect(mcpValue(missingApp).error.code).toBe("not-found");
    expect(probe.previewGrants).toHaveLength(0);
    const preview = await client.callTool({
      name: "getPreview",
      arguments: { workspaceID: f.workspaceID, app: "app" },
    });
    expect(preview.isError).not.toBe(true);
    expect(mcpValue(preview)).toMatchObject({ attemptID: f.attemptID, app: "app" });
    expect(probe.previewGrants).toEqual([
      expect.objectContaining({ attemptID: f.attemptID, appChannel: "app" }),
    ]);
    expect(probe.calls).toHaveLength(beforePreview);
    const beforeReplay = probe.calls.length;
    f.recreateHandler();
    for (const target of [{ projectID: f.projectID }, { workspaceID: f.workspaceID }])
      expect(
        mcpValue(
          await client.callTool({ name: "startWorkspace", arguments: { ...target, requestID } }),
        ),
      ).toEqual(mcpValue(started));
    expect(probe.calls).toHaveLength(beforeReplay);
    expect([...(await f.database.client`SELECT id FROM factory.development_workspace`)]).toEqual([
      { id: f.workspaceID },
    ]);
    expect([
      ...(await f.database
        .client`SELECT id FROM factory.workspace_lifecycle_command WHERE completed_at IS NOT NULL`),
    ]).toEqual([{ id: requestID }]);
    // The existing Workspace selector still admits a distinct, deliberate Start.
    const existing = await client.callTool({
      name: "startWorkspace",
      arguments: { workspaceID: f.workspaceID, requestID: crypto.randomUUID() },
    });
    expect(existing.isError, JSON.stringify(existing)).not.toBe(true);
    expect(mcpValue(existing).id).toBe(f.attemptID);
    expect(probe.creates.get("Actor")).toBe(1);
    // Observing a dispatched request is not a new Start and needs no fresh setup.
    await f.database
      .client`INSERT INTO factory.project_setup_readiness(project_id,task,state,command_id)
      VALUES(${f.projectID},'configuration','pending',${crypto.randomUUID()})`;
    const beforeBlockedReplay = probe.calls.length;
    expect(
      mcpValue(
        await client.callTool({
          name: "startWorkspace",
          arguments: { projectID: f.projectID, requestID },
        }),
      ),
    ).toEqual(mcpValue(started));
    const blocked = await client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID: crypto.randomUUID() },
    });
    expect(blocked.isError).toBe(true);
    expect(mcpValue(blocked).error.code).toBe("unavailable");
    expect(probe.calls).toHaveLength(beforeBlockedReplay);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("MCP explicit Project Start requires exactly one target and current Developer and work authority", async () => {
  const f = await mcpFirstStartFixture();
  try {
    const contributor = crypto.randomUUID(),
      stranger = crypto.randomUUID();
    for (const userID of [contributor, stranger])
      await f.database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Owned MCP user',${`${userID}@factory.invalid`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${contributor},'product-contributor',${f.userID})`;
    const otherProject = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      SELECT ${otherProject},${`other-mcp-${otherProject}`},'Other MCP Project',repository_url,default_branch,devcontainer_path,created_by
      FROM factory.project WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${otherProject},${stranger},'developer',${f.userID})`;
    for (const arguments_ of [
      { requestID: crypto.randomUUID() },
      { projectID: f.projectID, workspaceID: f.workspaceID, requestID: crypto.randomUUID() },
      { projectID: f.projectID, requestID: "not-a-request-id" },
    ])
      expect(
        (await f.client.callTool({ name: "startWorkspace", arguments: arguments_ })).isError,
      ).toBe(true);
    for (const name of ["pauseWorkspace", "stopWorkspace"])
      expect(
        (
          await f.client.callTool({
            name,
            arguments: { projectID: f.projectID, requestID: crypto.randomUUID() },
          })
        ).isError,
      ).toBe(true);
    for (const [userID, code] of [
      [contributor, "forbidden"],
      [stranger, "not-found"],
    ] as const) {
      const denied = await (await f.connect(userID)).callTool({
        name: "startWorkspace",
        arguments: { projectID: f.projectID, requestID: crypto.randomUUID() },
      });
      expect(denied.isError).toBe(true);
      expect(mcpValue(denied).error.code).toBe(code);
    }
    const reader = await f.connect(f.userID, false);
    expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "startWorkspace",
    );
    await expect(
      reader.callTool({
        name: "startWorkspace",
        arguments: { projectID: f.projectID, requestID: crypto.randomUUID() },
      }),
    ).rejects.toThrow("Tool startWorkspace not found");
    expect(f.probe.calls).toHaveLength(0);
    for (const table of [
      "development_workspace",
      "substrate_workspace",
      "workspace_lifecycle_command",
    ])
      expect(await f.database.client.unsafe(`SELECT * FROM factory.${table}`)).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("MCP explicit Project Start rejects request reuse across Projects, actors and actions without initializing another Workspace", async () => {
  const f = await mcpFirstStartFixture();
  const requestID = crypto.randomUUID();
  try {
    const started = await f.client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID },
    });
    expect(started.isError).not.toBe(true);
    const otherProject = crypto.randomUUID(),
      developer = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      SELECT ${otherProject},${`other-mcp-${otherProject}`},'Other MCP Project',repository_url,default_branch,devcontainer_path,created_by
      FROM factory.project WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${otherProject},${f.userID},'developer',${f.userID})`;
    await f.database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${developer},'Other MCP Developer',${`${developer}@factory.invalid`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${developer},'developer',${f.userID})`;
    const before = f.probe.calls.length;
    const retained = [
      ...(await f.database.client`SELECT * FROM factory.workspace_lifecycle_command`),
    ];
    const other = await f.connect(developer);
    for (const [client, name, target] of [
      [f.client, "startWorkspace", { projectID: otherProject }],
      [other, "startWorkspace", { projectID: f.projectID }],
      [f.client, "pauseWorkspace", { workspaceID: f.workspaceID }],
      [f.client, "stopWorkspace", { workspaceID: f.workspaceID }],
    ] as const) {
      const denied = await client.callTool({ name, arguments: { ...target, requestID } });
      expect(denied.isError, JSON.stringify(denied)).toBe(true);
      expect(mcpValue(denied).error.code).toBe("conflict");
    }
    expect(f.probe.calls).toHaveLength(before);
    expect([...(await f.database.client`SELECT id FROM factory.development_workspace`)]).toEqual([
      { id: f.workspaceID },
    ]);
    expect([
      ...(await f.database.client`SELECT workspace_id FROM factory.substrate_workspace`),
    ]).toEqual([{ workspace_id: f.workspaceID }]);
    expect([
      ...(await f.database.client`SELECT id FROM factory.workspace_lifecycle_command`),
    ]).toEqual([{ id: requestID }]);
    expect([
      ...(await f.database.client`SELECT * FROM factory.workspace_lifecycle_command`),
    ]).toEqual(retained);
    await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    const revoked = await f.client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID },
    });
    expect(revoked.isError).toBe(true);
    expect(mcpValue(revoked).error.code).toBe("forbidden");
    expect(f.probe.calls).toHaveLength(before);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("MCP explicit Project Start retains a lost native reply and never redispatches that request", async () => {
  const f = await mcpFirstStartFixture();
  const requestID = crypto.randomUUID();
  try {
    f.probe.lose = "CreateAtespace";
    const lost = await f.client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID },
    });
    expect(lost.isError).toBe(true);
    expect(mcpValue(lost).error.code).toBe("unavailable");
    const before = f.probe.calls.length;
    f.recreateHandler();
    expect(
      mcpValue(
        await f.client.callTool({
          name: "startWorkspace",
          arguments: { projectID: f.projectID, requestID },
        }),
      ),
    ).toEqual({ requestID, state: "uncertain" });
    expect(
      mcpValue(
        await f.client.callTool({
          name: "getWorkspace",
          arguments: { workspaceID: f.workspaceID },
        }),
      ).runtime,
    ).toBeNull();
    expect(
      (
        await f.client.callTool({
          name: "openWorkspace",
          arguments: { projectID: f.projectID },
        })
      ).isError,
    ).not.toBe(true);
    expect(f.probe.calls).toHaveLength(before);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    const [intent] = await f.database
      .client`SELECT completed_at,result FROM factory.workspace_lifecycle_command WHERE id=${requestID}`;
    expect(intent).toEqual({ completed_at: null, result: null });
    // A distinct explicit Start can reconcile the same normal native intent.
    const recovered = await f.client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID: crypto.randomUUID() },
    });
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(mcpValue(recovered).id).toBe(f.attemptID);
    expect(f.probe.creates.get("Atespace")).toBe(1);
    expect(f.probe.creates.get("Actor")).toBe(1);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("MCP explicit Project Start observes a concurrent duplicate while the first result is unconfirmed", async () => {
  const f = await mcpFirstStartFixture();
  const requestID = crypto.randomUUID();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first: Promise<Awaited<ReturnType<Client["callTool"]>>> | undefined;
  try {
    const secondClient = await f.connect();
    f.probe.afterStart = async () => {
      started.resolve();
      await release.promise;
    };
    first = f.client.callTool({
      name: "startWorkspace",
      arguments: { projectID: f.projectID, requestID },
    });
    await Promise.race([
      started.promise,
      first.then((result) => {
        throw new Error(`Start ended before the retained-result gate: ${JSON.stringify(result)}`);
      }),
    ]);
    const before = f.probe.calls.length;
    expect(
      mcpValue(
        await secondClient.callTool({
          name: "startWorkspace",
          arguments: { projectID: f.projectID, requestID },
        }),
      ),
    ).toEqual({ requestID, state: "uncertain" });
    expect(f.probe.calls).toHaveLength(before);
    release.resolve();
    const result = await first;
    expect(result.isError).not.toBe(true);
    expect(
      mcpValue(
        await secondClient.callTool({
          name: "startWorkspace",
          arguments: { projectID: f.projectID, requestID },
        }),
      ),
    ).toEqual(mcpValue(result));
    expect(f.probe.calls).toHaveLength(before);
    expect(f.probe.creates.get("Actor")).toBe(1);
    expect([
      ...(await f.database.client`SELECT id FROM factory.workspace_lifecycle_command`),
    ]).toEqual([{ id: requestID }]);
  } finally {
    release.resolve();
    await first?.catch(() => undefined);
    await f.dispose();
  }
}, 60_000);

test("MCP retained lists keep personal privacy and current Project grants separate from Ticket selection", async () => {
  const f = await mcpFirstStartFixture("ticket");
  try {
    const guest = crypto.randomUUID();
    const personalID = personalWorkspaceIdentity(f.projectID, f.userID).workspaceID;
    await f.database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${guest},'Owned list guest',${`${guest}@factory.invalid`})`;
    await f.database.client`INSERT INTO factory.administrator(user_id) VALUES(${guest})`;
    await f.database
      .client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${personalID},${f.projectID},'personal',${f.userID},'main',${"a".repeat(40)},${f.userID})`;
    const client = await f.connect(guest);
    const list = async () =>
      mcpValue(await client.callTool({ name: "listWorkspaces", arguments: {} })).workspaces;
    expect(await list()).toEqual([]);
    const ticketArguments = { projectID: f.projectID, limit: 1 };
    const ticketRow = {
      changeID: f.changeID,
      ticketID: f.ticketID,
      title: "Owned native Ticket fence",
      state: "active",
      workspaceID: null,
    };
    expect(
      mcpValue(await client.callTool({ name: "listTicketWorkspaces", arguments: ticketArguments })),
    ).toEqual({ workspaces: [ticketRow], nextOffset: null });
    expect(
      mcpValue(
        await client.callTool({
          name: "listTicketWorkspaces",
          arguments: { ...ticketArguments, offset: 1 },
        }),
      ),
    ).toEqual({ workspaces: [], nextOffset: null });
    await f.database
      .client`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,created_by)
      SELECT ${f.workspaceID},project_id,'ticket',ticket_id,id,branch_name,base_sha,created_by
      FROM factory.change WHERE id=${f.changeID}`;
    expect(await list()).toEqual([
      {
        workspaceID: f.workspaceID,
        projectID: f.projectID,
        kind: "ticket",
        ownerID: null,
        changeID: f.changeID,
        collaborative: false,
      },
    ]);
    const share = async (permission: "observe" | null, expectedVersion: number) =>
      f.client.callTool({
        name: "shareWorkspace",
        arguments: {
          commandID: crypto.randomUUID(),
          workspaceID: personalID,
          userID: guest,
          permission,
          expectedVersion,
        },
      });
    expect((await share("observe", 0)).isError).not.toBe(true);
    expect((await list()).map((row: { workspaceID: string }) => row.workspaceID).sort()).toEqual(
      [personalID, f.workspaceID].sort(),
    );
    await f.database.client`DELETE FROM factory.administrator WHERE user_id=${guest}`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${guest},'product-contributor',${f.userID})`;
    expect(await list()).toEqual([]);
    const denied = await client.callTool({
      name: "listWorkspaces",
      arguments: { projectID: f.projectID },
    });
    expect(mcpValue(denied).error.code).toBe("forbidden");
    await f.database.client`UPDATE factory.project_membership SET role='developer'
      WHERE project_id=${f.projectID} AND user_id=${guest}`;
    expect((await list()).length).toBe(2);
    expect((await share(null, 1)).isError).not.toBe(true);
    expect((await list()).map((row: { workspaceID: string }) => row.workspaceID)).toEqual([
      f.workspaceID,
    ]);
    for (const unavailable of ["cancelled", "trashed"]) {
      if (unavailable === "cancelled")
        await f.database
          .client`UPDATE factory.change SET cancel_requested_at=now() WHERE id=${f.changeID}`;
      else {
        await f.database
          .client`UPDATE factory.change SET cancel_requested_at=NULL WHERE id=${f.changeID}`;
        await f.database.client`UPDATE factory.ticket SET trashed_at=now() WHERE id=${f.ticketID}`;
      }
      expect(
        mcpValue(
          await client.callTool({ name: "listTicketWorkspaces", arguments: ticketArguments }),
        ),
      ).toEqual({ workspaces: [], nextOffset: null });
    }
    expect(f.probe.calls).toHaveLength(0);
    expect([
      ...(await f.database.client`SELECT id FROM factory.workspace_lifecycle_command`),
    ]).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("public Factory MCP uses explicit OAuth and current Workspace grants through the real SDK", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const clients: Client[] = [];
  const connect = async (accessToken: string) => {
    const client = new Client({ name: "owned-external-mcp", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${fixture.base}/api/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
    return client;
  };
  const value = (result: Awaited<ReturnType<Client["callTool"]>>) => {
    if (!("content" in result)) throw new Error("MCP proof received no tool content");
    const text = result.content.find((part) => part.type === "text");
    if (!text || text.type !== "text") throw new Error("MCP proof received no text");
    return JSON.parse(text.text);
  };
  try {
    await fixture.start();
    const cookie = await fixture.signIn();
    const owner = emergencyAdministratorID;
    const guest = crypto.randomUUID(),
      project = crypto.randomUUID();
    const password = "owned-mcp-guest-password";
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${guest},'MCP collaborator',${`${guest}@factory.invalid`})`;
    await database.client`INSERT INTO auth.account(id,user_id,account_id,provider_id,password)
      VALUES(${crypto.randomUUID()},${guest},${guest},'credential',${await hashPassword(password)})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`external-mcp-${project}`},'Owned external MCP','https://github.com/example/project','main','.devcontainer/devcontainer.json',${owner})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${guest},'developer',${owner})`;
    const workspaceID = personalWorkspaceIdentity(project, owner).workspaceID;
    await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${workspaceID},${project},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
    const login = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({ email: `${guest}@factory.invalid`, password }),
    });
    expect(login.status).toBe(200);
    const guestCookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const ownerGrant = await ownedMCPAuthorization(fixture.base, cookie);
    const guestGrant = await ownedMCPAuthorization(fixture.base, guestCookie);
    const readGrant = await ownedMCPAuthorization(fixture.base, guestCookie, false);
    const ownerClient = await connect(ownerGrant.accessToken);
    const guestClient = await connect(guestGrant.accessToken);
    const readClient = await connect(readGrant.accessToken);
    const tools = await ownerClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("runCommand");
    expect(tools.tools.map((tool) => tool.name)).toContain("shareWorkspace");
    expect(tools.tools.map((tool) => tool.name)).toContain("beginFileTransfer");
    expect(tools.tools.map((tool) => tool.name)).toContain("downloadFileChunk");
    expect(tools.tools.map((tool) => tool.name)).toContain("listTicketWorkspaces");
    expect(tools.tools.map((tool) => tool.name)).toContain("takeOverTicketEditing");
    expect(
      value(
        await ownerClient.callTool({ name: "getWorkspaceEditing", arguments: { workspaceID } }),
      ),
    ).toMatchObject({ kind: "personal", canWrite: true });
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "runCommand",
    );
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "beginFileTransfer",
    );
    const containerDenied = await readClient.callTool({
      name: "readFile",
      arguments: { workspaceID, location: "container", path: "/etc/hostname" },
    });
    expect(containerDenied.isError).toBe(true);
    expect(value(containerDenied).error.code).toBe("forbidden");
    const transferURL = `${fixture.base}/api/workspace-transfers/${crypto.randomUUID()}`;
    expect((await fetch(transferURL)).status).toBe(401);
    expect(
      (await fetch(transferURL, { headers: { authorization: `Bearer ${readGrant.accessToken}` } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(transferURL, { headers: { authorization: `Bearer ${ownerGrant.accessToken}` } }))
        .status,
    ).toBe(404);
    expect(
      value(
        await guestClient.callTool({ name: "listWorkspaces", arguments: { projectID: project } }),
      ).workspaces,
    ).toHaveLength(0);
    const commandID = crypto.randomUUID();
    const shared = await ownerClient.callTool({
      name: "shareWorkspace",
      arguments: {
        commandID,
        workspaceID,
        userID: guest,
        permission: "observe",
        expectedVersion: 0,
      },
    });
    expect(shared.isError).not.toBe(true);
    expect(
      value(
        await guestClient.callTool({ name: "listWorkspaces", arguments: { projectID: project } }),
      ).workspaces,
    ).toHaveLength(1);
    const denied = await guestClient.callTool({
      name: "runCommand",
      arguments: { requestID: crypto.randomUUID(), workspaceID, command: "must-not-run" },
    });
    expect(denied.isError).toBe(true);
    expect(value(denied).error.code).toBe("forbidden");
    expect(
      value(
        await guestClient.callTool({ name: "getWorkspaceEditing", arguments: { workspaceID } }),
      ),
    ).toMatchObject({ kind: "personal", canWrite: false });
    await ownerClient.callTool({
      name: "shareWorkspace",
      arguments: {
        commandID: crypto.randomUUID(),
        workspaceID,
        userID: guest,
        permission: null,
        expectedVersion: 1,
      },
    });
    const kicked = await guestClient.callTool({ name: "getWorkspace", arguments: { workspaceID } });
    expect(kicked.isError).toBe(true);
    expect(value(kicked).error.code).toBe("not-found");
    const anonymous = await fetch(`${fixture.base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const metadata = await fetch(`${fixture.base}/.well-known/oauth-protected-resource/api/mcp`);
    expect(metadata.ok).toBe(true);
    expect((await metadata.json()).resource).toBe(`${fixture.base}/api/mcp`);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${project}`,
    ).toHaveLength(0);
  } finally {
    for (const client of clients) await client.close();
    await database.client.end({ timeout: 2 });
    await fixture.dispose();
  }
}, 60000);
