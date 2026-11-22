import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  desc,
  eq,
  exists,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  changeWriter,
  developmentWorkspace,
  installationMaintenance,
  projectImagePreparation,
  promotionOperation,
  releaseAttempt,
  runtimeAttempt,
  runtimeComputeWait,
  runtimeEnvironmentIntent,
  stagingConfiguration,
  stagingPreview,
  substrateActorRpc,
  substrateBinding,
  substrateInputStop,
  substrateIsolated,
  substrateSource,
  substrateWorkspace,
  verification,
} from "../../../../packages/db/src/schema";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
  runtimeIdentity,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  type NativeActor,
  nativeActor,
  nativeMetadata,
  nativeRuntime,
  nativeSnapshot,
  type SubstrateCall,
  SubstrateRPCError,
  substrateConnection,
} from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { personalWorkspaceIdentity } from "../../../../packages/workspace-domain/src/workspace";
import {
  type CodingRuntimeShutdown,
  type PendingWriterHandoff,
  type RetainedStopTarget,
  requireStoppedAgentInputsIn,
} from "../agent/runtime-api";
import { CommandError } from "../command-error";
import { admitComputeIn } from "../usage/compute";
import { type SubstrateSourceHandoff } from "../workspace/source-api";
import { templateInitialSourceRole } from "../workspace/source-role-fence";
import type { RuntimeHub } from "./hub";
import { trackNativeOperation } from "./native-lock";
import {
  substrateBootstrapContinuationBlocked,
  substrateBootstrapRetentionIn,
  substrateRuntimePrincipalIn,
  substrateTicketSourcePauseIn,
  substrateUnsettledBootstrapIn,
  substrateWorkspaceGrantIn,
  substrateWorkspaceRevisionIn,
} from "./substrate-grant";
import {
  matchesNativeInputStop,
  nativeInputStopAssignment,
  nativeInputStopIn,
  nativeInputStopResult,
} from "./substrate-input-stop";
import { substrateIsolatedGrantIn, substrateIsolatedPrincipalIn } from "./substrate-isolated-grant";
import { substratePrebuildGrantIn, substratePrebuildPrincipalIn } from "./substrate-prebuild-grant";
import { substrateResourceReservation, substrateResources } from "./substrate-resources";
import {
  type ActorRPC,
  actorRPCIn,
  actorRPCOrigin,
  dispatchActorRPCIn,
  intendActorRPCIn,
  observeActorRPCIn,
} from "./substrate-rpc-facts";
import {
  substrateVerificationGrantIn,
  substrateVerificationPrincipalIn,
} from "./substrate-verification-grant";

type Database = ReturnType<typeof createDatabase>;
const configurationSchema = z.strictObject({
  deployment: z.enum(["owned-test", "fresh-workspaces"]),
  database: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  projectID: z.uuid(),
  workspaceID: z.uuid(),
  generation: z.number().int().positive(),
  connection: substrateConnection,
  connectorURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/internal/runtime-connect"
    );
  }, "Native Connector requires an exact WSS Factory endpoint"),
  atespaceUID: z.uuid(),
  templateUID: z.uuid(),
  templateVersion: z.string().regex(/^[1-9][0-9]*$/),
  templateSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.literal("nightly-20261109-975fb172241c"),
  runtime: nativeRuntime,
  resources: substrateResources.optional(),
  workerSelector: z.record(z.string(), z.string()).optional(),
  egressHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).optional(),
  environment: z
    .object({ version: z.number().int().nonnegative(), secretKey: z.string().nullable() })
    .optional(),
  declaredApps: z.array(z.string()).optional(),
});
export type SubstrateConfiguration = z.infer<typeof configurationSchema>;
const verificationConfiguration = configurationSchema
  .omit({ workspaceID: true })
  .extend({ verificationID: z.uuid() });
