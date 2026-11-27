import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { runtimeConnectorTokens, runtimeIdentity } from "#runtime-domain/identity";
import {
  createSubstrateControl,
  type NativeActor,
  nativeActor,
  nativeRuntime,
  nativeSnapshot,
  type SubstrateCall,
  substrateConnection,
} from "#runtime-kubernetes/substrate-control";
import type { CodingRuntimeShutdown } from "../agent/runtime-api";
import { CommandError } from "../command-error";
import type { SubstrateSourceHandoff } from "../workspace/source-api";
import type { RuntimeHub } from "./hub";
import { substrateResources } from "./substrate-resources";
import { type ActorRPC, actorRPCOrigin } from "./substrate-rpc-facts";

export type Database = ReturnType<typeof createDatabase>;

export const configurationSchema = z.strictObject({
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

export const verificationConfiguration = configurationSchema
  .omit({ workspaceID: true })
  .extend({ verificationID: z.uuid() });
export type SubstrateVerificationConfiguration = z.infer<typeof verificationConfiguration>;

export const isolatedConfiguration = configurationSchema.omit({ workspaceID: true }).extend({
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

export type SubstrateExecutionConfig =
  | SubstrateConfiguration
  | SubstrateVerificationConfiguration
  | SubstrateIsolatedConfiguration;

export type RetainedIntent = SubstrateExecutionConfig & {
  actorSelector: Record<string, string>;
  sourceRestoreProtocol?: 2;
};

export type Binding = {
  intent: SubstrateExecutionConfig & {
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

export type LoadedBinding = Omit<Binding, "intent"> & {
  intent: RetainedIntent;
  stopping: boolean;
};

export type SubstrateExecContext = {
  database: Database;
  hub: RuntimeHub;
  shutdownCoding: CodingRuntimeShutdown;
  sources: SubstrateSourceHandoff | undefined;
  config: SubstrateExecutionConfig;
  call: SubstrateCall;
  workspaceID: string | undefined;
  verificationID: string | undefined;
  isolated: SubstrateIsolatedConfiguration | undefined;
  ownerID: string;
  attemptID: string;
  atespace: string;
  actorName: string;
  ref: { atespace: string; name: string };
  tokens: ReturnType<typeof runtimeConnectorTokens>;
  retainedIntent: RetainedIntent;
  egressRules: Array<{
    tlsPassthrough: {
      hostnames: string[];
      ports: { numbers: number[] };
    };
  }>;
};

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

export function createSubstrateExecContext(
  database: Database,
  hub: RuntimeHub,
  secret: string,
  input: SubstrateExecutionConfig,
  shutdownCoding: CodingRuntimeShutdown,
  rpc?: SubstrateCall,
  sources?: SubstrateSourceHandoff,
): SubstrateExecContext {
  const config = z
    .union([configurationSchema, verificationConfiguration, isolatedConfiguration])
    .parse(input);
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native proof requires its explicitly owned database");
  const call = rpc ?? createSubstrateControl(config.connection);
  const workspaceID = "workspaceID" in config ? config.workspaceID : undefined;
  const verificationID = "verificationID" in config ? config.verificationID : undefined;
  const isolated = "isolatedID" in config ? config : undefined;
  if ((verificationID || isolated) && sources)
    throw new Error("Isolated execution cannot own canonical Source");
  const ownerID = workspaceID ?? verificationID ?? isolated?.isolatedID;
  if (!ownerID) throw new Error("Native execution owner is missing");
  const attemptID = runtimeIdentity(ownerID, config.generation).attemptID;
  const atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const actorName = `runtime-${attemptID.replaceAll("-", "")}`;
  const ref = { atespace, name: actorName };
  const tokens = runtimeConnectorTokens(secret, attemptID, config.generation);
  const retainedIntent: RetainedIntent = {
    ...config,
    actorSelector: config.workerSelector ?? substrateActorSelector(secret, attemptID),
    ...(sources ? { sourceRestoreProtocol: 2 as const } : {}),
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
  return {
    database,
    hub,
    shutdownCoding,
    sources,
    config,
    call,
    workspaceID,
    verificationID,
    isolated,
    ownerID,
    attemptID,
    atespace,
    actorName,
    ref,
    tokens,
    retainedIntent,
    egressRules,
  };
}

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
    fidelity?: string;
    durableSnapshot?: { object: { snapshotUri: string } };
  },
) {
  if (actor.metadata.uid !== binding.actorUID || actor.status.state !== "ACTOR_STATE_SUSPENDED")
    throw new Error("Original native Actor is not suspended");
  return requireROOTFSSnapshot(actor, binding, expected);
}

export function requireROOTFSSnapshot(
  actor: NativeActor,
  binding: Pick<Binding, "intent" | "atespace" | "actorUID">,
  expected?: {
    uuid: string;
    generation: number;
    fidelity?: string;
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
        (expected.fidelity !== undefined && expected.fidelity !== snapshot.fidelity) ||
        (expected.durableSnapshot &&
          expected.durableSnapshot.object.snapshotUri !==
            snapshot.durableSnapshot.object.snapshotUri)))
  )
    throw new Error(
      "Durable ROOTFS snapshot identity differs from the original Actor/template/runtime/generation",
    );
  return { actorUID: actor.metadata.uid, templateUID: binding.intent.templateUID, ...snapshot };
}

export function requireResumeContinuity(actor: NativeActor, saved: Binding, operation: ActorRPC) {
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

export function requireRecordedPause(actor: NativeActor, saved: Binding) {
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

export function retainedPauseProgress(saved: Binding) {
  const observed = nativeActor.safeParse(saved.observation);
  const previous = saved.checkpoint ? nativeSnapshot.parse(saved.checkpoint) : null;
  if (
    !observed.success ||
    observed.data.status.lastAssignedGeneration !== (previous?.generation ?? 0) + 1
  )
    return undefined;
  return requireRecordedPause(observed.data, saved);
}

export function requirePauseContinuity(actor: NativeActor, saved: Binding) {
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
