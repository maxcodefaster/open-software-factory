import { createHash } from "node:crypto";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import {
  type SubstrateConfiguration,
  substrateActorSelector,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import type { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import {
  personalWorkspaceIdentity,
  ticketWorkspaceIdentity,
} from "../../packages/workspace-domain/src/workspace";
import { ownedPostgresServer, ownedTestDatabase } from "./postgres-server";
import { installOwnedRuntimeConfiguration } from "./runtime-configuration";

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
  const server = await ownedPostgresServer();
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID());
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
    await sql`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,ticket_id,change_id,source_branch,source_revision,created_by,substrate,factorybox_worker_id) VALUES(${workspaceID},${projectID},${kind},${kind === "personal" ? userID : null},${kind === "ticket" ? ticketID : null},${kind === "ticket" ? changeID : null},${branch},${sourceRevision},${userID},true,NULL)`;
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
      workerSelector: { matchLabels: substrateActorSelector("owned-native-secret", attemptID) },
      status: { state: "ACTOR_STATE_SUSPENDED" },
    });
  let controller: ReturnType<typeof createRuntimeController>;
  const hub = new RuntimeHub((id, phase, error) => controller.status(id, phase, error));
  const restore = installOwnedRuntimeConfiguration();
  return {
    database,
    config,
    space,
    template,
    actor,
    userID,
    projectID,
    workspaceID,
    changeID,
    ticketID,
    attemptID,
    atespace,
    hub,
    controller(call?: SubstrateCall, sources?: ReturnType<typeof createSubstrateSources>) {
      const withEgress: SubstrateCall | undefined = call
        ? async (method, request) => {
            if (method === "GetActorEgressPolicy")
              return {
                metadata: metadata("default", crypto.randomUUID(), atespace),
                rules: [
                  { tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } },
                ],
              };
            return call(method, request);
          }
        : undefined;
      controller = createRuntimeController(
        database,
        hub,
        "owned-native-secret",
        {
          substrate: sources,
          async prepareExecution() {
            throw new Error("Native slice cannot prepare legacy Source");
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        config,
        withEgress,
      );
      return controller;
    },
    async dispose() {
      hub.revoke(attemptID);
      restore();
      await database.client.end({ timeout: 1 });
      await target.dispose();
      await server.dispose();
    },
  };
}
