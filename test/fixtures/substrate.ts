import { createHash } from "node:crypto";
import { createCodingRuntimeShutdown } from "../../apps/factory/src/agent/runtime-shutdown";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import {
  createSubstrateExecution,
  type SubstrateConfiguration,
  substrateActorSelector,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/substrate-source";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import {
  personalWorkspaceIdentity,
  ticketWorkspaceIdentity,
} from "../../packages/workspace-domain/src/workspace";
import { ownedPostgresServer, ownedTestDatabase } from "./postgres-server";

export const fixtureRuntime: SubstrateConfiguration["runtime"] = {
  sandboxClass: "gvisor",
  version: {
    schemaVersion: "v1",
    attributes: [
      { key: "architecture", value: "amd64" },
      { key: "sandbox_bundle_hash", value: `sha256:${"a".repeat(64)}` },
    ],
  },
};
export async function substrateFixture(
  sourceRevision = "a".repeat(40),
  kind: "personal" | "ticket" = "personal",
) {
  const inherited = process.env["FACTORY_TEST_POSTGRES"];
  const server = inherited ? undefined : await ownedPostgresServer();
  const identity = inherited ? JSON.parse(inherited) : server?.identity;
  if (!identity) throw new Error("Owned Substrate PostgreSQL identity is missing");
  const target = await ownedTestDatabase(identity, crypto.randomUUID()).catch(async (cause) => {
    await server?.dispose();
    throw cause;
  });
  const prior = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = target.url;
  const database = createDatabase();
  if (prior === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = prior;
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID(),
    changeID = crypto.randomUUID();
  const workspaceID =
    kind === "personal"
      ? personalWorkspaceIdentity(projectID, userID).workspaceID
      : ticketWorkspaceIdentity(changeID).workspaceID;
  const branch =
    kind === "personal" ? "main" : `factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`;
  const attemptID = runtimeIdentity(workspaceID, 1).attemptID;
  const atespace = `fa-${attemptID.replaceAll("-", "")}`,
    name = `runtime-${attemptID.replaceAll("-", "")}`;
  await database.client.begin(async (sql) => {
    await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Native fixture',${`${userID}@factory.local`},true)`;
    await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`native-${projectID}`},'Native fixture','https://example.invalid/fixture.git','main','.devcontainer/devcontainer.json',${userID})`;
    await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${userID},'developer',${userID})`;
    if (kind === "ticket") {
      // Controlled controller-test data only, never a human approval or live acceptance receipt.
      const content = canonicalRequirementContent({
        summary: "Owned native Ticket fence fixture",
        acceptanceCriteria: ["Stale Source writers are rejected"],
        nonGoals: [],
      });
      const revisionID = crypto.randomUUID(),
        approvalID = crypto.randomUUID();
      await sql`INSERT INTO factory.ticket(id,project_id,title,created_by) VALUES(${ticketID},${projectID},'Owned native Ticket fence',${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${userID})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${changeID},${projectID},${ticketID},${approvalID},${branch},${sourceRevision},'active',${userID})`;
      await sql`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at) VALUES(${crypto.randomUUID()},${changeID},'owned','native-ticket',${branch},${sourceRevision},${`native-fixture:${changeID}`},'succeeded',${sourceRevision},now())`;
    }
    await sql`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,ticket_id,change_id,source_branch,source_revision,created_by) VALUES(${workspaceID},${projectID},${kind},${kind === "personal" ? userID : null},${kind === "ticket" ? ticketID : null},${kind === "ticket" ? changeID : null},${branch},${sourceRevision},${userID})`;
  });
  const metadata = (n: string, uid: string, space?: string) => ({
    name: n,
    uid,
    version: "1",
    createTime: new Date().toISOString(),
    ...(space ? { atespace: space } : {}),
  });
  const space = { metadata: metadata(atespace, crypto.randomUUID()) };
  const template = {
    metadata: metadata("runtime", crypto.randomUUID(), atespace),
    snapshotConfig: {
      preferredFidelity: "SNAPSHOT_FIDELITY_ROOTFS",
      goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
    },
  };
  const config: SubstrateConfiguration = {
    deployment: "owned-test",
    database: new URL(target.url).pathname.slice(1),
    projectID,
    workspaceID,
    generation: 1,
    connection: {
      bridge: "/unused-injected-bridge",
      endpoint: "127.0.0.1:1",
      serverName: "api.ate-system.svc",
      caFile: "/unused/ca",
      tokenFile: "/unused/token",
    },
    connectorURL: "wss://factory.test/internal/runtime-connect",
    atespaceUID: space.metadata.uid,
    templateUID: template.metadata.uid,
    templateVersion: "1",
    templateSHA256: substrateTemplateSHA256(template),
    profile: "nightly-20261109-975fb172241c",
    runtime: structuredClone(fixtureRuntime),
  };
  const actor = (uid = crypto.randomUUID()) =>
    nativeActor.parse({
      metadata: metadata(name, uid, atespace),
      actorTemplate: { atespace, name: "runtime" },
      workerSelector: {
        matchLabels:
          config.workerSelector ?? substrateActorSelector("owned-native-secret", attemptID),
      },
      status: { state: "ACTOR_STATE_SUSPENDED" },
    });
  async function createdActor() {
    // Simulated native creation shares the dispatch fact's database clock.
    // Host/VM clock skew must not make a new Actor appear pre-existing.
    const [clock] = await database.client<{ createdAt: string }[]>`
      SELECT clock_timestamp()::text AS "createdAt"`;
    if (!clock) throw Error("Owned native fixture clock is unavailable");
    const created = actor();
    created.metadata.createTime = new Date(clock.createdAt).toISOString();
    return created;
  }
  let controller: ReturnType<typeof createRuntimeController> | undefined;
  const hub = new RuntimeHub(async (id, phase, error) => {
    await controller?.status(id, phase, error);
  });
  const forge = {
    FACTORY_RUNTIME_HOST_IMAGE: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
    FACTORY_BROWSER_TOOLS_IMAGE: `example.invalid/owned-browser@sha256:${"d".repeat(64)}`,
    FACTORY_FORGEJO_API_URL: "http://127.0.0.1:1/api/v1",
    FACTORY_FORGEJO_TOKEN: "owned-mocked-forge-token",
    FACTORY_FORGEJO_OWNER: "owned-runtime-fixture",
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(forge)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return {
    database,
    config,
    space,
    template,
    actor,
    createdActor,
    userID,
    projectID,
    workspaceID,
    changeID,
    ticketID,
    attemptID,
    atespace,
    hub,
    execution(call?: SubstrateCall, sources?: SubstrateSourceHandoff) {
      return createSubstrateExecution(
        database,
        hub,
        "owned-native-secret",
        config,
        createCodingRuntimeShutdown(database, hub),
        call,
        sources,
      );
    },
    async controller(call: SubstrateCall, sources?: SubstrateSourceHandoff) {
      // Controller tests begin with positively observed native provisioning,
      // not an alternate production constructor for prepared Actors. Tests of
      // provisioning itself use the ordinary empty-owner fixture.
      const workerSelector = {
        ...substrateActorSelector("owned-native-secret", attemptID),
        "factory.runtime/profile": config.profile,
        "factory.dev/deployment": "owned",
      };
      config.workerSelector = workerSelector;
      const installation: SubstrateInstallationConfiguration = {
        deployment: config.deployment,
        database: config.database,
        connection: config.connection,
        provisioner: { ...config.connection, tokenFile: "/unused/owner-token" },
        editorPrincipal: "user:system:serviceaccount:owned:factory-control",
        connectorURL: config.connectorURL,
        factoryCAFile: "/unused/factory-ca.pem",
        workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
        profile: config.profile,
        runtime: config.runtime,
        workerSelector,
        egressHosts: config.egressHosts ?? [],
        ...(config.resources ? { resources: config.resources } : {}),
      };
      const policy = {
        metadata: metadata("default", crypto.randomUUID()),
        bindings: [{ role: "editor", members: [installation.editorPrincipal] }],
      };
      const intent = {
        configuration: { ...installation, projectID },
        revision: sourceRevision,
        repositoryURL: "https://example.invalid/fixture.git",
        branch,
        devcontainerPath: ".devcontainer/devcontainer.json",
        templateSHA256: config.templateSHA256,
        environment: config.environment ?? { version: 0, secretKey: null },
        systemContract: {
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
        },
      };
      // Real provisioning retains metadata only, never credential-bearing bootstrap env.
      await database.client`INSERT INTO factory.substrate_workspace(
        workspace_id,intent,atespace_attempted_at,atespace,
        policy_attempted_at,policy,template_attempted_at,template)
        VALUES(${workspaceID},${JSON.stringify(intent)}::text::jsonb,
          ${space.metadata.createTime},${JSON.stringify(space)}::text::jsonb,
          ${policy.metadata.createTime},${JSON.stringify(policy)}::text::jsonb,
          ${template.metadata.createTime},${JSON.stringify({ metadata: template.metadata })}::text::jsonb)`;
      const withEgress: SubstrateCall = async (method, request) => {
        if (method === "GetAtespaceAccessPolicy") return structuredClone(policy);
        if (method === "GetActorEgressPolicy")
          return {
            metadata: metadata("default", crypto.randomUUID(), atespace),
            rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
          };
        return call(method, request);
      };
      controller = createRuntimeController(database, hub, "owned-native-secret", {
        configuration: installation,
        ...(sources ? { sources } : {}),
        call: withEgress,
      });
      return controller;
    },
    async dispose() {
      hub.revoke(attemptID);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await database.client.end({ timeout: 1 });
      await target.dispose();
      await server?.dispose();
    },
  };
}

export async function startSubstrateFixtureWorkspace(
  fixture: Awaited<ReturnType<typeof substrateFixture>>,
) {
  let actor: ReturnType<typeof fixture.actor> | undefined;
  const runtime = await fixture.controller(async (method) => {
    if (method === "GetAtespace") return fixture.space;
    if (method === "GetActorTemplate") return fixture.template;
    if (method === "GetActor") {
      if (!actor) throw new SubstrateRPCError("NotFound", "absent");
      return structuredClone(actor);
    }
    if (method === "CreateActor") {
      actor = await fixture.createdActor();
      return structuredClone(actor);
    }
    if (method === "ResumeActor" && actor) {
      actor.metadata.version = "2";
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: fixture.config.runtime },
      };
      return { actor: structuredClone(actor) };
    }
    throw new Error(`Unexpected controlled native operation ${method}`);
  });
  await runtime.start(fixture.projectID, fixture.userID);
  return runtime;
}
