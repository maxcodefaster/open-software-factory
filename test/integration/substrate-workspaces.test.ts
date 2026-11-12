import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createAgentCommitTransport } from "../../apps/factory/src/agent/commit-transport";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createDeliveryCoordination } from "../../apps/factory/src/delivery/coordination";
import { createChangeIntegration } from "../../apps/factory/src/delivery/integration";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { removeRuntimeRepository } from "../../apps/factory/src/runtime/git-http";
import {
  substrateTicketSourceIn,
  substrateWorkspaceGrantIn,
} from "../../apps/factory/src/runtime/substrate-grant";
import type { SubstrateWorkspaceConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import type { RuntimeAttemptView } from "../../apps/factory/src/runtime/types";
import { computeAllocationIn } from "../../apps/factory/src/usage/compute";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { substrateFixture } from "../fixtures/substrate";

test("normal Start provisions a fresh owned Workspace/Atespace/grant/template; lost replies keep the same native intent", async () => {
  const f = await substrateFixture();
  const directory = await mkdtemp(join(tmpdir(), "substrate-provision-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  await f.database.client`DELETE FROM factory.development_workspace WHERE id=${f.workspaceID}`;
  const config: SubstrateWorkspaceConfiguration = {
    deployment: "fresh-workspaces",
    database: f.config.database,
    projectID: f.projectID,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
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
  await f.database
    .client`UPDATE factory.project SET repository_url='file:///not-dispatched',default_branch='main' WHERE id=${f.projectID}`;
  // A real local Git repository supplies the same revision resolution as normal Start.
  const repo = join(directory, "repository");
  await Bun.$`git init -b main ${repo}`.quiet();
  await writeFile(join(repo, "README"), "owned source\n");
  await Bun.$`mkdir -p ${join(repo, ".factory")}`.quiet();
  await writeFile(
    join(repo, ".factory/system.json"),
    JSON.stringify({
      version: 1,
      primaryApp: "web",
      apps: [
        { id: "web", label: "Owned", command: ["node", "server.mjs"], port: 4300, healthPath: "/" },
      ],
    }),
  );
  await Bun.$`git -C ${repo} add .`.quiet();
  await Bun.$`git -C ${repo} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  await f.database
    .client`UPDATE factory.project SET repository_url=${`file://${repo}`} WHERE id=${f.projectID}`;
  const objects = new Map<string, Record<string, unknown>>();
  let extraAttemptID: string | undefined;
  const creates = new Map<string, number>();
  let nativeCalls = 0;
  let lose = "CreateAtespace";
  const call: SubstrateCall = async (method, input) => {
    nativeCalls++;
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create)/, "");
    if (method.startsWith("Get")) {
      const object = objects.get(kind);
      if (!object) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(object);
    }
    if (method.startsWith("Create")) {
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      const [intent] = await f.database
        .client`SELECT atespace_attempted_at,policy_attempted_at,template_attempted_at FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID}`;
      expect(
        intent?.[
          kind === "Atespace"
            ? "atespace_attempted_at"
            : kind === "AtespaceAccessPolicy"
              ? "policy_attempted_at"
              : "template_attempted_at"
        ],
      ).not.toBeNull();
      let spec = request[`${kind[0]?.toLowerCase()}${kind.slice(1)}`];
      if (kind === "AtespaceAccessPolicy") spec = request["accessPolicy"];
      if (kind === "ActorEgressPolicy") spec = request["egressPolicy"];
      if (!spec) throw new Error(`Missing ${kind}`);
      const value = {
        ...spec,
        metadata: {
          ...(spec["metadata"] as object),
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date().toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      objects.set(kind, value);
      if (method === lose) {
        lose = "";
        throw new SubstrateRPCError("Unavailable", "lost provisioning reply");
      }
      return structuredClone(value);
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
    throw new Error(`Unexpected ${method}`);
  };
  const controller = (provisioner: SubstrateCall = call) =>
    createRuntimeController(
      f.database,
      f.hub,
      "owned-native-secret",
      {
        async prepareExecution() {
          throw new Error("must not create legacy Source");
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      call,
      config,
      provisioner,
    );
  try {
    const c = controller();
    await expect(c.start(f.projectID, crypto.randomUUID())).rejects.toThrow();
    expect(creates.size).toBe(0);
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost provisioning reply");
    lose = "CreateAtespaceAccessPolicy";
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost provisioning reply");
    lose = "CreateActorTemplate";
    await expect(c.start(f.projectID, f.userID)).rejects.toThrow("lost provisioning reply");
    const started = await controller().start(f.projectID, f.userID);
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(started?.state).not.toBe("ready");
    expect(started?.native?.portable).toBe(false);
    expect(creates.get("Atespace")).toBe(1);
    expect(creates.get("AtespaceAccessPolicy")).toBe(1);
    expect(creates.get("ActorTemplate")).toBe(1);
    expect(creates.get("Actor")).toBe(1);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    expect(await f.database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      0,
    );
    const [saved] = await f.database
      .client`SELECT intent,template FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID}`;
    expect(JSON.stringify(saved)).not.toContain("parentToken");
    const spec = objects.get("ActorTemplate");
    expect(JSON.stringify(spec)).toContain("native-parent");
    expect(JSON.stringify(spec)).not.toContain("file://");
    await expect(
      Promise.resolve(
        f.database
          .client`UPDATE factory.substrate_workspace SET template=NULL WHERE workspace_id=${f.workspaceID}`,
      ),
    ).rejects.toThrow("immutable");
    let retainedOwnerCalls = 0;
    const expiredProvisioner: SubstrateCall = async () => {
      retainedOwnerCalls++;
      throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
    };
    // The existing, scoped Editor grant is enough to revalidate the original
    // resources. Continuation never observes them through the global Owner.
    expect((await controller(expiredProvisioner).start(f.projectID, f.userID))?.id).toBe(
      f.attemptID,
    );
    expect(retainedOwnerCalls).toBe(0);
    const policy = objects.get("AtespaceAccessPolicy");
    if (!policy) throw new Error("Native policy fixture missing");
    objects.set("AtespaceAccessPolicy", { ...policy, bindings: [] });
    await expect(controller(expiredProvisioner).start(f.projectID, f.userID)).rejects.toThrow(
      "grant differs",
    );
    expect(retainedOwnerCalls).toBe(0);
    objects.set("AtespaceAccessPolicy", policy);
    const template = objects.get("ActorTemplate");
    if (!template) throw new Error("Native template fixture missing");
    const original = structuredClone(template);
    (template["metadata"] as { uid: string }).uid = crypto.randomUUID();
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("original identity");
    objects.set("ActorTemplate", original);
    objects.set("ActorTemplate", { ...original, resources: { limits: { memoryBytes: "4096" } } });
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("spec differs");
    objects.set("ActorTemplate", original);
    const space = objects.get("Atespace");
    if (!space) throw new Error("Native space fixture missing");
    objects.delete("Atespace");
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("absent");
    expect(creates.get("Atespace")).toBe(1);
    objects.set("Atespace", space);
    const originalImage = config.workloadImage;
    config.workloadImage = `registry.test/native@sha256:${"b".repeat(64)}`;
    config.resources = { cpuMilli: 2000, memoryMiB: 4096 };
    expect((await controller().start(f.projectID, f.userID))?.id).toBe(f.attemptID);
    expect(objects.get("ActorTemplate")).toMatchObject({ containers: [{ image: originalImage }] });
    expect(creates.get("Actor")).toBe(1);
    expect(await computeAllocationIn(f.database.client, null)).toEqual({
      sandboxes: 1,
      cpuMilli: 1500,
      memoryMiB: 1024,
    });
    expect(objects.get("ActorTemplate")).toMatchObject({
      resources: { limits: { cpuMillicores: "1500", memoryBytes: "1073741824" } },
    });
    expect(
      (
        await f.database
          .client`SELECT intent#>>'{configuration,workloadImage}' AS image FROM factory.substrate_workspace WHERE workspace_id=${f.workspaceID}`
      )[0]?.["image"],
    ).toBe(originalImage);
    // The same installation can use the new pin for another fresh Workspace,
    // without replacing the original Actor or rewriting its retained intent.
    const originalObjects = new Map(objects);
    objects.clear();
    const other = crypto.randomUUID();
    await f.database
      .client`INSERT INTO auth."user"(id,name,email) VALUES(${other},'Fresh image developer',${`${other}@factory.local`})`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${f.projectID},${other},'developer',${f.userID})`;
    for (const [cpuMilli, memoryMiB] of [
      [3500, 5119],
      [3499, 5120],
    ]) {
      await f.database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
        VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), cpuMilli, memoryMiB })}::jsonb,${f.userID})
        ON CONFLICT(scope) DO UPDATE SET policy=EXCLUDED.policy`;
      await expect(controller().start(f.projectID, other)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(creates.get("Actor")).toBe(1);
    }
    await f.database
      .client`UPDATE factory.execution_policy SET policy=${JSON.stringify({ ...defaultExecutionPolicy(), cpuMilli: 3500, memoryMiB: 5120 })}::jsonb WHERE scope='factory'`;
    extraAttemptID = (await controller().start(f.projectID, other))?.id;
    expect(extraAttemptID).toBeDefined();
    expect(extraAttemptID).not.toBe(f.attemptID);
    expect(objects.get("ActorTemplate")).toMatchObject({
      containers: [{ image: config.workloadImage }],
      resources: { limits: { cpuMillicores: "2000", memoryBytes: "4294967296" } },
    });
    expect(await computeAllocationIn(f.database.client, null)).toEqual({
      sandboxes: 2,
      cpuMilli: 3500,
      memoryMiB: 5120,
    });
    expect(creates.get("Actor")).toBe(2);
    objects.clear();
    for (const [kind, value] of originalObjects) objects.set(kind, value);
    expect((await controller().get(f.attemptID))?.native?.actorUID).toBe(
      nativeActor.parse(originalObjects.get("Actor")).metadata.uid,
    );
    expect(objects.get("ActorTemplate")).toMatchObject({ containers: [{ image: originalImage }] });
    const connectorURL = config.connectorURL;
    config.connectorURL = "wss://foreign.test/internal/runtime-connect";
    await expect(controller().start(f.projectID, f.userID)).rejects.toThrow("immutable");
    await expect(controller().get(f.attemptID)).rejects.toThrow("immutable");
    config.connectorURL = connectorURL;
    const originalUID = nativeActor.parse(originalObjects.get("Actor")).metadata.uid;
    await f.database
      .client`INSERT INTO factory.substrate_source(workspace_id,actor_uid) VALUES(${f.workspaceID},${originalUID})`;
    const callsBefore = nativeCalls;
    let ownerCalls = 0;
    for (const state of ["pausing", "failed"]) {
      await f.database
        .client`UPDATE factory.runtime_attempt SET state=${state}::factory.runtime_attempt_state WHERE id=${f.attemptID}`;
      await expect(
        controller(async () => {
          ownerCalls++;
          throw new SubstrateRPCError("Unauthenticated", "expired provisioner");
        }).start(f.projectID, f.userID),
      ).rejects.toThrow("Reconcile the startup outcome");
    }
    expect(ownerCalls).toBe(0);
    expect(nativeCalls).toBe(callsBefore);
  } finally {
    await removeRuntimeRepository(f.attemptID);
    if (extraAttemptID) await removeRuntimeRepository(extraAttemptID);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("startPersisted provisions a real Ticket identity for a commissioned Contributor, retaining lost Actor create and native Source role fences", async () => {
  await mkdir(".factory/test-results", { recursive: true });
  const directory = await mkdtemp(resolve(".factory/test-results/native-ticket-controller-"));
  const repo = join(directory, "repository");
  await cp("templates/starter-app", repo, { recursive: true });
  await Bun.$`git init -b main ${repo}`.quiet();
  await Bun.$`git -C ${repo} add .`.quiet();
  await Bun.$`git -C ${repo} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  const revision = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
  const f = await substrateFixture(revision, "ticket");
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  const config: SubstrateWorkspaceConfiguration = {
    deployment: "owned-test",
    database: f.config.database,
    projectID: f.projectID,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owner-token" },
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
  const creates = new Map<string, number>();
  let loseActor = true;
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create)/, "");
    if (method.startsWith("Get")) {
      const object = objects.get(kind);
      if (!object) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(object);
    }
    if (method.startsWith("Create")) {
      creates.set(kind, (creates.get(kind) ?? 0) + 1);
      const spec =
        request[
          kind === "AtespaceAccessPolicy"
            ? "accessPolicy"
            : kind === "ActorEgressPolicy"
              ? "egressPolicy"
              : `${kind[0]?.toLowerCase()}${kind.slice(1)}`
        ];
      if (!spec) throw new Error("Owned native intent missing");
      const value = {
        ...spec,
        metadata: {
          ...(spec["metadata"] as object),
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date().toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      objects.set(kind, value);
      if (kind === "Actor" && loseActor) {
        loseActor = false;
        throw new SubstrateRPCError("Unavailable", "lost Actor create reply");
      }
      return structuredClone(value);
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
    throw new Error(`Unexpected ${method}`);
  };
  const sources = createSubstrateSources(f.database, f.hub);
  const runtime = createRuntimeController(
    f.database,
    f.hub,
    "owned-native-secret",
    {
      substrate: sources,
      async prepareExecution() {
        throw new Error("Native Ticket must not prepare legacy Source");
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    call,
    config,
    call,
  );
  try {
    await f.database
      .client`UPDATE factory.project SET repository_url=${`file://${repo}`} WHERE id=${f.projectID}`;
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID}`;
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "commissioned Ticket writer",
    );
    expect(creates.size).toBe(0);
    const [approved] = await f.database.client<
      { id: string }[]
    >`SELECT requirement_revision_id AS id FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approved) throw new Error("Controlled approval fixture missing");
    const turns = createAgentTurnStore(f.database);
    const { turn } = await turns.admit(
      {
        kind: "change-start",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        ticketId: f.ticketID,
        changeId: f.changeID,
        createdBy: f.userID,
        conversationId: null,
      },
      {
        mode: "build",
        modelId: "factory-coding-model",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
        conversationVersion: null,
        requirementRevisionId: approved.id,
      },
      (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
    );
    const writers = createChangeWriterController({
      database: f.database,
      agentUsername: "owned-agent",
      protect: async () => {},
      stopAgent: async () => {
        throw new Error("No previous Agent exists");
      },
      runtime: {
        stop: async () => {
          throw new Error("No previous runtime exists");
        },
        async get() {
          return null;
        },
      },
    });
    expect(await writers.prepareAgent(f.changeID, turn.id)).toBe(true);
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(creates.size).toBe(0);
    const owned = await turns.claimPending(turn.id, 60_000);
    if (!owned?.ownerToken) throw new Error("Admitted turn lease missing");
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "lost Actor create reply",
    );
    const started = await runtime.startPersisted(f.changeID, f.userID);
    expect(started?.id).toBe(f.attemptID);
    expect(started?.native?.state).toBe("ACTOR_STATE_RUNNING");
    expect(creates.get("Actor")).toBe(1);
    const readTicketSource = () =>
      f.database.client.begin((sql) => substrateTicketSourceIn(f.database, sql, f.attemptID));
    expect(await readTicketSource()).toBe(`file://${repo}`);
    const [binding] = await f.database
      .client`SELECT w.kind,w.owner_user_id,a.change_id,w.substrate FROM factory.development_workspace w JOIN factory.runtime_attempt a ON a.workspace_id=w.id WHERE a.id=${f.attemptID}`;
    expect(binding).toMatchObject({
      kind: "ticket",
      owner_user_id: null,
      change_id: f.changeID,
      substrate: true,
    });
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    expect(await f.database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      0,
    );
    const template = objects.get("ActorTemplate") as { containers: { env: { value: string }[] }[] };
    const bootstrap = JSON.parse(template.containers[0]?.env[0]?.value ?? "null");
    expect(bootstrap.assignment.channels).toContainEqual({
      name: "agent",
      kind: "agent",
      target: "http://127.0.0.1:4096",
      healthPath: "/api/health",
    });
    expect(
      bootstrap.assignment.processes.find((p: { name: string }) => p.name === "agent").env
        .FACTORY_OPENCODE_TOKEN,
    ).toBeTruthy();
    expect(bootstrap.sourceHandoff).toBe(true);
    const agentEnvironment = bootstrap.assignment.processes.find(
      (p: { name: string }) => p.name === "agent",
    ).env;
    expect(
      JSON.parse(agentEnvironment.FACTORY_OPENCODE_CONFIG).providers.factory.settings.baseURL,
    ).toBe(`https://factory.test/internal/model/${f.attemptID}/v1`);
    expect(agentEnvironment.FACTORY_BUILD_BROWSER_URL).toBe(
      `https://factory.test/internal/build-browser/${f.attemptID}`,
    );
    const restore = await sources.restoreEndpoint(
      new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
        headers: {
          authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent}`,
          "X-Factory-Runtime-Actor-UID": started?.native?.actorUID ?? "",
          "X-Factory-Runtime-Generation": "1",
        },
      }),
      f.attemptID,
    );
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({
      writerEpoch: 1,
      changeWriterEpoch: 2,
      readOnly: true,
      checkpoint: null,
    });
    await f.database
      .client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 second' WHERE id=${turn.id}`;
    await expect(readTicketSource()).rejects.toThrow("current admitted turn");
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(creates.get("Actor")).toBe(1);
    const completed = await turns.claimPending(turn.id, 60_000);
    if (!completed?.ownerToken) throw new Error("Owned completed Build lease missing");
    await turns.beginDispatch(turn.id, completed.ownerToken);
    await turns.settle(turn.id, completed.ownerToken, "completed", "Owned Build completed");
    await runtime.status(f.attemptID, "ready");
    const [notReady] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.change WHERE id=${f.changeID}`;
    expect(notReady?.state).toBe("starting");
    f.hub.ready = () => true;
    await runtime.status(f.attemptID, "ready");
    const [active] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.change WHERE id=${f.changeID}`;
    expect(active?.state).toBe("active");
    await expect(readTicketSource()).rejects.toThrow("Ticket Source grant required");
    const sessionID = `ses_owned_${turn.id.replaceAll("-", "")}`;
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned Build',true,'Owned native Build',${f.attemptID})`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'committed',${f.userID},${turn.id},now())`;
      await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at) SELECT ${turn.id},id,runtime_attempt_id,1,branch_name,base_sha,${"d".repeat(40)},${"d".repeat(40)},'Owned Build',${`owned:${turn.id}`},'succeeded',created_by,now() FROM factory.change WHERE id=${f.changeID}`;
    });
    // Completion alone cannot wake a Ticket. The existing Delivery owner must
    // first persist its exact pending integration under the Project queue.
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID)).toBe(true);
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    let integrationFrames = 0;
    f.hub.parentOperation = async (_id, operation, beforeSend) => {
      await beforeSend?.(() => integrationFrames++);
      expect(operation["repositoryURL"]).toBe(`file://${repo}`);
      return { commitSHA: "f".repeat(40), remoteSHA: "f".repeat(40) };
    };
    // This controller fixture uses a local owned remote; the separate TLS-frame
    // test covers native public-Forge routing. Never relax the real native URL
    // policy to make this fixture deliver its synthetic candidate.
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async () => {
          throw new Error("Integration cannot start inference");
        },
      },
      runtime,
    );
    expect(await integration.reconcile(f.changeID, "e".repeat(40))).toBe(false);
    expect(integrationFrames).toBe(0);
    expect((await runtime.startPersisted(f.changeID, f.userID))?.id).toBe(f.attemptID);
    const [integrationIntent] = await f.database.client<{ state: string; error: string | null }[]>`
      SELECT state,last_error AS error FROM factory.change_commit_operation
      WHERE change_id=${f.changeID} AND source='integration'`;
    // Provisioning successfully reuses the admitted Actor; the synthetic local
    // destination is then refused by the normal strict native Git boundary.
    expect(integrationIntent?.state).toBe("commit-intended");
    expect(integrationIntent?.error).toBeTruthy();
    expect(creates.get("Actor")).toBe(1);
    await createDeliveryCoordination(f.database).release(f.changeID);
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID)).toBe(true);
    expect((await runtime.startPersisted(f.changeID, f.userID))?.id).toBe(f.attemptID);
    await f.database.client.begin(async (sql) => {
      const refusals = [
        () =>
          sql`UPDATE factory.project_delivery_queue SET change_id=NULL WHERE project_id=${f.projectID}`,
        () =>
          sql`UPDATE factory.change_agent_session SET state='stopped',stop_pending=true,stop_id=${crypto.randomUUID()} WHERE change_id=${f.changeID}`,
        () =>
          sql`UPDATE factory.runtime_attempt SET state='stop-intended',stop_intended_at=now() WHERE id=${f.attemptID}`,
        () =>
          sql`UPDATE factory.change_commit_operation SET state='failed',completed_at=now() WHERE change_id=${f.changeID} AND source='integration'`,
        () => sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          SELECT ${crypto.randomUUID()},ticket_id,ordinal+1,canonical_content,content_digest,created_by
          FROM factory.requirement_revision WHERE id=${approved.id}`,
        () =>
          sql`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`,
      ];
      for (const refuse of refusals) {
        await sql`SAVEPOINT native_integration_grant`;
        await refuse();
        await expect(
          substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, true),
        ).rejects.toThrow();
        await sql`ROLLBACK TO SAVEPOINT native_integration_grant`;
      }
    });
    // The local-only regression never sent a Git frame. Settle that refused
    // fixture operation before projecting the later human writer below.
    await f.database
      .client`UPDATE factory.change_commit_operation SET state='failed',completed_at=now()
      WHERE change_id=${f.changeID} AND source='integration' AND state='commit-intended'`;
    await expect(runtime.startPersisted(f.changeID, f.userID)).rejects.toThrow(
      "current admitted turn",
    );
    // Controlled authority projection only: the writer owner, not Actor creation
    // attribution, determines a later connection. This is not a native handoff or
    // queued-input settlement proof.
    const developer = crypto.randomUUID();
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${developer},'Next native writer',${`${developer}@factory.local`},true)`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${f.projectID},${developer},'developer',${f.userID})`;
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change_writer SET state='human',epoch=epoch+1,turn_id=NULL,user_id=${developer} WHERE change_id=${f.changeID}`;
    });
    const currentRestore = () =>
      sources.restoreEndpoint(
        new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
          headers: {
            authorization: `Bearer ${runtimeConnectorTokens("owned-native-secret", f.attemptID, 1).parent}`,
            "X-Factory-Runtime-Actor-UID": started?.native?.actorUID ?? "",
            "X-Factory-Runtime-Generation": "1",
          },
        }),
        f.attemptID,
      );
    const handed = await currentRestore();
    expect(handed.status).toBe(200);
    expect(await handed.json()).toMatchObject({
      writerEpoch: 1,
      changeWriterEpoch: 3,
      readOnly: false,
    });
    const [creator] = await f.database
      .client`SELECT created_by FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(creator?.["created_by"]).toBe(f.userID);
    await f.database
      .client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${f.projectID} AND user_id=${developer}`;
    await expect(currentRestore()).rejects.toThrow("Developer access required");
  } finally {
    await sources.close();
    await removeRuntimeRepository(f.attemptID);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("independent Source command cannot create a legacy Workspace in an explicitly native Project", async () => {
  const f = await substrateFixture();
  await f.database.client`DELETE FROM factory.development_workspace WHERE id=${f.workspaceID}`;
  const source = createWorkspaceSourceController(
    f.database,
    "owned-native-secret",
    undefined,
    undefined,
    f.projectID,
  );
  try {
    await expect(source.ensurePersonal(f.projectID, f.userID)).rejects.toThrow(
      "No compute or legacy Workspace was created",
    );
    expect(await f.database.client`SELECT id FROM factory.development_workspace`).toHaveLength(0);
    expect(await f.database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      0,
    );
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
  } finally {
    await source.close();
    await f.dispose();
  }
}, 60_000);

test.each([
  "fresh",
  "confirmed",
  "reused",
  "pending-source",
  "running",
  "wrong-attempt",
  "no-observer",
  "wake-race",
  "confirmation-race",
  "implementation-race",
  "stop-race",
] as const)(
  "native paused Stop settles only an exact never-submitted bootstrap: %s",
  async (condition) => {
    const f = await substrateFixture("a".repeat(40), "ticket");
    let observations = 0;
    let requests = 0;
    f.hub.connected = () => false;
    f.hub.request = async () => {
      requests++;
      throw new Error("Paused bootstrap must not send native input or wake compute");
    };
    try {
      const [approval] = await f.database.client<
        { revision: string }[]
      >`SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
      if (!approval) throw new Error("Owned approval fixture missing");
      const { turn } = await createAgentTurnStore(f.database).admit(
        {
          kind: "change-start",
          commandId: crypto.randomUUID(),
          projectId: f.projectID,
          ticketId: f.ticketID,
          changeId: f.changeID,
          createdBy: f.userID,
          conversationId: null,
        },
        {
          mode: "build",
          modelId: "factory-coding-model",
          skillRevisionIds: [],
          requiredSkillRevisionIds: [],
          conversationVersion: null,
          requirementRevisionId: approval.revision,
        },
      );
      const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
      const actorUID = crypto.randomUUID();
      await f.database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
        await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID},true,NULL,NULL)`;
        await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},'{}',${actorUID},now())`;
        await sql`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
        await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned bootstrap',${condition !== "reused"},'Owned native bootstrap',${f.attemptID})`;
        await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'starting',${f.userID},${turn.id},CASE WHEN ${condition === "confirmed"} THEN now() ELSE NULL END)`;
      });
      const view: RuntimeAttemptView = {
        id: condition === "wrong-attempt" ? crypto.randomUUID() : f.attemptID,
        projectId: f.projectID,
        changeId: f.changeID,
        workspaceId: f.workspaceID,
        workspaceKind: "ticket",
        ownerUserId: null,
        generation: "1",
        revision: "a".repeat(40),
        runtimeKind: "ticket",
        state: "paused",
        failure: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        native: {
          engine: "substrate",
          actorUID,
          state: condition === "running" ? "ACTOR_STATE_RUNNING" : "ACTOR_STATE_SUSPENDED",
          coldRestart: true,
          portable: false,
          sourceHandoff: condition === "pending-source" ? "pending" : "confirmed-same-node",
        },
      };
      const observe = async (attemptID: string) => {
        observations++;
        expect(attemptID).toBe(f.attemptID);
        if (condition === "wake-race")
          await f.database
            .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${attemptID}`;
        if (condition === "confirmation-race")
          await f.database
            .client`UPDATE factory.change_agent_session SET native_session_confirmed_at=now() WHERE change_id=${f.changeID}`;
        if (condition === "implementation-race")
          await f.database
            .client`UPDATE factory.change_agent_session SET implementation_session_id=${sessionID},implementation_session_confirmed_at=now() WHERE change_id=${f.changeID}`;
        if (condition === "stop-race")
          await f.database
            .client`UPDATE factory.change_agent_session SET stop_id=${crypto.randomUUID()} WHERE change_id=${f.changeID}`;
        return view;
      };
      const stop = createChangeAgentStop(
        f.database,
        f.hub,
        undefined,
        condition === "no-observer" ? undefined : observe,
      );
      await stop.persist(f.changeID);
      expect(await stop.confirm(f.changeID, undefined, "observe")).toBe(condition === "fresh");
      const [saved] = await f.database.client<
        { pending: boolean }[]
      >`SELECT stop_pending AS pending FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
      expect(saved?.pending).toBe(condition !== "fresh");
      expect(observations).toBe(["confirmed", "reused", "no-observer"].includes(condition) ? 0 : 1);
      expect(requests).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("native Build push and Delivery integration validate their admitted TLS destination before the actual Parent frame", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const previous = {
    api: process.env["FACTORY_FORGEJO_API_URL"],
    public: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
  };
  process.env["FACTORY_FORGEJO_API_URL"] = "http://forgejo.cluster.svc:3000/api/v1/";
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.example";
  const repository = "http://forgejo.cluster.svc:3000/team/project.git";
  const nativeIntent = {
    connectorURL: "wss://factory.example/internal/runtime-connect",
    egressHosts: ["git.example"],
  };
  const frames: unknown[] = [];
  f.hub.parentOperation = async (_id, operation, beforeSend) => {
    await beforeSend?.(() => {
      frames.push(operation);
    });
    return { remoteSHA: "d".repeat(40) };
  };
  try {
    const [approval] = await f.database.client<
      { revision: string }[]
    >`SELECT requirement_revision_id AS revision FROM factory.requirement_approval WHERE ticket_id=${f.ticketID}`;
    if (!approval) throw new Error("Owned approval fixture missing");
    const { turn } = await createAgentTurnStore(f.database).admit(
      {
        kind: "change-start",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        ticketId: f.ticketID,
        changeId: f.changeID,
        createdBy: f.userID,
        conversationId: null,
      },
      {
        mode: "build",
        modelId: "factory-coding-model",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
        conversationVersion: null,
        requirementRevisionId: approval.revision,
      },
    );
    const branch = `factory/change-${f.changeID.replaceAll("-", "").slice(0, 12)}`;
    const sessionID = `ses_owned_${turn.id.replaceAll("-", "")}`;
    const leased = await createAgentTurnStore(f.database).claimPending(turn.id);
    if (!leased?.ownerToken) throw new Error("Owned Build lease missing");
    await f.database.client.begin(async (sql) => {
      await sql`UPDATE factory.project SET repository_url=${repository} WHERE id=${f.projectID}`;
      await sql`INSERT INTO factory.substrate_workspace(workspace_id,intent) VALUES(${f.workspaceID},'{}')`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id) VALUES(${f.attemptID},${f.projectID},${f.workspaceID},${f.changeID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${f.userID},true,NULL,NULL)`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent,actor_uid,create_attempted_at) VALUES(${f.attemptID},${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},${JSON.stringify(nativeIntent)}::jsonb,${crypto.randomUUID()},now())`;
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
      await sql`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
      await sql`UPDATE factory.change_writer SET state='agent',turn_id=${turn.id},user_id=NULL,epoch=epoch+1 WHERE change_id=${f.changeID}`;
      await sql`UPDATE factory.agent_turn SET state='dispatching' WHERE id=${turn.id}`;
      await sql`UPDATE factory.agent_turn SET state='completed',owner_token=NULL,owner_expires_at=NULL WHERE id=${turn.id}`;
      await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id) VALUES(${turn.id},${f.changeID},${sessionID},${`msg_owned_${turn.id.replaceAll("-", "")}`},'Owned Build',true,'Owned native Build',${f.attemptID})`;
      await sql`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at) VALUES(${f.changeID},${f.attemptID},${sessionID},'waiting',${f.userID},${turn.id},now())`;
      await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,commit_message,idempotency_key,state,created_by) VALUES(${turn.id},${f.changeID},${f.attemptID},1,${branch},${"a".repeat(40)},${"d".repeat(40)},'Owned Build',${`owned:${turn.id}`},'push-intended',${f.userID})`;
    });
    const transport = createAgentCommitTransport(f.database, f.hub);
    const push = {
      operationId: turn.id,
      action: "git-push" as const,
      expectedSha: "a".repeat(40),
      commitSha: "d".repeat(40),
      branch,
      repositoryURL: repository,
    };
    await expect(transport(f.attemptID, push)).rejects.toThrow("push destination");
    expect(frames).toHaveLength(0);
    expect(
      await transport(f.attemptID, {
        ...push,
        repositoryURL: "https://git.example/team/project.git",
      }),
    ).toEqual({ remoteSHA: "d".repeat(40) });
    expect(frames).toHaveLength(1);
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://not-admitted.example";
    await expect(
      transport(f.attemptID, {
        ...push,
        repositoryURL: "https://not-admitted.example/team/project.git",
      }),
    ).rejects.toThrow("admitted Forge TLS origin");
    expect(frames).toHaveLength(1);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.example";
    await f.database.client.begin(async (sql) => {
      await sql`UPDATE factory.change_commit_operation SET state='succeeded',observed_remote_sha=commit_sha,completed_at=now() WHERE id=${turn.id}`;
      await sql`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    });
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID)).toBe(true);
    let changeDestination = false;
    f.hub.parentOperation = async (_id, operation, beforeSend) => {
      expect(operation["repositoryURL"]).toBe("https://git.example/team/project.git");
      if (changeDestination)
        await f.database
          .client`UPDATE factory.project SET repository_url='http://forgejo.cluster.svc:3000/team/changed.git' WHERE id=${f.projectID}`;
      await beforeSend?.(() => {
        frames.push(operation);
      });
      return { commitSHA: "f".repeat(40), remoteSHA: "f".repeat(40) };
    };
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async () => {
          throw new Error("Git integration cannot dispatch inference");
        },
      },
      { startPersisted: async () => null },
    );
    expect(await integration.reconcile(f.changeID, "e".repeat(40))).toBe(true);
    expect(frames).toHaveLength(3);
    changeDestination = true;
    expect(await integration.reconcile(f.changeID, "b".repeat(40))).toBe(false);
    expect(frames).toHaveLength(3);
    const [rejected] = await f.database.client<{ state: string; error: string }[]>`
      SELECT state,last_error AS error FROM factory.change_commit_operation
      WHERE change_id=${f.changeID} AND source='integration' ORDER BY sequence DESC LIMIT 1`;
    expect(rejected).toEqual({
      state: "failed",
      error: "Integration destination changed before dispatch.",
    });
  } finally {
    for (const [key, value] of [
      ["FACTORY_FORGEJO_API_URL", previous.api],
      ["FACTORY_FORGEJO_PUBLIC_URL", previous.public],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.dispose();
  }
}, 60_000);

test("fresh isolated work in an explicitly native Project never falls through to legacy capacity or creation", async () => {
  const f = await substrateFixture("a".repeat(40), "ticket");
  let nativeCalls = 0;
  const runtime = f.controller(async () => {
    nativeCalls++;
    throw new Error("Unavailable isolated ownership cannot dispatch native work");
  });
  const verificationID = crypto.randomUUID();
  const preparationID = crypto.randomUUID();
  try {
    await f.database
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,runner_uuid,runner_token,created_by)
      VALUES(${verificationID},${f.changeID},${"d".repeat(40)},1,'owned-native-isolation',${crypto.randomUUID()},'owned-native-runner-token',${f.userID})`;
    await f.database
      .client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version)
      VALUES(${preparationID},${f.projectID},'development',${"a".repeat(40)},0)`;
    for (const start of [
      () => runtime.ensureStaging(f.projectID, f.userID),
      () => runtime.startVerification(verificationID, f.userID),
      () => runtime.startProjectPrebuild(preparationID),
    ])
      await expect(start()).rejects.toThrow("No legacy runtime was created");
    expect(nativeCalls).toBe(0);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    expect(await f.database.client`SELECT id FROM factory.factorybox_worker`).toHaveLength(0);
    expect(
      await f.database.client`SELECT id FROM factory.factorybox_worker_admission`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT attempt_id FROM factory.runtime_compute_wait`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT * FROM factory.verification_compute_placement`,
    ).toHaveLength(0);
    expect(await f.database.client`SELECT * FROM factory.staging_preview`).toHaveLength(0);
    const [verification] = await f.database
      .client`SELECT state,runtime_attempt_id FROM factory.verification WHERE id=${verificationID}`;
    expect(verification).toMatchObject({ state: "pending", runtime_attempt_id: null });
    const [preparation] = await f.database
      .client`SELECT state,runtime_attempt_id FROM factory.project_image_preparation WHERE id=${preparationID}`;
    expect(preparation).toMatchObject({ state: "pending", runtime_attempt_id: null });
  } finally {
    await f.dispose();
  }
}, 60_000);

test("product Stop retains native Source through verified ROOTFS instead of deleting the Actor before handoff", async () => {
  const f = await substrateFixture();
  f.config.deployment = "fresh-workspaces";
  let actor: ReturnType<typeof f.actor> | undefined;
  let deletes = 0;
  const c = f.controller(async (method) => {
    if (method === "GetAtespace") return f.space;
    if (method === "GetActorTemplate") return f.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = f.actor();
      return actor;
    }
    if (method === "ResumeActor" && actor) {
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      return { actor };
    }
    if (method === "SuspendActor" && actor) {
      const uuid = crypto.randomUUID();
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_SUSPENDED",
        lastAssignedGeneration: 1,
        snapshots: [
          {
            uuid,
            generation: 1,
            owner: "SNAPSHOT_OWNER_ACTOR",
            fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
            actorTemplateUid: f.config.templateUID,
            sandboxRuntime: f.config.runtime,
            durableSnapshot: {
              state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
              object: {
                snapshotUri: `s3://owned/prefix/atespaces/${f.atespace}/actors/${actor.metadata.uid}/snapshots/${uuid}`,
              },
            },
          },
        ],
      };
      return { actor: structuredClone(actor) };
    }
    if (method === "DeleteActor") {
      deletes++;
      throw new Error("must not delete product Source");
    }
    throw new Error(`Unexpected ${method}`);
  });
  try {
    await c.start(f.projectID, f.userID);
    await c.status(f.attemptID, "failed", "owned parent preparation failure");
    expect((await c.get(f.attemptID))?.state).toBe("failed");
    expect((await c.stop(f.attemptID))?.state).toBe("paused");
    expect(deletes).toBe(0);
    const [saved] = await f.database
      .client`SELECT deleted_at,checkpoint FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
    expect(saved?.["deleted_at"]).toBeNull();
    expect(saved?.["checkpoint"].fidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
    expect((await c.start(f.projectID, f.userID))?.state).toBe("starting");
    expect(deletes).toBe(0);
  } finally {
    await f.dispose();
  }
}, 60_000);