export type SubstrateVerificationConfiguration = z.infer<typeof verificationConfiguration>;
const prebuildConfiguration = configurationSchema.omit({ workspaceID: true }).extend({
  preparationID: z.uuid(),
  environment: z.object({
    environment: z.enum(["development", "main-preview"]),
    version: z.number().int().nonnegative(),
    secretKey: z.string().nullable(),
  }),
});
export type SubstratePrebuildConfiguration = z.infer<typeof prebuildConfiguration>;
const isolatedConfiguration = configurationSchema.omit({ workspaceID: true }).extend({
  isolatedID: z.uuid(),
  isolatedKind: z.enum(["staging", "publication"]),
  promotionID: z.uuid().nullable(),
  environment: z.object({
    environment: z.enum(["development", "main-preview"]),
    version: z.number().int().nonnegative(),
    secretKey: z.string().nullable(),
  }),
});
export type SubstrateIsolatedConfiguration = z.infer<typeof isolatedConfiguration>;
export function substrateActorSelector(secret: string, attemptID: string) {
  return {
    "factory.dev/binding": createHmac("sha256", secret)
      .update(`substrate-create:${attemptID}`)
      .digest("hex")
      .slice(0, 48),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function substrateTemplateSHA256(value: unknown) {
  const template = z.record(z.string(), z.unknown()).parse(value);
  const { metadata: _metadata, status: _status, ...spec } = template;
  return createHash("sha256")
    .update(JSON.stringify(canonical(spec)))
    .digest("hex");
}
type Binding = {
  intent: (
    | SubstrateConfiguration
    | SubstrateVerificationConfiguration
    | SubstratePrebuildConfiguration
    | SubstrateIsolatedConfiguration
  ) & {
    actorSelector: Record<string, string>;
  };
  atespace: string;
  actorName: string;
  actorUID: string | null;
  attemptedAt: string | null;
  deleting: boolean;
  deleted: boolean;
  createRejected: boolean;
  checkpoint: unknown;
  observation: unknown;
};
export function requireSubstrateActor(
  value: unknown,
  binding: Pick<Binding, "atespace" | "actorName" | "actorUID" | "attemptedAt" | "intent">,
): NativeActor {
  const actor = nativeActor.parse(value);
  if (
    actor.metadata.atespace !== binding.atespace ||
    actor.metadata.name !== binding.actorName ||
    (binding.actorUID !== null && actor.metadata.uid !== binding.actorUID) ||
    actor.actorTemplate.atespace !== binding.atespace ||
    actor.actorTemplate.name !== "runtime" ||
    actor.sourceTag ||
    !isDeepStrictEqual(actor.workerSelector?.matchLabels, binding.intent.actorSelector) ||
    !binding.attemptedAt ||
    Date.parse(actor.metadata.createTime) < Date.parse(binding.attemptedAt)
  )
    throw new Error("Native Actor differs from its immutable create binding");
  if (
    (actor.status.state === "ACTOR_STATE_RUNNING" && !actor.status.workerAssignment) ||
    (actor.status.workerAssignment &&
      !isDeepStrictEqual(actor.status.workerAssignment.sandboxRuntime, binding.intent.runtime))
  )
    throw new Error("Native Actor runtime/profile identity differs from its binding");
  return actor;
}
export function requireDurableROOTFS(
  actor: NativeActor,
  binding: Pick<Binding, "intent" | "atespace" | "actorUID">,
  expected?: {
    uuid: string;
    generation: number;
    durableSnapshot?: { object: { snapshotUri: string } };
  },
) {
  if (actor.metadata.uid !== binding.actorUID || actor.status.state !== "ACTOR_STATE_SUSPENDED")
    throw new Error("Original native Actor is not suspended");
  return requireROOTFSSnapshot(actor, binding, expected);
}

function requireROOTFSSnapshot(
  actor: NativeActor,
  binding: Pick<Binding, "intent" | "atespace" | "actorUID">,
  expected?: {
    uuid: string;
    generation: number;
    durableSnapshot?: { object: { snapshotUri: string } };
  },
) {
  if (actor.metadata.uid !== binding.actorUID)
    throw new Error("ROOTFS snapshot belongs to another native Actor");
  const generation = actor.status.lastAssignedGeneration;
  const snapshots = (actor.status.snapshots ?? []).filter(
    (s) => z.object({ generation: z.number() }).parse(s).generation === generation,
  );
  if (snapshots.length !== 1) throw new Error("Current ROOTFS snapshot generation is unconfirmed");
  const snapshot = nativeSnapshot.parse(snapshots[0]);
  const uri = new URL(snapshot.durableSnapshot.object.snapshotUri);
  if (
    snapshot.actorTemplateUid !== binding.intent.templateUID ||
    !isDeepStrictEqual(snapshot.sandboxRuntime, binding.intent.runtime) ||
    !["s3:", "gs:"].includes(uri.protocol) ||
    uri.search ||
    uri.hash ||
    uri.username ||
    uri.password ||
    !uri.hostname ||
    !uri.pathname.endsWith(
      `/atespaces/${binding.atespace}/actors/${actor.metadata.uid}/snapshots/${snapshot.uuid}`,
    ) ||
    (expected &&
      (expected.uuid !== snapshot.uuid ||
        expected.generation !== snapshot.generation ||
        (expected.durableSnapshot &&
          expected.durableSnapshot.object.snapshotUri !==
            snapshot.durableSnapshot.object.snapshotUri)))
  )
    throw new Error(
      "Durable ROOTFS snapshot identity differs from the original Actor/template/runtime/generation",
    );
  return { actorUID: actor.metadata.uid, templateUID: binding.intent.templateUID, ...snapshot };
}

function requireResumeContinuity(actor: NativeActor, saved: Binding, operation: ActorRPC) {
  if (
    !["ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"].includes(actor.status.state) ||
    !actor.status.workerAssignment ||
    operation.action !== "resume" ||
    !operation.attempted ||
    operation.outcome ||
    operation.actorUID !== saved.actorUID ||
    operation.actorUID !== actor.metadata.uid ||
    operation.originKey !== actorRPCOrigin(saved.checkpoint) ||
    !isDeepStrictEqual(operation.originCheckpoint, saved.checkpoint) ||
    BigInt(actor.metadata.version) <= BigInt(operation.nativeVersion)
  )
    throw new Error("Native Resume continuation differs from its original dispatched allocation");
  if (saved.checkpoint === null) {
    if (actor.status.lastAssignedGeneration || actor.status.snapshots?.length)
      throw new Error("Initial native Resume acquired an unrecorded checkpoint");
  } else {
    requireROOTFSSnapshot(actor, saved, nativeSnapshot.parse(saved.checkpoint));
  }
}

const recordedPauseSnapshot = nativeSnapshot.extend({
  durableSnapshot: nativeSnapshot.shape.durableSnapshot.extend({
    state: z.enum(["SNAPSHOT_STORAGE_STATE_PENDING", "SNAPSHOT_STORAGE_STATE_COMPLETED"]),
  }),
});

function requireRecordedPause(actor: NativeActor, saved: Binding) {
  const snapshots = (actor.status.snapshots ?? []).filter(
    (value) =>
      z.object({ generation: z.number() }).parse(value).generation ===
      actor.status.lastAssignedGeneration,
  );
  if (snapshots.length !== 1) throw new Error("Recorded ROOTFS pause generation is unconfirmed");
  // Pinned Substrate resumes a SUSPENDING workflow using this same persisted
  // snapshot. PENDING permits that continuation, never Source handoff or Resume.
  const progress = recordedPauseSnapshot.safeParse(snapshots[0]);
  if (!progress.success)
    throw new CommandError(
      "unavailable",
      "Recorded native pause identity is unconfirmed; no operation was repeated",
    );
  const snapshot = progress.data;
  const uri = new URL(snapshot.durableSnapshot.object.snapshotUri);
  const previous = saved.checkpoint ? nativeSnapshot.parse(saved.checkpoint) : null;
  if (
    snapshot.actorTemplateUid !== saved.intent.templateUID ||
    !isDeepStrictEqual(snapshot.sandboxRuntime, saved.intent.runtime) ||
    !["s3:", "gs:"].includes(uri.protocol) ||
    uri.search ||
    uri.hash ||
    uri.username ||
    uri.password ||
    !uri.hostname ||
    !uri.pathname.endsWith(
      `/atespaces/${saved.atespace}/actors/${actor.metadata.uid}/snapshots/${snapshot.uuid}`,
    ) ||
    snapshot.generation !== (previous?.generation ?? 0) + 1
  )
    throw new Error("Recorded ROOTFS pause identity/generation differs from its original binding");
  return snapshot;
}

function retainedPauseProgress(saved: Binding) {
  const observed = nativeActor.safeParse(saved.observation);
  const previous = saved.checkpoint ? nativeSnapshot.parse(saved.checkpoint) : null;
  if (
    !observed.success ||
    observed.data.status.lastAssignedGeneration !== (previous?.generation ?? 0) + 1
  )
    return undefined;
  return requireRecordedPause(observed.data, saved);
}

function requirePauseContinuity(actor: NativeActor, saved: Binding) {
  const retained = retainedPauseProgress(saved);
  const current =
    retained !== undefined || actor.status.state === "ACTOR_STATE_SUSPENDING"
      ? requireRecordedPause(actor, saved)
      : undefined;
  if (
    retained &&
    current &&
    (retained.uuid !== current.uuid ||
      retained.generation !== current.generation ||
      retained.durableSnapshot.object.snapshotUri !== current.durableSnapshot.object.snapshotUri ||
      (retained.durableSnapshot.state === "SNAPSHOT_STORAGE_STATE_COMPLETED" &&
        current.durableSnapshot.state !== "SNAPSHOT_STORAGE_STATE_COMPLETED"))
  )
    throw new Error("Recorded native pause snapshot changed during continuation");
}

// One concrete facade. Substrate owns transitions; Factory retains only its
// existing Attempt intent, an immutable native binding, and observed outcomes.
// Construction performs no database writes or external calls.
export function createSubstrateExecution(
  database: Database,
  hub: RuntimeHub,
  secret: string,
  input:
    | SubstrateConfiguration
    | SubstrateVerificationConfiguration
    | SubstratePrebuildConfiguration
    | SubstrateIsolatedConfiguration,
  shutdownCoding: CodingRuntimeShutdown,
  rpc?: SubstrateCall,
  sources?: SubstrateSourceHandoff,
) {
  const config = z
    .union([
      configurationSchema,
      verificationConfiguration,
      prebuildConfiguration,
      isolatedConfiguration,
    ])
    .parse(input);
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native proof requires its explicitly owned database");
  const call = rpc ?? createSubstrateControl(config.connection);
  const workspaceID = "workspaceID" in config ? config.workspaceID : undefined;
  const verificationID = "verificationID" in config ? config.verificationID : undefined;
  const preparationID = "preparationID" in config ? config.preparationID : undefined;
  const isolated = "isolatedID" in config ? config : undefined;
  if ((verificationID || preparationID || isolated) && sources)
    throw new Error("Isolated execution cannot own canonical Source");
  const ownerID = workspaceID ?? verificationID ?? preparationID ?? isolated?.isolatedID;
  if (!ownerID) throw new Error("Native execution owner is missing");
  const attemptID = runtimeIdentity(ownerID, config.generation).attemptID;
  const atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const actorName = `runtime-${attemptID.replaceAll("-", "")}`;
  const ref = { atespace, name: actorName };
  const tokens = runtimeConnectorTokens(secret, attemptID, config.generation);
  const retainedIntent = {
    ...config,
    actorSelector: config.workerSelector ?? substrateActorSelector(secret, attemptID),
  };
  const endpoint = new URL(config.connectorURL);
  const egressRules = [
    {
      tlsPassthrough: {
        hostnames: [...new Set([endpoint.hostname, ...(config.egressHosts ?? [])])],
        ports: { numbers: [Number(endpoint.port || 443)] },
      },
    },
  ];
  async function egress() {
    let value: unknown;
    try {
      value = await call("GetActorEgressPolicy", { actor: ref, name: "default" });
    } catch (error) {
      if (!(error instanceof SubstrateRPCError) || error.code !== "NotFound") throw error;
      value = await call("CreateActorEgressPolicy", {
        actor: ref,
        egressPolicy: { metadata: { atespace, name: "default" }, rules: egressRules },
      });
    }
    const policy = z.object({ metadata: nativeMetadata, rules: z.unknown() }).parse(value);
    if (
      policy.metadata.atespace !== atespace ||
      policy.metadata.name !== "default" ||
      !isDeepStrictEqual(policy.rules, egressRules)
    )
      throw new Error("Native Connector egress differs from its pinned restricted policy");
  }
  async function binding(sql: Database["client"] | DatabaseTransaction = database.client) {
    const [row] = await drizzleTransaction(sql)
      .select({
        intent: substrateBinding.intent,
        atespace: substrateBinding.atespace,
        actorName: substrateBinding.actorName,
        actorUID: substrateBinding.actorUid,
        attemptedAt: expression<string | null>`${substrateBinding.createAttemptedAt}::text`,
        createRejected: substrateBinding.createRejected,
        stopping: expression<boolean>`${runtimeAttempt.stopIntendedAt} IS NOT NULL`,
        deleting: expression<boolean>`${substrateBinding.deleteIntendedAt} IS NOT NULL`,
        deleted: expression<boolean>`${substrateBinding.deletedAt} IS NOT NULL`,
        checkpoint: substrateBinding.checkpoint,
        observation: substrateBinding.observation,
      })
      .from(substrateBinding)
      .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, substrateBinding.runtimeAttemptId))
      .where(eq(substrateBinding.runtimeAttemptId, attemptID));
    if (!row || !isDeepStrictEqual(row.intent, retainedIntent))
      throw new Error("Native current configuration differs from immutable binding");
    return { ...row, intent: retainedIntent };
  }
  function locked<T>(action: (sql: Database["client"]) => Promise<T>) {
    return trackNativeOperation(
      (async () => {
        const sql = database.coordination();
        try {
          await sql`SELECT pg_advisory_lock(hashtext(${`runtime:${ownerID}`}))`;
          const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
          if (db?.name !== config.database)
            throw new Error("Native adapter is limited to its explicitly owned database");
          return await action(sql);
        } finally {
          try {
            await sql`SELECT pg_advisory_unlock(hashtext(${`runtime:${ownerID}`}))`;
          } finally {
            await sql.end({ timeout: 1 });
          }
        }
      })(),
    );
  }
  async function profile() {
    const space = z
      .object({ metadata: nativeMetadata })
      .parse(await call("GetAtespace", { atespace: { name: atespace } }));
    const template = z
      .object({
        metadata: nativeMetadata,
        snapshotConfig: z
          .object({
            preferredFidelity: z.literal("SNAPSHOT_FIDELITY_ROOTFS"),
            goldenSnapshotConfig: z
              .object({ mode: z.literal("GOLDEN_SNAPSHOT_MODE_DISABLED") })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(await call("GetActorTemplate", { actorTemplate: { atespace, name: "runtime" } }));
    if (
      space.metadata.name !== atespace ||
      space.metadata.uid !== config.atespaceUID ||
      template.metadata.atespace !== atespace ||
      template.metadata.name !== "runtime" ||
      template.metadata.uid !== config.templateUID ||
      template.metadata.version !== config.templateVersion ||
      substrateTemplateSHA256(template) !== config.templateSHA256
    )
      throw new Error("Native Atespace/template/profile binding changed");
    return template;
  }
  async function getActor() {
    try {
      return await call("GetActor", { actor: ref });
    } catch (error) {
      if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
      throw error;
    }
  }
  async function remember(
    sql: Database["client"] | DatabaseTransaction,
    saved: Binding,
    value: unknown,
  ) {
    const actor = requireSubstrateActor(value, saved);
    const old = saved.observation ? nativeActor.parse(saved.observation) : null;
    if (old && BigInt(actor.metadata.version) < BigInt(old.metadata.version))
      throw new Error("Stale native resource version");
    // Validate before replacing the retained observation. A rejected native
    // substitution must not become the next read's trusted progress.
    requirePauseContinuity(actor, saved);
    if (["ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"].includes(actor.status.state)) {
      const resumed = await actorRPCIn(sql, attemptID, "resume", actorRPCOrigin(saved.checkpoint));
      if (resumed?.attempted && !resumed.outcome) requireResumeContinuity(actor, saved, resumed);
    }
    const result = await drizzleTransaction(sql)
      .update(substrateBinding)
      .set({
        actorUid: expression`COALESCE(${substrateBinding.actorUid},${actor.metadata.uid}::uuid)`,
        observation: actor,
      })
      .where(
        and(
          eq(substrateBinding.runtimeAttemptId, attemptID),
          isNull(substrateBinding.deletedAt),
          or(isNull(substrateBinding.actorUid), eq(substrateBinding.actorUid, actor.metadata.uid)),
        ),
      )
      .returning({ attemptID: substrateBinding.runtimeAttemptId });
    if (result.length !== 1) throw new Error("Native current Actor UID binding changed");
    return actor;
  }
  function allow(uid: string) {
    hub.allow(
      attemptID,
      config.generation,
      hashConnectorToken(tokens.parent),
      hashConnectorToken(tokens.child),
      uid,
    );
  }
  async function observe(sql: Database["client"] | DatabaseTransaction, saved: Binding) {
    if (saved.createRejected)
      throw new Error("Native Create was rejected; an existing Actor is never adopted");
    await profile();
    const value = await getActor();
    if (!value) throw new Error("Original native Actor not observed; create is never replayed");
    const actor = await remember(sql, saved, value);
    if (actor.status.state === "ACTOR_STATE_RUNNING") {
      const resumed = await actorRPCIn(sql, attemptID, "resume", actorRPCOrigin(saved.checkpoint));
      if (resumed?.attempted && !resumed.outcome)
        await observeActorRPCIn(sql, attemptID, resumed, actor);
    }
    if (
      (verificationID || workspaceID) &&
      ["ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"].includes(actor.status.state)
    ) {
      const db = drizzleTransaction(sql);
      await db.delete(runtimeComputeWait).where(
        and(
          eq(runtimeComputeWait.attemptId, attemptID),
          eq(runtimeComputeWait.reason, "compute-capacity"),
          exists(
            db
              .select({ id: runtimeAttempt.id })
              .from(runtimeAttempt)
              .where(
                and(
                  eq(runtimeAttempt.id, runtimeComputeWait.attemptId),
                  inArray(runtimeAttempt.state, ["starting", "ready"]),
                  isNull(runtimeAttempt.stopIntendedAt),
                ),
              ),
          ),
        ),
      );
    }
    return actor;
  }
  async function inputStopVersion() {
    // Provisioning retains metadata only. Read bootstrap capability from the
    // native owner after its exact UID/version/spec-hash checks. Its credential-
    // bearing environment is never persisted or returned.
    const template = z
      .object({
        containers: z.array(
          z.object({ env: z.array(z.object({ name: z.string(), value: z.string() })) }),
        ),
      })
      .safeParse(await profile());
    const entries = template.success
      ? template.data.containers
          .flatMap((container) => container.env)
          .filter((env) => env.name === "FACTORY_SUBSTRATE_BOOTSTRAP")
      : [];
    if (entries.length !== 1) return null;
    try {
      const bootstrap = z
        .object({
          sourceHandoff: z.literal(true),
          inputStop: z.object({
            version: z.literal(1),
            openCodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
          }),
        })
        .safeParse(JSON.parse(entries[0]?.value ?? "null"));
      return bootstrap.success ? bootstrap.data.inputStop.openCodeVersion : null;
    } catch {
      return null;
    }
  }
  async function currentGrant(sql: Database["client"], userID: string, newExecution = false) {
    return sql.begin(async (tx) => {
      if (preparationID)
        return substratePrebuildGrantIn(tx, config.projectID, preparationID, attemptID, userID);
      if (verificationID)
        return substrateVerificationGrantIn(
          tx,
          config.projectID,
          verificationID,
          attemptID,
          userID,
        );
      if (isolated)
        return substrateIsolatedGrantIn(tx, config.projectID, isolated, attemptID, userID);
      if (!workspaceID) throw new Error("Native Workspace identity is missing");
      const workspace = await substrateWorkspaceGrantIn(
        database,
        tx,
        workspaceID,
        userID,
        newExecution,
      );
      if (workspace.projectID !== config.projectID)
        throw new CommandError("forbidden", "Native Workspace Project differs from its grant");
      return workspace;
    });
  }
  async function retainedBootstrap(sql: Database["client"]) {
    if (config.deployment !== "fresh-workspaces" || !workspaceID || !sources) return false;
    return Boolean(await substrateBootstrapRetentionIn(sql, workspaceID, attemptID));
  }
  async function retainedTicketPause(sql: Database["client"]) {
    return workspaceID && sources
      ? sql.begin((transaction) => substrateTicketSourcePauseIn(transaction, attemptID))
      : null;
  }
  async function requireSettledBootstrap(sql: Database["client"], saved: Binding, generation = 0) {
    if (
      (saved.checkpoint || generation > 0) &&
      ((await retainedBootstrap(sql)) ||
        (config.deployment === "fresh-workspaces" &&
          workspaceID &&
          sources &&
          (await substrateUnsettledBootstrapIn(sql, workspaceID, attemptID))))
    )
      throw new CommandError("conflict", substrateBootstrapContinuationBlocked);
  }
  async function requireInitialVerificationResumeIn(
    sql: DatabaseTransaction,
    saved: Binding,
    actor: NativeActor,
    operation: ActorRPC,
    userID: string,
  ) {
    if (
      !verificationID ||
      workspaceID ||
      saved.deleting ||
      saved.deleted ||
      saved.checkpoint !== null ||
      operation.action !== "resume" ||
      !operation.attempted ||
      operation.outcome ||
      operation.originKey !== "initial" ||
      operation.originCheckpoint !== null ||
      operation.stopID !== null ||
      operation.actorUID !== saved.actorUID ||
      actor.metadata.uid !== operation.actorUID ||
      actor.metadata.version !== operation.nativeVersion ||
      actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
      actor.status.workerAssignment ||
      actor.status.lastAssignedGeneration ||
      actor.status.snapshots?.length ||
      actor.sourceTag !== undefined ||
      (await actorRPCIn(sql, attemptID, "suspend", "initial"))
    )
      throw new CommandError(
        "unavailable",
        "Initial native Verification Resume differs from its original unassigned Actor",
      );
    await substrateVerificationGrantIn(sql, config.projectID, verificationID, attemptID, userID);
    const db = drizzleTransaction(sql);
    const [current] = await db
      .select({ id: runtimeAttempt.id })
      .from(runtimeAttempt)
      .innerJoin(verification, eq(verification.id, runtimeAttempt.verificationId))
      .innerJoin(change, eq(change.id, verification.changeId))
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          eq(runtimeAttempt.projectId, config.projectID),
          eq(runtimeAttempt.verificationId, verificationID),
          eq(runtimeAttempt.isolatedKind, "verification"),
          isNull(runtimeAttempt.workspaceId),
          isNull(runtimeAttempt.changeId),
          eq(runtimeAttempt.generation, config.generation),
          eq(runtimeAttempt.revision, verification.commitSha),
          eq(runtimeAttempt.state, "starting"),
          isNull(runtimeAttempt.readyAt),
          isNull(runtimeAttempt.stopIntendedAt),
          inArray(verification.state, ["pending", "runner-starting"]),
          eq(verification.runtimeAttemptId, runtimeAttempt.id),
          eq(
            verification.commitSha,
            db
              .select({ commitSHA: changeCommitOperation.commitSha })
              .from(changeCommitOperation)
              .where(
                and(
                  eq(changeCommitOperation.changeId, change.id),
                  eq(changeCommitOperation.state, "succeeded"),
                ),
              )
              .orderBy(desc(changeCommitOperation.sequence))
              .limit(1),
          ),
        ),
      );
    if (!current)
      throw new CommandError(
        "conflict",
        "Current never-started exact-commit Verification is required for native continuation",
      );
  }
  async function requireCapacityWorkspaceResumeIn(
    sql: DatabaseTransaction,
    saved: Binding,
    actor: NativeActor,
    operation: ActorRPC,
    userID: string,
    waiting: boolean,
  ) {
    const origin = actorRPCOrigin(saved.checkpoint);
    if (
      !workspaceID ||
      saved.deleting ||
      saved.deleted ||
      operation.action !== "resume" ||
      !operation.attempted ||
      operation.outcome ||
      operation.stopID !== null ||
      operation.originKey !== origin ||
      !isDeepStrictEqual(operation.originCheckpoint, saved.checkpoint) ||
      operation.actorUID !== saved.actorUID ||
      actor.metadata.uid !== operation.actorUID ||
      actor.metadata.version !== operation.nativeVersion ||
      actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
      actor.status.workerAssignment ||
      actor.sourceTag !== undefined ||
      (await actorRPCIn(sql, attemptID, "suspend", origin))
    )
      throw new CommandError(
        "unavailable",
        "Native capacity continuation differs from its original unassigned Workspace",
      );
    if (saved.checkpoint)
      requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
    else if (actor.status.lastAssignedGeneration || actor.status.snapshots?.length)
      throw new CommandError("unavailable", "Initial Workspace acquired an unrecorded checkpoint");
    const db = drizzleTransaction(sql);
    const newer = alias(runtimeAttempt, "newer");
    const [current] = await db
      .select({ id: runtimeAttempt.id })
      .from(runtimeAttempt)
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          eq(runtimeAttempt.workspaceId, workspaceID),
          eq(runtimeAttempt.projectId, config.projectID),
          eq(runtimeAttempt.generation, config.generation),
          eq(runtimeAttempt.state, "starting"),
          isNull(runtimeAttempt.stopIntendedAt),
          or(expression`${saved.checkpoint !== null}`, isNull(runtimeAttempt.readyAt)),
          notExists(
            db
              .select({ id: newer.id })
              .from(newer)
              .where(
                and(
                  eq(newer.workspaceId, runtimeAttempt.workspaceId),
                  gt(newer.generation, runtimeAttempt.generation),
                ),
              ),
          ),
          or(
            expression`NOT ${waiting}`,
            exists(
              db
                .select({ attemptID: runtimeComputeWait.attemptId })
                .from(runtimeComputeWait)
                .where(
                  and(
                    eq(runtimeComputeWait.attemptId, runtimeAttempt.id),
                    eq(runtimeComputeWait.reason, "compute-capacity"),
                  ),
                ),
            ),
          ),
        ),
      );
    if (!current)
      throw new CommandError(
        "unavailable",
        "Recorded native Resume remains unconfirmed; its RPC was not repeated",
      );
    await substrateWorkspaceGrantIn(database, sql, workspaceID, userID, true);
    if (sources) {
      const [source] = await db
        .select({ workspaceID: substrateSource.workspaceId })
        .from(substrateSource)
        .where(
          and(
            eq(substrateSource.workspaceId, workspaceID),
            eq(substrateSource.actorUid, operation.actorUID),
            eq(substrateSource.owner, "actor"),
            eq(substrateSource.writable, true),
            isNull(substrateSource.checkpointId),
          ),
        );
      if (!source)
        throw new CommandError(
          "unavailable",
          "Capacity continuation requires its unchanged original Source owner",
        );
    }
  }
  async function resumeActorIn(
    sql: Database["client"],
    saved: Binding,
    before: NativeActor,
    userID: string | null,
    stopID?: string,
    signal?: AbortSignal,
  ) {
    if (before.status.state === "ACTOR_STATE_SUSPENDED") {
      const actual =
        saved.checkpoint || before.status.lastAssignedGeneration
          ? requireDurableROOTFS(before, saved)
          : null;
      if (actual && actual.uuid !== actorRPCOrigin(saved.checkpoint)) {
        const pausing = await actorRPCIn(
          sql,
          attemptID,
          "suspend",
          actorRPCOrigin(saved.checkpoint),
        );
        if (!pausing?.attempted)
          throw new CommandError(
            "unavailable",
            "Native checkpoint has no recorded Pause; no Resume was dispatched",
          );
        // A positive completed native pause can finish its saved Source handoff
        // before this deliberate new Resume. No checkpoint RPC is repeated.
        await suspendIn(sql);
        saved = await binding(sql);
        before = await observe(sql, saved);
      }
    }
    const origin = actorRPCOrigin(saved.checkpoint);
    if (["ACTOR_STATE_RUNNING", "ACTOR_STATE_RESUMING"].includes(before.status.state)) {
      if (await actorRPCIn(sql, attemptID, "suspend", origin))
        throw new CommandError(
          "unavailable",
          "Recorded native Pause remains unconfirmed; its RPC was not repeated",
        );
      const recorded = await actorRPCIn(sql, attemptID, "resume", origin);
      if (!recorded?.attempted)
        throw new CommandError(
          "unavailable",
          "Native allocation has no recorded Resume; no operation was repeated",
        );
      if (before.status.state === "ACTOR_STATE_RESUMING" && userID && !stopID) {
        requireResumeContinuity(before, saved, recorded);
        if (recorded.stopID)
          throw new CommandError(
            "conflict",
            "A Stop-only Resume cannot authorize ordinary execution",
          );
        const requireCurrentStart = async () => {
          const db = drizzleTransaction(sql);
          const newer = alias(runtimeAttempt, "newer");
          const [current] = await db
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.id, attemptID),
                eq(runtimeAttempt.state, "starting"),
                isNull(runtimeAttempt.stopIntendedAt),
                notExists(
                  db
                    .select({ id: newer.id })
                    .from(newer)
                    .where(
                      and(
                        eq(newer.workspaceId, runtimeAttempt.workspaceId),
                        gt(newer.generation, runtimeAttempt.generation),
                      ),
                    ),
                ),
              ),
            );
          if (!current)
            throw new CommandError("conflict", "Original native startup is no longer current");
        };
        await requireCurrentStart();
        await currentGrant(sql, userID, true);
        await egress();
        if (signal?.aborted) return before;
        await currentGrant(sql, userID, true);
        await requireCurrentStart();
        // The pinned official workflow re-enters under its native Actor lease.
        // Keep the original dispatch/checkpoint/Source facts; do not transfer
        // Source again or issue a Create, hook or inference request here.
        allow(before.metadata.uid);
        await call("ResumeActor", { actor: ref });
        return observe(sql, await binding(sql));
      }
      if (saved.actorUID) allow(saved.actorUID);
      return before;
    }
    if (before.status.state !== "ACTOR_STATE_SUSPENDED")
      throw new CommandError(
        "unavailable",
        "Native Resume outcome is unsettled; its RPC was not repeated",
      );
    const operation = await intendActorRPCIn(
      sql,
      attemptID,
      "resume",
      saved.checkpoint,
      before,
      stopID,
    );
    if (operation.attempted) {
      if (!userID || stopID)
        throw new CommandError("conflict", "Current native execution authority is required");
      await sql.begin((tx) =>
        workspaceID
          ? requireCapacityWorkspaceResumeIn(tx, saved, before, operation, userID, true)
          : requireInitialVerificationResumeIn(tx, saved, before, operation, userID),
      );
    }
    if (userID) await currentGrant(sql, userID, true);
    if (workspaceID && !operation.attempted) await sources?.resume(workspaceID, attemptID, sql);
    await egress();
    if (signal?.aborted) return before;
    if (userID) await currentGrant(sql, userID, true);
    await sql.begin(async (tx) => {
      if (stopID) {
        const stopped = await nativeInputStopIn(tx, attemptID, stopID);
        const [source] = await drizzleTransaction(tx)
          .select({
            id: expression<string>`${substrateSource.checkpoint}->>'id'`,
            epoch: substrateSource.writerEpoch,
          })
          .from(substrateSource)
          .where(
            and(
              eq(substrateSource.workspaceId, workspaceID ?? expression`NULL`),
              eq(substrateSource.actorUid, before.metadata.uid),
              eq(substrateSource.owner, "actor"),
              eq(substrateSource.writable, true),
              isNotNull(substrateSource.checkpoint),
            ),
          );
        if (!stopped || !source) throw new Error("Native Stop Source transfer is unconfirmed");
        await drizzleTransaction(tx)
          .update(substrateInputStop)
          .set({
            sourceCheckpointId: source.id,
            sourceWriterEpoch: source.epoch,
            resumeAttemptedAt: expression`now()`,
          })
          .where(
            and(
              eq(substrateInputStop.stopId, stopID),
              isNull(substrateInputStop.resumeAttemptedAt),
            ),
          );
      }
      if (operation.attempted) {
        if (!userID)
          throw new CommandError("conflict", "Current native execution authority is required");
        // The official workflow can reject worker assignment without advancing
        // the Actor. Continue only the unchanged allocation under current
        // authority, keeping the first dispatch and Source transfer facts.
        if (workspaceID) {
          await requireCapacityWorkspaceResumeIn(tx, saved, before, operation, userID, true);
          // A confirmed refusal permits one continuation, not retries after an
          // unknown later reply. Only another confirmed capacity rejection
          // below may publish a new wait for this same dispatch.
          await drizzleTransaction(tx)
            .delete(runtimeComputeWait)
            .where(
              and(
                eq(runtimeComputeWait.attemptId, attemptID),
                eq(runtimeComputeWait.reason, "compute-capacity"),
              ),
            );
        } else await requireInitialVerificationResumeIn(tx, saved, before, operation, userID);
      } else await dispatchActorRPCIn(tx, attemptID, operation);
      await drizzleTransaction(tx)
        .update(runtimeAttempt)
        .set({ state: "starting", failure: null, updatedAt: expression`now()` })
        .where(and(eq(runtimeAttempt.id, attemptID), isNull(runtimeAttempt.stopIntendedAt)));
    });
    allow(before.metadata.uid);
    try {
      await call("ResumeActor", { actor: ref });
    } catch (cause) {
      if (
        (verificationID || workspaceID) &&
        userID &&
        !stopID &&
        cause instanceof SubstrateRPCError &&
        cause.code === "ResourceExhausted"
      ) {
        let waiting = false;
        try {
          const currentBinding = await binding(sql);
          const actor = await observe(sql, currentBinding);
          await sql.begin(async (tx) => {
            const dispatched = await actorRPCIn(
              tx,
              attemptID,
              "resume",
              actorRPCOrigin(currentBinding.checkpoint),
            );
            if (!dispatched) return;
            if (workspaceID)
              await requireCapacityWorkspaceResumeIn(
                tx,
                currentBinding,
                actor,
                dispatched,
                userID,
                false,
              );
            else
              await requireInitialVerificationResumeIn(
                tx,
                currentBinding,
                actor,
                dispatched,
                userID,
              );
            const db = drizzleTransaction(tx);
            await db
              .insert(runtimeComputeWait)
              .values({ attemptId: attemptID, reason: "compute-capacity" })
              .onConflictDoNothing({ target: runtimeComputeWait.attemptId });
            const [hold] = await db
              .select({ reason: runtimeComputeWait.reason })
              .from(runtimeComputeWait)
              .where(eq(runtimeComputeWait.attemptId, attemptID));
            waiting = hold?.reason === "compute-capacity";
          });
        } catch {
          // A lost observation, newer candidate, callback or Stop cannot turn
          // the rejected call into success or overwrite its original failure.
        }
        if (waiting && workspaceID)
          throw new CommandError(
            "unavailable",
            "Waiting for execution capacity; no worker has room for this Workspace yet. Its original compute and files are retained.",
          );
      }
      throw cause;
    }
    return observe(sql, await binding(sql));
  }
  async function suspendIn(sql: Database["client"]) {
    const saved = await binding(sql);
    if (saved.stopping || saved.deleting || saved.deleted)
      throw new Error("Native Actor is stopping");
    const before = await observe(sql, saved);
    const [recorded] = await drizzleTransaction(sql)
      .select({ state: runtimeAttempt.state })
      .from(runtimeAttempt)
      .where(eq(runtimeAttempt.id, attemptID));
    const reentering =
      before.status.state === "ACTOR_STATE_SUSPENDING" && recorded?.state === "pausing";
    if (
      !["ACTOR_STATE_RUNNING", "ACTOR_STATE_SUSPENDED"].includes(before.status.state) &&
      !reentering
    )
      throw new CommandError(
        "unavailable",
        "Native pause outcome is unsettled; no operation was repeated",
      );
    const completing =
      before.status.state === "ACTOR_STATE_SUSPENDED" &&
      (recorded?.state === "pausing" || recorded?.state === "paused");
    const retainedProgress = reentering || completing ? retainedPauseProgress(saved) : undefined;
    const continuation = reentering ? requireRecordedPause(before, saved) : retainedProgress;
    // A disconnected initial Parent cannot prove workload liveness. An already
    // completed durable pause can be reconciled without another checkpoint.
    const bootstrap = await retainedBootstrap(sql);
    const unsettledInitial =
      bootstrap ||
      Boolean(
        workspaceID &&
          sources &&
          (await substrateUnsettledBootstrapIn(sql, workspaceID, attemptID)),
      );
    if (unsettledInitial && !completing && !reentering && !hub.sourceConnected(attemptID))
      throw new CommandError(
        "unavailable",
        "Initial Source is unavailable. No native checkpoint was dispatched because workload liveness and Source handoff are unconfirmed.",
      );
    const retainBootstrap = bootstrap && completing;
    const inputStop = workspaceID ? await nativeInputStopIn(sql, attemptID) : null;
    if (inputStop?.snapshotAttempted && !completing && !reentering)
      throw new CommandError(
        "unavailable",
        "Recorded Stop-only native pause is unconfirmed; its snapshot RPC was not repeated",
      );
    const origin = actorRPCOrigin(saved.checkpoint);
    let operation = await actorRPCIn(sql, attemptID, "suspend", origin);
    if (reentering) {
      if (
        !continuation ||
        !operation?.attempted ||
        operation.outcome ||
        operation.actorUID !== before.metadata.uid ||
        operation.stopID !== (inputStop?.stopID ?? null) ||
        BigInt(before.metadata.version) <= BigInt(operation.nativeVersion)
      )
        throw new CommandError(
          "unavailable",
          "Native pause continuation requires its original dispatched Actor and checkpoint",
        );
      if (retainedProgress) {
        if (
          retainedProgress.uuid !== continuation.uuid ||
          retainedProgress.generation !== continuation.generation ||
          retainedProgress.durableSnapshot.object.snapshotUri !==
            continuation.durableSnapshot.object.snapshotUri ||
          (retainedProgress.durableSnapshot.state === "SNAPSHOT_STORAGE_STATE_COMPLETED" &&
            continuation.durableSnapshot.state !== "SNAPSHOT_STORAGE_STATE_COMPLETED")
        )
          throw new Error("Recorded native pause snapshot changed during continuation");
      }
    } else if (!completing) {
      if (operation?.attempted)
        throw new CommandError(
          "unavailable",
          "Recorded native Pause remains unconfirmed; its RPC was not repeated",
        );
      const resumed = await actorRPCIn(sql, attemptID, "resume", origin);
      if (!resumed?.attempted || !resumed.outcome)
        throw new CommandError("unavailable", "Native Pause requires its recorded original Resume");
      operation = await intendActorRPCIn(
        sql,
        attemptID,
        "suspend",
        saved.checkpoint,
        before,
        inputStop?.stopID,
      );
    }
    if (completing && !operation?.attempted)
      requireDurableROOTFS(before, saved, nativeSnapshot.parse(saved.checkpoint));
    if (completing && operation?.attempted && !operation.outcome)
      requireRecordedPause(before, saved);
    await drizzleTransaction(sql)
      .update(runtimeAttempt)
      .set({ state: "pausing", updatedAt: expression`now()` })
      .where(and(eq(runtimeAttempt.id, attemptID), isNull(runtimeAttempt.stopIntendedAt)));
    if (workspaceID && !retainBootstrap) await sources?.freezeActor(workspaceID, attemptID, sql);
    hub.revoke(attemptID);
    if (!completing && !reentering) {
      if (!operation) throw new Error("Native Pause dispatch intent is unavailable");
      const dispatch = operation;
      await sql.begin(async (tx) => {
        await dispatchActorRPCIn(tx, attemptID, dispatch);
        if (inputStop)
          await drizzleTransaction(tx)
            .update(substrateInputStop)
            .set({ snapshotAttemptedAt: expression`now()` })
            .where(
              and(
                eq(substrateInputStop.stopId, inputStop.stopID),
                isNull(substrateInputStop.snapshotAttemptedAt),
              ),
            );
      });
      operation = { ...dispatch, attempted: true };
    }
    // A completed observation needs no RPC. Only a pinned server-side
    // SUSPENDING workflow may re-enter native Suspend, which continues its
    // existing snapshot under Substrate's Actor lease rather than minting one.
    const returned = completing
      ? before
      : requireSubstrateActor(
          z.object({ actor: nativeActor }).parse(
            await call("SuspendActor", {
              actor: ref,
              options: { mode: "DURABILITY_MODE_SYNCHRONOUS" },
            }),
          ).actor,
          { ...saved, actorUID: before.metadata.uid },
        );
    const returnedSnapshot = requireDurableROOTFS(
      returned,
      { ...saved, actorUID: before.metadata.uid },
      continuation,
    );
    if (operation?.attempted && completing && returnedSnapshot.uuid === operation.originKey)
      throw new Error("Native Pause did not produce its next ROOTFS checkpoint");
    const actor = await observe(sql, await binding(sql));
    const checkpoint = requireDurableROOTFS(
      actor,
      { ...saved, actorUID: before.metadata.uid },
      returnedSnapshot,
    );
    if (
      before.status.state === "ACTOR_STATE_RUNNING" &&
      checkpoint.generation <= (before.status.lastAssignedGeneration ?? 0)
    )
      throw new Error("Suspend did not produce the next snapshot generation");
    // Independent Get established COMPLETED. Keep the last good checkpoint
    // on every rejection; a native reply alone cannot release Source.
    const dispatched = operation;
    await sql.begin(async (tx) => {
      const db = drizzleTransaction(tx);
      await db
        .update(substrateBinding)
        .set({ checkpoint })
        .where(eq(substrateBinding.runtimeAttemptId, attemptID));
      await db
        .update(runtimeAttempt)
        .set({
          state: "paused",
          failure: expression`CASE WHEN ${runtimeAttempt.readyAt} IS NULL THEN ${runtimeAttempt.failure} ELSE NULL END`,
          updatedAt: expression`now()`,
        })
        .where(and(eq(runtimeAttempt.id, attemptID), isNull(runtimeAttempt.stopIntendedAt)));
      if (dispatched?.attempted && !dispatched.outcome)
        await observeActorRPCIn(tx, attemptID, dispatched, actor, checkpoint);
    });
    if (workspaceID && !retainBootstrap) await sources?.makeIndependent(workspaceID, sql);
  }
  async function stopHandoffIn(sql: Database["client"]) {
    if (!workspaceID) return undefined;
    // Recover only the already commissioned handoff, never grant a new writer.
    const [pending] = await drizzleTransaction(sql)
      .select({
        turnID: changeWriter.turnId,
        epoch: expression<string>`${changeWriter.epoch}::text`,
      })
      .from(changeWriter)
      .innerJoin(runtimeAttempt, eq(runtimeAttempt.changeId, changeWriter.changeId))
      .where(
        and(
          eq(runtimeAttempt.id, attemptID),
          isNotNull(runtimeAttempt.stopIntendedAt),
          eq(changeWriter.state, "agent-preparing"),
          eq(changeWriter.fenceAttemptId, attemptID),
          eq(changeWriter.fenceRequired, true),
        ),
      );
    return pending?.turnID ? { turnID: pending.turnID, epoch: pending.epoch } : undefined;
  }
  async function stopIn(sql: Database["client"], handoff?: PendingWriterHandoff) {
    let saved = await binding(sql);
    const db = drizzleTransaction(sql);
    if (!saved.deleted) {
      handoff ??= await stopHandoffIn(sql);
      if (workspaceID) await requireStoppedAgentInputsIn(sql, attemptID, handoff);
      // Final Stop is durable before Source export. It can only continue cleanup.
      await db
        .update(runtimeAttempt)
        .set({
          stopIntendedAt: expression`COALESCE(${runtimeAttempt.stopIntendedAt},now())`,
          state: "stopping",
          updatedAt: expression`now()`,
        })
        .where(eq(runtimeAttempt.id, attemptID));
      await shutdownCoding(attemptID);
      hub.suspend(attemptID);
      if (workspaceID && config.deployment === "fresh-workspaces") {
        if (!sources || !saved.actorUID)
          throw new CommandError(
            "unavailable",
            "Workspace Stop requires its confirmed Source owner; the original Actor was retained",
          );
        if (!saved.deleting) {
          await observe(sql, saved);
          // Keep the original Parent available only for its fenced Source export.
          // A fresh bootstrap cannot fetch its Environment under final Stop intent.
          allow(saved.actorUID);
          await sources.freezeActor(workspaceID, attemptID, sql);
          await sources.makeIndependent(workspaceID, sql);
        }
        await sources.requireIndependent(workspaceID, saved.actorUID, sql);
      }
      await db
        .update(substrateBinding)
        .set({
          deleteIntendedAt: expression`COALESCE(${substrateBinding.deleteIntendedAt},now())`,
        })
        .where(eq(substrateBinding.runtimeAttemptId, attemptID));
      hub.revoke(attemptID);
      saved = await binding(sql);
      if (workspaceID) await requireStoppedAgentInputsIn(sql, attemptID, handoff);
      await profile();
      const value = await getActor();
      if (value) {
        if (!saved.actorUID)
          throw new Error("Delete requires previously observed original Actor UID");
        const actor = await remember(sql, saved, value);
        await call("DeleteActor", {
          actor: ref,
          options: { uid: saved.actorUID, version: actor.metadata.version },
        });
        if (await getActor()) throw new Error("Native Delete has not completed");
      } else if (!saved.actorUID)
        throw new Error(
          "Unknown create outcome retained; absent Actor without an original UID is not confirmed deletion",
        );
      await db
        .update(substrateBinding)
        .set({ deletedAt: expression`now()` })
        .where(
          and(eq(substrateBinding.runtimeAttemptId, attemptID), isNull(substrateBinding.deletedAt)),
        );
    }
    // A crash after confirmed Delete must still complete the saved Stop outcome.
    await db
      .update(runtimeAttempt)
      .set({
        state: "stopped",
        stoppedAt: expression`COALESCE(${runtimeAttempt.stoppedAt},now())`,
        updatedAt: expression`now()`,
      })
      .where(and(eq(runtimeAttempt.id, attemptID), expression`${runtimeAttempt.state}<>'stopped'`));
  }
  async function completeInputStopIn(sql: Database["client"], stopID: string) {
    const changed = await drizzleTransaction(sql)
      .update(substrateInputStop)
      .set({
        completedAt: expression`now()`,
        completedCheckpoint: substrateBinding.checkpoint,
        completedSourceCheckpointId: expression`(${substrateSource.checkpoint}->>'id')::uuid`,
      })
      .from(substrateBinding)
      .innerJoin(substrateSource, expression`true`)
      .where(
        and(
          eq(substrateInputStop.stopId, stopID),
          eq(substrateInputStop.runtimeAttemptId, attemptID),
          eq(substrateBinding.runtimeAttemptId, substrateInputStop.runtimeAttemptId),
          eq(substrateSource.workspaceId, substrateInputStop.workspaceId),
          isNull(substrateInputStop.completedAt),
        ),
      )
      .returning({ stopID: substrateInputStop.stopId });
    if (changed.length !== 1)
      throw new Error("Native Stop completion lost its exact Source/snapshot binding");
  }
  return {
    matchesProject: (id: string) => id === config.projectID,
    matchesAttempt: (id: string) => id === attemptID,
    // The maintenance caller holds the installation fence and this Workspace's
    // transaction lock. This permits retaining a paused input across an upgrade,
    // not confirming Stop or dispatching any cleanup, lifecycle or inference.
    async pausedStopRetainedIn(sql: DatabaseTransaction, stopID: string) {
      const db = drizzleTransaction(sql);
      const newer = alias(runtimeAttempt, "newer");
      const [retained] = await db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .innerJoin(
          developmentWorkspace,
          and(
            eq(developmentWorkspace.id, runtimeAttempt.workspaceId),
            eq(developmentWorkspace.projectId, runtimeAttempt.projectId),
            eq(developmentWorkspace.changeId, runtimeAttempt.changeId),
            eq(developmentWorkspace.kind, "ticket"),
          ),
        )
        .innerJoin(
          change,
          and(
            eq(change.id, runtimeAttempt.changeId),
            eq(change.runtimeAttemptId, runtimeAttempt.id),
          ),
        )
        .innerJoin(
          changeAgentSession,
          and(
            eq(changeAgentSession.changeId, change.id),
            eq(changeAgentSession.runtimeAttemptId, runtimeAttempt.id),
          ),
        )
        .innerJoin(
          changeAgentTurnIntent,
          and(
            eq(changeAgentTurnIntent.turnId, changeAgentSession.stopTurnId),
            eq(changeAgentTurnIntent.changeId, change.id),
            eq(changeAgentTurnIntent.runtimeAttemptId, runtimeAttempt.id),
            eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
            isNotNull(changeAgentTurnIntent.promptId),
          ),
        )
        .innerJoin(
          agentTurn,
          and(eq(agentTurn.id, changeAgentTurnIntent.turnId), eq(agentTurn.changeId, change.id)),
        )
        .innerJoin(substrateSource, eq(substrateSource.workspaceId, developmentWorkspace.id))
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            eq(runtimeAttempt.state, "paused"),
            isNull(runtimeAttempt.stopIntendedAt),
            exists(
              db
                .select({ singleton: installationMaintenance.singleton })
                .from(installationMaintenance)
                .where(
                  and(
                    eq(installationMaintenance.singleton, true),
                    eq(installationMaintenance.enabled, true),
                  ),
                ),
            ),
            eq(changeAgentSession.state, "stopped"),
            eq(changeAgentSession.stopPending, true),
            eq(changeAgentSession.stopId, stopID),
            isNotNull(changeAgentSession.nativeSessionConfirmedAt),
            inArray(agentTurn.state, ["failed", "stopped", "completed"]),
            eq(substrateSource.owner, "service"),
            eq(substrateSource.writable, true),
            isNotNull(substrateSource.serviceBase),
            gt(substrateSource.generation, 0),
            isNotNull(substrateSource.checkpoint),
            notExists(
              db
                .select({ stopID: substrateInputStop.stopId })
                .from(substrateInputStop)
                .where(eq(substrateInputStop.runtimeAttemptId, runtimeAttempt.id)),
            ),
            notExists(
              db
                .select({ attemptID: substrateActorRpc.runtimeAttemptId })
                .from(substrateActorRpc)
                .where(
                  and(
                    eq(substrateActorRpc.runtimeAttemptId, runtimeAttempt.id),
                    isNull(substrateActorRpc.outcome),
                  ),
                ),
            ),
            notExists(
              db
                .select({ id: newer.id })
                .from(newer)
                .where(
                  and(
                    eq(newer.workspaceId, developmentWorkspace.id),
                    gt(newer.generation, runtimeAttempt.generation),
                  ),
                ),
            ),
          ),
        );
      if (!retained) return false;
      const saved = await binding(sql);
      if (saved.deleting || saved.deleted || !saved.actorUID || !saved.checkpoint) return false;
      const actor = await observe(sql, saved);
      requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
      const [source] = await db
        .select({ workspaceID: substrateSource.workspaceId })
        .from(substrateSource)
        .where(
          and(
            eq(substrateSource.workspaceId, workspaceID ?? expression`NULL`),
            eq(substrateSource.actorUid, actor.metadata.uid),
            eq(substrateSource.owner, "service"),
            eq(substrateSource.writable, true),
            isNotNull(substrateSource.serviceBase),
            gt(substrateSource.generation, 0),
            expression`${substrateSource.checkpoint}->>'actorUID'=${actor.metadata.uid}`,
            expression`${substrateSource.checkpoint}->>'workspaceID'=${substrateSource.workspaceId}::text`,
            expression`(${substrateSource.checkpoint}->>'generation')::bigint=${substrateSource.generation}`,
            expression`(${substrateSource.checkpoint}->>'writerEpoch')::bigint<${substrateSource.writerEpoch}`,
          ),
        );
      return Boolean(source && (await inputStopVersion()));
    },
    async supportsInitialSourceRole(sql: DatabaseTransaction) {
      return trackNativeOperation(
        (async () => {
          if (!workspaceID || config.generation !== 1 || config.deployment !== "fresh-workspaces")
            return false;
          const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
          if (db?.name !== config.database)
            throw new Error("Native adapter is limited to its explicitly owned database");
          const saved = await binding(sql);
          if (saved.deleting || saved.deleted || !saved.actorUID || saved.checkpoint) return false;
          const [provision] = await drizzleTransaction(sql)
            .select({
              workloadImage: expression<
                string | null
              >`${substrateWorkspace.intent}#>>'{configuration,workloadImage}'`,
            })
            .from(substrateWorkspace)
            .where(
              and(
                eq(substrateWorkspace.workspaceId, workspaceID),
                eq(substrateWorkspace.generation, 1),
              ),
            );
          if (!provision?.workloadImage) return false;
          // The caller already owns the runtime try-lock. Do not acquire another
          // connection/lock here. Native reads validate UID/version/full spec hash.
          return templateInitialSourceRole(await profile(), {
            workspaceID,
            attemptID,
            projectID: config.projectID,
            workloadImage: provision.workloadImage,
          });
        })(),
      );
    },
    async settleInputStop(target: RetainedStopTarget, signal: AbortSignal) {
      if (!workspaceID || !sources || target.attemptID !== attemptID || signal.aborted)
        return false;
      const progress = await locked(async (sql) => {
        let operation = await nativeInputStopIn(sql, attemptID, target.stopID);
        if (
          operation &&
          (operation.changeID !== target.changeID ||
            operation.assignment.sessionID !== target.sessionID ||
            operation.assignment.promptID !== target.promptID)
        )
          return "pending";
        const saved = await binding(sql);
        if (saved.deleting || saved.deleted || !saved.actorUID) return "pending";
        const actor = await observe(sql, saved);
        if (operation?.completed) {
          requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
          await sources.requireIndependent(workspaceID, saved.actorUID, sql);
          return "complete";
        }
        if (!operation) {
          if (
            target.mode === "observe" ||
            actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
            !saved.checkpoint
          )
            return "pending";
          requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
          await sources.requireIndependent(workspaceID, saved.actorUID, sql);
          const [scope] = await drizzleTransaction(sql)
            .select({ modelID: expression<string>`${agentTurn.authority}->>'modelId'` })
            .from(changeAgentSession)
            .innerJoin(
              changeAgentTurnIntent,
              eq(changeAgentTurnIntent.turnId, changeAgentSession.stopTurnId),
            )
            .innerJoin(agentTurn, eq(agentTurn.id, changeAgentTurnIntent.turnId))
            .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
            .where(
              and(
                eq(changeAgentSession.changeId, target.changeID),
                eq(changeAgentSession.state, "stopped"),
                eq(changeAgentSession.stopPending, true),
                eq(changeAgentSession.stopId, target.stopID),
                eq(changeAgentSession.runtimeAttemptId, attemptID),
                eq(changeAgentSession.opencodeSessionId, target.sessionID),
                eq(changeAgentTurnIntent.runtimeAttemptId, attemptID),
                eq(changeAgentTurnIntent.sessionId, target.sessionID),
                eq(changeAgentTurnIntent.promptId, target.promptID),
              ),
            );
          if (!scope) return "pending";
          const version = await inputStopVersion();
          if (!version) return "pending";
          const assignment = nativeInputStopAssignment.parse({
            stopID: target.stopID,
            attemptID,
            sessionID: target.sessionID,
            promptID: target.promptID,
            modelID: scope.modelID,
            version,
            mode: "interrupt",
          });
          await drizzleTransaction(sql).insert(substrateInputStop).values({
            stopId: target.stopID,
            runtimeAttemptId: attemptID,
            workspaceId: workspaceID,
            changeId: target.changeID,
            actorUid: saved.actorUID,
            assignment,
            checkpoint: saved.checkpoint,
          });
          operation = await nativeInputStopIn(sql, attemptID, target.stopID);
        }
        if (!operation) return "pending";
        if (!operation.resumed) {
          // Admission above is durable before closing the independently editable
          // Source. Export its latest offline edits, not the original pause copy.
          if (target.mode === "observe" || actor.status.state !== "ACTOR_STATE_SUSPENDED")
            return "pending";
          requireDurableROOTFS(actor, saved, nativeSnapshot.parse(operation.checkpoint));
          // This is the original Actor and its admitted Stop-only cold branch.
          // The recorded RPC is never replayed after an uncertain response.
          await resumeActorIn(sql, saved, actor, null, target.stopID, signal);
          return signal.aborted ? "pending" : "working";
        }
        if (actor.status.state === "ACTOR_STATE_RUNNING") {
          allow(operation.actorUID);
          return "working";
        }
        if (
          operation.result &&
          ["ACTOR_STATE_SUSPENDED", "ACTOR_STATE_SUSPENDING"].includes(actor.status.state)
        ) {
          await suspendIn(sql);
          if (operation.result.confirmed) {
            await completeInputStopIn(sql, target.stopID);
            return "complete";
          }
          return "pending";
        }
        return "pending";
      });
      if (progress === "complete") return true;
      if (progress !== "working" || signal.aborted) return false;
      // The wakeup probe confirms Stop-only admission before the metadata
      // engine finishes. Observe its existing Source transport briefly, with
      // no second Resume; the normal Stop observer retains longer outcomes.
      for (
        let observation = 0;
        observation < 5 && !signal.aborted && !hub.sourceConnected(attemptID);
        observation++
      )
        await Bun.sleep(1000);
      if (signal.aborted || !hub.sourceConnected(attemptID)) return false;
      let result: z.infer<typeof nativeInputStopResult> | null = null;
      const existing = await nativeInputStopIn(database.client, attemptID, target.stopID);
      if (!existing) return false;
      result = existing.result;
      if (!result) {
        try {
          const response = await hub.parentOperation(attemptID, {
            operationId: target.stopID,
            action: "input-stop-result",
          });
          const parsed = nativeInputStopResult.safeParse(JSON.parse(response.data ?? "null"));
          if (parsed.success && matchesNativeInputStop(existing.assignment, parsed.data))
            result = parsed.data;
        } catch {
          /* An unknown result never confirms Stop. Source may still be safely paused. */
        }
      }
      if (!result) return false;
      const observedResult = result;
      return locked(async (sql) => {
        const operation = await nativeInputStopIn(sql, attemptID, target.stopID);
        if (!operation || signal.aborted) return false;
        if (operation.completed) return true;
        if (observedResult)
          await drizzleTransaction(sql)
            .update(substrateInputStop)
            .set({ result: observedResult })
            .where(
              and(eq(substrateInputStop.stopId, target.stopID), isNull(substrateInputStop.result)),
            );
        await suspendIn(sql);
        if (!observedResult.confirmed) return false;
        await completeInputStopIn(sql, target.stopID);
        return true;
      });
    },
    async recover() {
      return locked(async (sql) => {
        const [present] = await drizzleTransaction(sql)
          .select({ attemptID: substrateBinding.runtimeAttemptId })
          .from(substrateBinding)
          .where(eq(substrateBinding.runtimeAttemptId, attemptID));
        if (!present) return;
        const saved = await binding(sql);
        if (saved.deleting || saved.stopping) return stopIn(sql);
        if (saved.deleted || !saved.attemptedAt) return;
        const actor = await observe(sql, saved);
        if (actor.status.state === "ACTOR_STATE_RESUMING") {
          const principal = await sql.begin((tx) =>
            preparationID
              ? substratePrebuildPrincipalIn(tx, attemptID)
              : verificationID
                ? substrateVerificationPrincipalIn(tx, attemptID)
                : isolated
                  ? substrateIsolatedPrincipalIn(tx, attemptID)
                  : substrateRuntimePrincipalIn(tx, attemptID, Boolean(workspaceID && sources)),
          );
          await resumeActorIn(sql, saved, actor, principal);
          return;
        }
        if (["ACTOR_STATE_SUSPENDING", "ACTOR_STATE_SUSPENDED"].includes(actor.status.state)) {
          const [pausing] = await drizzleTransaction(sql)
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.id, attemptID),
                eq(runtimeAttempt.state, "pausing"),
                isNull(runtimeAttempt.stopIntendedAt),
              ),
            );
          // Continue only the recorded native Pause, not an uncertain Resume or
          // inference. suspendIn requires its original dispatch and snapshot,
          // and still independently confirms durability before Source handoff.
          if (pausing) await suspendIn(sql);
          return;
        }
        if (actor.status.state !== "ACTOR_STATE_RUNNING") return;
        if (await nativeInputStopIn(sql, attemptID)) {
          allow(actor.metadata.uid);
          return;
        }
        if (await retainedTicketPause(sql)) {
          allow(actor.metadata.uid);
          // Admission precedes reconnect. Only the authenticated, advertising
          // original Parent can continue this same checkpoint after it returns.
          if (hub.sourceConnected(attemptID)) await suspendIn(sql);
          return;
        }
        const db = drizzleTransaction(sql);
        const [attempt] = await db
          .select({ userID: runtimeAttempt.createdBy })
          .from(runtimeAttempt)
          .where(
            and(
              eq(runtimeAttempt.id, attemptID),
              or(
                inArray(runtimeAttempt.state, ["starting", "ready"]),
                and(
                  expression`${Boolean(workspaceID && sources)}`,
                  inArray(runtimeAttempt.state, ["failed", "pausing"]),
                  exists(
                    db
                      .select({ workspaceID: developmentWorkspace.id })
                      .from(developmentWorkspace)
                      .innerJoin(
                        substrateSource,
                        eq(substrateSource.workspaceId, developmentWorkspace.id),
                      )
                      .innerJoin(
                        substrateBinding,
                        and(
                          eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id),
                          eq(substrateBinding.actorUid, substrateSource.actorUid),
                        ),
                      )
                      .where(
                        and(
                          eq(developmentWorkspace.id, runtimeAttempt.workspaceId),
                          eq(developmentWorkspace.kind, "personal"),
                          eq(substrateSource.owner, "actor"),
                          or(
                            and(isNull(runtimeAttempt.readyAt), isNotNull(runtimeAttempt.failure)),
                            and(
                              eq(runtimeAttempt.state, "pausing"),
                              isNotNull(runtimeAttempt.readyAt),
                              eq(substrateSource.writable, false),
                              isNotNull(substrateSource.checkpointId),
                            ),
                          ),
                        ),
                      ),
                  ),
                ),
              ),
              isNull(runtimeAttempt.stopIntendedAt),
            ),
          );
        if (!attempt) return;
        const principal = await sql.begin((tx) =>
          preparationID
            ? substratePrebuildPrincipalIn(tx, attemptID)
            : verificationID
              ? substrateVerificationPrincipalIn(tx, attemptID)
              : isolated
                ? substrateIsolatedPrincipalIn(tx, attemptID)
                : substrateRuntimePrincipalIn(tx, attemptID, Boolean(workspaceID && sources)),
        );
        await currentGrant(sql, principal);
        allow(actor.metadata.uid);
      });
    },
    async start(userID: string) {
      return locked(async (sql) => {
        const workspace = await currentGrant(sql, userID);
        if (
          workspaceID &&
          !workspace.changeID &&
          (!("ownerID" in workspace) ||
            !workspace.ownerID ||
            personalWorkspaceIdentity(config.projectID, workspace.ownerID).workspaceID !==
              workspaceID)
        )
          throw new CommandError("forbidden", "Native owned Workspace identity differs");
        const [existing] = await drizzleTransaction(sql)
          .select({ attemptID: substrateBinding.runtimeAttemptId })
          .from(substrateBinding)
          .where(eq(substrateBinding.runtimeAttemptId, attemptID));
        if (!existing) {
          const [prior] = await drizzleTransaction(sql)
            .select({
              id: runtimeAttempt.id,
              generation: runtimeAttempt.generation,
              state: runtimeAttempt.state,
              actorUID: substrateBinding.actorUid,
              deleted: expression<boolean>`${substrateBinding.deletedAt} IS NOT NULL`,
            })
            .from(runtimeAttempt)
            .leftJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
            .where(
              or(
                workspaceID ? eq(runtimeAttempt.workspaceId, workspaceID) : undefined,
                eq(runtimeAttempt.id, attemptID),
              ),
            )
            .orderBy(desc(runtimeAttempt.generation))
            .limit(1);
          if (prior) {
            const [retained] =
              workspaceID && sources && prior.actorUID
                ? await drizzleTransaction(sql)
                    .select({ workspaceID: substrateSource.workspaceId })
                    .from(substrateSource)
                    .innerJoin(
                      substrateWorkspace,
                      and(
                        eq(substrateWorkspace.workspaceId, substrateSource.workspaceId),
                        eq(substrateWorkspace.generation, config.generation),
                      ),
                    )
                    .where(
                      and(
                        eq(substrateSource.workspaceId, workspaceID),
                        eq(substrateSource.actorUid, prior.actorUID),
                        eq(substrateSource.owner, "service"),
                        eq(substrateSource.writable, true),
                        isNotNull(substrateSource.checkpoint),
                      ),
                    )
                : [];
            if (
              !retained ||
              prior.id === attemptID ||
              prior.generation + 1 !== config.generation ||
              prior.state !== "stopped" ||
              !prior.deleted
            )
              throw new Error(
                "Native Workspace successor requires confirmed cleanup and independent Source",
              );
          } else if (workspaceID && config.generation !== 1)
            throw new Error("Native Workspace begins with generation one");
          await sql.begin(async (tx) => {
            const db = drizzleTransaction(tx);
            if (verificationID) {
              const grant = await substrateVerificationGrantIn(
                tx,
                config.projectID,
                verificationID,
                attemptID,
                userID,
              );
              await admitComputeIn(tx, config.projectID, substrateResourceReservation(config));
              await db.insert(runtimeAttempt).values({
                id: attemptID,
                projectId: config.projectID,
                verificationId: verificationID,
                isolatedKind: "verification",
                generation: config.generation,
                revision: grant.revision,
                state: "create-intended",
                parentConnectorTokenHash: hashConnectorToken(tokens.parent),
                childConnectorTokenHash: hashConnectorToken(tokens.child),
                createIntendedAt: expression`now()`,
                createdBy: userID,
              });
              await db
                .update(verification)
                .set({
                  runtimeAttemptId: attemptID,
                  state: "runner-starting",
                  updatedAt: expression`now()`,
                })
                .where(
                  and(eq(verification.id, verificationID), isNull(verification.runtimeAttemptId)),
                );
            } else if (preparationID) {
              const grant = await substratePrebuildGrantIn(
                tx,
                config.projectID,
                preparationID,
                attemptID,
                userID,
              );
              await admitComputeIn(tx, config.projectID, substrateResourceReservation(config));
              await db.insert(runtimeAttempt).values({
                id: attemptID,
                projectId: config.projectID,
                isolatedKind: "prebuild",
                generation: config.generation,
                revision: grant.revision,
                state: "create-intended",
                parentConnectorTokenHash: hashConnectorToken(tokens.parent),
                childConnectorTokenHash: hashConnectorToken(tokens.child),
                createIntendedAt: expression`now()`,
                createdBy: userID,
              });
              await db
                .update(projectImagePreparation)
                .set({
                  runtimeAttemptId: attemptID,
                  state: "running",
                  updatedAt: expression`now()`,
                })
                .where(
                  and(
                    eq(projectImagePreparation.id, preparationID),
                    isNull(projectImagePreparation.runtimeAttemptId),
                  ),
                );
            } else if (isolated) {
              const grant = await substrateIsolatedGrantIn(
                tx,
                config.projectID,
                isolated,
                attemptID,
                userID,
              );
              await admitComputeIn(tx, config.projectID, substrateResourceReservation(config));
              await db.insert(runtimeAttempt).values({
                id: attemptID,
                projectId: config.projectID,
                isolatedKind: isolated.isolatedKind,
                generation: config.generation,
                revision: grant.revision,
                state: "create-intended",
                parentConnectorTokenHash: hashConnectorToken(tokens.parent),
                childConnectorTokenHash: hashConnectorToken(tokens.child),
                createIntendedAt: expression`now()`,
                createdBy: userID,
              });
              if (isolated.isolatedKind === "publication") {
                const linked = await db
                  .update(releaseAttempt)
                  .set({ runtimeAttemptId: attemptID })
                  .where(
                    and(
                      eq(releaseAttempt.id, isolated.isolatedID),
                      isNull(releaseAttempt.runtimeAttemptId),
                      eq(releaseAttempt.state, "running"),
                    ),
                  )
                  .returning({ id: releaseAttempt.id });
                if (linked.length !== 1)
                  throw new Error("Publication execution owner changed before binding");
              } else if (isolated.promotionID) {
                const linked = await db
                  .update(promotionOperation)
                  .set({
                    replacementRuntimeAttemptId: attemptID,
                    state: "starting",
                    updatedAt: expression`now()`,
                  })
                  .where(
                    and(
                      eq(promotionOperation.id, isolated.promotionID),
                      isNull(promotionOperation.replacementRuntimeAttemptId),
                      eq(promotionOperation.state, "pending"),
                    ),
                  )
                  .returning({ id: promotionOperation.id });
                if (linked.length !== 1)
                  throw new Error("Promotion execution owner changed before binding");
              } else {
                const predecessor = alias(runtimeAttempt, "predecessor");
                const linked = await db
                  .update(stagingPreview)
                  .set({ runtimeAttemptId: attemptID, updatedAt: expression`now()` })
                  .where(
                    and(
                      eq(stagingPreview.projectId, config.projectID),
                      eq(stagingPreview.revision, grant.revision),
                      or(
                        isNull(stagingPreview.runtimeAttemptId),
                        exists(
                          db
                            .select({ id: predecessor.id })
                            .from(predecessor)
                            .innerJoin(
                              substrateBinding,
                              eq(substrateBinding.runtimeAttemptId, predecessor.id),
                            )
                            .where(
                              and(
                                eq(predecessor.id, stagingPreview.runtimeAttemptId),
                                eq(predecessor.state, "stopped"),
                                isNotNull(substrateBinding.deletedAt),
                              ),
                            ),
                        ),
                      ),
                    ),
                  )
                  .returning({ projectID: stagingPreview.projectId });
                if (linked.length !== 1) throw new Error("Staging Preview changed before binding");
              }
              if (isolated.isolatedKind === "staging") {
                const [provision] = await db
                  .select({
                    declaration: expression<unknown>`${substrateIsolated.intent}->'declaration'`,
                  })
                  .from(substrateIsolated)
                  .where(eq(substrateIsolated.runtimeAttemptId, attemptID));
                await db.insert(stagingConfiguration).values({
                  runtimeAttemptId: attemptID,
                  declaration: provision?.declaration,
                });
              }
            } else {
              if (!workspaceID) throw new Error("Native Workspace identity is missing");
              const grant = await substrateWorkspaceGrantIn(
                database,
                tx,
                workspaceID,
                userID,
                true,
              );
              const revision = await substrateWorkspaceRevisionIn(tx, workspaceID);
              const [provision] = await db
                .select({ revision: expression<string>`${substrateWorkspace.intent}->>'revision'` })
                .from(substrateWorkspace)
                .where(
                  and(
                    eq(substrateWorkspace.workspaceId, workspaceID),
                    eq(substrateWorkspace.generation, config.generation),
                  ),
                );
              if (provision && provision.revision !== revision)
                throw new CommandError(
                  "conflict",
                  "Workspace execution revision differs from its native provisioning intent",
                );
              await admitComputeIn(tx, config.projectID, substrateResourceReservation(config));
              await db.insert(runtimeAttempt).values({
                id: attemptID,
                projectId: grant.projectID,
                workspaceId: workspaceID,
                changeId: grant.changeID,
                generation: config.generation,
                revision,
                state: "create-intended",
                parentConnectorTokenHash: hashConnectorToken(tokens.parent),
                childConnectorTokenHash: hashConnectorToken(tokens.child),
                createIntendedAt: expression`now()`,
                createdBy: userID,
              });
            }
            await db.insert(substrateBinding).values({
              runtimeAttemptId: attemptID,
              atespace,
              actorName,
              intent: retainedIntent,
            });
            if (config.environment)
              await db.insert(runtimeEnvironmentIntent).values({
                runtimeAttemptId: attemptID,
                environment:
                  "preparationID" in config || "isolatedID" in config
                    ? config.environment.environment
                    : "development",
                version: config.environment.version,
                secretKey: config.environment.secretKey,
              });
            if (config.declaredApps)
              await db
                .update(runtimeAttempt)
                .set({ declaredApps: config.declaredApps })
                .where(eq(runtimeAttempt.id, attemptID));
            if (workspace.changeID)
              await db
                .update(change)
                .set({
                  runtimeAttemptId: attemptID,
                  state: "starting",
                  failure: null,
                  version: expression`${change.version}+1`,
                })
                .where(eq(change.id, workspace.changeID));
          });
        }
        let saved = await binding(sql);
        if (saved.stopping || saved.deleting || saved.deleted)
          throw new Error("Native name is retired; it cannot be recreated");
        await profile();
        if (!saved.attemptedAt) {
          await currentGrant(sql, userID, true);
          if (await getActor())
            throw new Error("Foreign or already-existing Actor was not adopted");
          await drizzleTransaction(sql)
            .update(substrateBinding)
            .set({ createAttemptedAt: expression`now()` })
            .where(
              and(
                eq(substrateBinding.runtimeAttemptId, attemptID),
                isNull(substrateBinding.createAttemptedAt),
              ),
            );
          saved = await binding(sql);
          // Persisted above before dispatch. Errors remain unknown, not a second Create.
          let created: unknown;
          try {
            created = await call("CreateActor", {
              actor: {
                metadata: ref,
                actorTemplate: { atespace, name: "runtime" },
                workerSelector: { matchLabels: retainedIntent.actorSelector },
              },
            });
          } catch (error) {
            if (
              error instanceof SubstrateRPCError &&
              ["AlreadyExists", "PermissionDenied", "Unauthenticated", "InvalidArgument"].includes(
                error.code,
              )
            )
              await drizzleTransaction(sql)
                .update(substrateBinding)
                .set({ createRejected: true })
                .where(eq(substrateBinding.runtimeAttemptId, attemptID));
            throw error;
          }
          await remember(sql, saved, created);
          saved = await binding(sql);
        }
        let actor = await observe(sql, saved);
        await requireSettledBootstrap(sql, saved, actor.status.lastAssignedGeneration);
        if (workspaceID) await sources?.attach(workspaceID, actor.metadata.uid, sql);
        await egress();
        await drizzleTransaction(sql)
          .update(runtimeAttempt)
          .set({
            state: "starting",
            createObservedAt: expression`COALESCE(${runtimeAttempt.createObservedAt},now())`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(runtimeAttempt.id, attemptID),
              eq(runtimeAttempt.state, "create-intended"),
              isNull(runtimeAttempt.stopIntendedAt),
            ),
          );
        // Create produces a natively SUSPENDED Actor. Resume uses that same
        // original identity; no source hooks, prompts or model queues are replayed.
        actor = await resumeActorIn(sql, saved, actor, userID);
        if (actor.status.state === "ACTOR_STATE_RUNNING") {
          await drizzleTransaction(sql)
            .update(runtimeAttempt)
            .set({
              state: "starting",
              createObservedAt: expression`COALESCE(${runtimeAttempt.createObservedAt},now())`,
              failure: null,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(runtimeAttempt.id, attemptID),
                eq(runtimeAttempt.state, "create-intended"),
                isNull(runtimeAttempt.stopIntendedAt),
              ),
            );
          allow(actor.metadata.uid);
        }
        return attemptID;
      });
    },
    async get() {
      return locked(async (sql) => {
        const saved = await binding(sql);
        if (saved.deleted)
          return {
            engine: "substrate" as const,
            state: "deleted",
            coldRestart: true as const,
            portable: false as const,
            sourceHandoff: "pending" as const,
          };
        const actor = await observe(sql, saved);
        if (actor.status.state === "ACTOR_STATE_CRASHED") {
          const failure =
            actor.status.crash?.message === "killed for exceeding its memory limit"
              ? "Native execution exceeded its memory limit. Its latest filesystem state is not a confirmed recovery point; retained resources were not reverted or replaced."
              : "Native execution crashed. A pending snapshot is not a confirmed recovery point; retained resources were not reverted or replaced.";
          await drizzleTransaction(sql)
            .update(runtimeAttempt)
            .set({ state: "failed", failure, updatedAt: expression`now()` })
            .where(
              and(
                eq(runtimeAttempt.id, attemptID),
                inArray(runtimeAttempt.state, ["starting", "ready", "pausing", "paused", "failed"]),
                isNull(runtimeAttempt.stopIntendedAt),
                expression`(${runtimeAttempt.state}<>'failed' OR ${runtimeAttempt.failure} IS DISTINCT FROM ${failure})`,
              ),
            );
        }
        let sourceHandoff: "pending" | "confirmed-same-node" = "pending";
        const [source] = await drizzleTransaction(sql)
          .select({ workspaceID: substrateSource.workspaceId })
          .from(substrateSource)
          .innerJoin(runtimeAttempt, eq(runtimeAttempt.workspaceId, substrateSource.workspaceId))
          .where(
            and(
              eq(runtimeAttempt.id, attemptID),
              eq(runtimeAttempt.state, "paused"),
              isNull(runtimeAttempt.stopIntendedAt),
              eq(substrateSource.actorUid, actor.metadata.uid),
              eq(substrateSource.owner, "service"),
              eq(substrateSource.writable, true),
              gt(substrateSource.generation, 0),
              isNotNull(substrateSource.serviceBase),
              expression`${substrateSource.checkpoint}->>'actorUID'=${actor.metadata.uid}`,
            ),
          );
        if (source && actor.status.state === "ACTOR_STATE_SUSPENDED" && saved.checkpoint) {
          // A generic suspended state or an old local snapshot is not a Source
          // handoff. Independently re-observe the exact recorded durable ROOTFS.
          const recorded = nativeSnapshot.parse(saved.checkpoint);
          requireDurableROOTFS(actor, saved, recorded);
          sourceHandoff = "confirmed-same-node";
        }
        return {
          engine: "substrate" as const,
          actorUID: actor.metadata.uid,
          state: actor.status.state,
          version: actor.metadata.version,
          coldRestart: true as const,
          portable: false as const,
          sourceHandoff,
        };
      });
    },
    async resume(userID: string) {
      return locked(async (sql) => {
        await currentGrant(sql, userID, true);
        const saved = await binding(sql);
        if (saved.stopping || saved.deleting || saved.deleted)
          throw new Error("Native Actor is stopping");
        const before = await observe(sql, saved);
        await requireSettledBootstrap(sql, saved, before.status.lastAssignedGeneration);
        // Public Resume/Suspend have ObjectRef only, no UID/version options.
        // Names are never reused; Get + pinned template + post-observation fence.
        // ROOTFS starts fresh processes during the native wakeup probe. Their
        // frozen environment endpoint must be admitted before dispatch, while
        // Connector upgrades still require the independently observed RUNNING allocation.
        await resumeActorIn(sql, saved, before, userID);
      });
    },
    async suspend() {
      return locked(suspendIn);
    },
    async stop(handoff?: PendingWriterHandoff) {
      return locked((sql) => stopIn(sql, handoff));
    },
    async authorizeConnector(request: Request) {
      if (
        request.headers.get("x-factory-runtime-attempt") !== attemptID ||
        request.headers.get("x-factory-runtime-generation") !== String(config.generation)
      )
        return false;
      return locked(async (sql) => {
        const saved = await binding(sql);
        if (
          !saved.actorUID ||
          saved.deleting ||
          saved.deleted ||
          request.headers.get("x-factory-runtime-actor-uid") !== saved.actorUID
        )
          return false;
        const retainedSourceParent = Boolean(
          workspaceID && sources && request.headers.get("x-factory-connector-role") === "parent",
        );
        const db = drizzleTransaction(sql);
        const newer = alias(runtimeAttempt, "newer");
        if (retainedSourceParent) {
          const [cleanup] = await db
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .innerJoin(substrateSource, eq(substrateSource.workspaceId, runtimeAttempt.workspaceId))
            .where(
              and(
                eq(runtimeAttempt.id, attemptID),
                eq(runtimeAttempt.state, "stopping"),
                isNotNull(runtimeAttempt.stopIntendedAt),
                eq(substrateSource.actorUid, saved.actorUID),
                eq(substrateSource.owner, "actor"),
                notExists(
                  db
                    .select({ id: newer.id })
                    .from(newer)
                    .where(
                      and(
                        eq(newer.workspaceId, runtimeAttempt.workspaceId),
                        gt(newer.generation, runtimeAttempt.generation),
                      ),
                    ),
                ),
              ),
            );
          if (cleanup) {
            await requireStoppedAgentInputsIn(sql, attemptID, await stopHandoffIn(sql));
            return (await observe(sql, saved)).status.state === "ACTOR_STATE_RUNNING";
          }
        }
        const [attempt] = await db
          .select({ userID: runtimeAttempt.createdBy })
          .from(runtimeAttempt)
          .where(
            and(
              eq(runtimeAttempt.id, attemptID),
              eq(runtimeAttempt.generation, config.generation),
              or(
                inArray(runtimeAttempt.state, ["starting", "ready"]),
                and(
                  expression`${retainedSourceParent}`,
                  inArray(runtimeAttempt.state, ["failed", "pausing"]),
                ),
              ),
              isNull(runtimeAttempt.stopIntendedAt),
              notExists(
                db
                  .select({ id: newer.id })
                  .from(newer)
                  .where(
                    and(
                      eq(newer.workspaceId, runtimeAttempt.workspaceId),
                      gt(newer.generation, runtimeAttempt.generation),
                    ),
                  ),
              ),
            ),
          );
        if (!attempt) return false;
        const stoppingInput = await nativeInputStopIn(sql, attemptID);
        if (stoppingInput) {
          if (
            request.headers.get("x-factory-connector-role") !== "parent" ||
            !stoppingInput.resumed ||
            stoppingInput.completed
          )
            return false;
          return (await observe(sql, saved)).status.state === "ACTOR_STATE_RUNNING";
        }
        if (retainedSourceParent && (await retainedTicketPause(sql)))
          return (await observe(sql, saved)).status.state === "ACTOR_STATE_RUNNING";
        const principal = await sql.begin((tx) =>
          preparationID
            ? substratePrebuildPrincipalIn(tx, attemptID)
            : verificationID
              ? substrateVerificationPrincipalIn(tx, attemptID)
              : isolated
                ? substrateIsolatedPrincipalIn(tx, attemptID)
                : substrateRuntimePrincipalIn(tx, attemptID, retainedSourceParent),
        );
        await currentGrant(sql, principal);
        const actor = await observe(sql, saved);
        return actor.status.state === "ACTOR_STATE_RUNNING";
      }).catch(() => false);
    },
  };
}
