import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
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
import { CommandError } from "../command-error";
import { admitComputeIn } from "../usage/compute";
import type { SubstrateSourceHandoff } from "../workspace/substrate-source";
import type { RuntimeHub } from "./hub";
import {
  substrateBootstrapContinuationBlocked,
  substrateBootstrapRetentionIn,
  substrateRuntimePrincipalIn,
  substrateUnsettledBootstrapIn,
  substrateWorkspaceGrantIn,
} from "./substrate-grant";
import { substratePrebuildGrantIn, substratePrebuildPrincipalIn } from "./substrate-prebuild-grant";
import { substrateResourceReservation, substrateResources } from "./substrate-resources";
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
export function substrateActorSelector(secret: string, attemptID: string) {
  return {
    "factory.dev/binding": createHmac("sha256", secret)
      .update(`substrate-create:${attemptID}`)
      .digest("hex")
      .slice(0, 48),
  };
}
export function configuredSubstrate() {
  const file = process.env["FACTORY_SUBSTRATE_OWNED_CONFIGURATION"];
  if (!file) return undefined;
  const config = configurationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (config.deployment !== "owned-test" || !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error(
      "Prepared native configuration is limited to an explicitly owned proof database",
    );
  return config;
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
  expected?: { uuid: string; generation: number },
) {
  if (actor.metadata.uid !== binding.actorUID || actor.status.state !== "ACTOR_STATE_SUSPENDED")
    throw new Error("Original native Actor is not suspended");
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
    (expected && (expected.uuid !== snapshot.uuid || expected.generation !== snapshot.generation))
  )
    throw new Error(
      "Durable ROOTFS snapshot identity differs from the original Actor/template/runtime/generation",
    );
  return { actorUID: actor.metadata.uid, templateUID: binding.intent.templateUID, ...snapshot };
}

function requireRecordedPause(actor: NativeActor, saved: Binding) {
  const snapshots = (actor.status.snapshots ?? []).filter(
    (value) =>
      z.object({ generation: z.number() }).parse(value).generation ===
      actor.status.lastAssignedGeneration,
  );
  if (snapshots.length !== 1) throw new Error("Recorded ROOTFS pause generation is unconfirmed");
  // A persisted workflow/snapshot UUID alone does not establish that the
  // original checkpoint RPC has ended. Never repeat an uncertain checkpoint.
  const committed = nativeSnapshot.safeParse(snapshots[0]);
  if (!committed.success)
    throw new CommandError(
      "unavailable",
      "Recorded native pause is not confirmed durable; no operation was repeated",
    );
  const snapshot = committed.data;
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
    (previous && snapshot.generation <= previous.generation)
  )
    throw new Error("Recorded ROOTFS pause identity/generation differs from its original binding");
  return snapshot;
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
    | SubstratePrebuildConfiguration,
  rpc?: SubstrateCall,
  sources?: SubstrateSourceHandoff,
) {
  const config = z
    .union([configurationSchema, verificationConfiguration, prebuildConfiguration])
    .parse(input);
  if (config.deployment === "owned-test" && !/^owned_[a-f0-9]{32}$/.test(config.database))
    throw new Error("Owned native proof requires its explicitly owned database");
  const call = rpc ?? createSubstrateControl(config.connection);
  const workspaceID = "workspaceID" in config ? config.workspaceID : undefined;
  const verificationID = "verificationID" in config ? config.verificationID : undefined;
  const preparationID = "preparationID" in config ? config.preparationID : undefined;
  if ((verificationID || preparationID) && sources)
    throw new Error("Isolated execution cannot own canonical Source");
  const ownerID = workspaceID ?? verificationID ?? preparationID;
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
  async function binding(sql = database.client) {
    const [row] = await sql<
      Binding[]
    >`SELECT intent,atespace,actor_name AS "actorName",actor_uid::text AS "actorUID",
      create_attempted_at::text AS "attemptedAt",create_rejected AS "createRejected",delete_intended_at IS NOT NULL AS deleting,
      deleted_at IS NOT NULL AS deleted,checkpoint,observation FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`;
    if (!row || !isDeepStrictEqual(row.intent, retainedIntent))
      throw new Error("Native current configuration differs from immutable binding");
    return row;
  }
  async function locked<T>(action: (sql: Database["client"]) => Promise<T>) {
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
  }
  async function getActor() {
    try {
      return await call("GetActor", { actor: ref });
    } catch (error) {
      if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
      throw error;
    }
  }
  async function remember(sql: Database["client"], saved: Binding, value: unknown) {
    const actor = requireSubstrateActor(value, saved);
    const old = saved.observation ? nativeActor.parse(saved.observation) : null;
    if (old && BigInt(actor.metadata.version) < BigInt(old.metadata.version))
      throw new Error("Stale native resource version");
    const result =
      await sql`UPDATE factory.substrate_binding SET actor_uid=COALESCE(actor_uid,${actor.metadata.uid}::uuid),observation=${JSON.stringify(actor)}::text::jsonb
      WHERE runtime_attempt_id=${attemptID} AND deleted_at IS NULL AND (actor_uid IS NULL OR actor_uid=${actor.metadata.uid}::uuid)`;
    if (result.count !== 1) throw new Error("Native current Actor UID binding changed");
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
  async function observe(sql: Database["client"], saved: Binding) {
    if (saved.createRejected)
      throw new Error("Native Create was rejected; an existing Actor is never adopted");
    await profile();
    const value = await getActor();
    if (!value) throw new Error("Original native Actor not observed; create is never replayed");
    return remember(sql, saved, value);
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
  return {
    matchesProject: (id: string) => id === config.projectID,
    matchesAttempt: (id: string) => id === attemptID,
    async recover() {
      return locked(async (sql) => {
        const [present] =
          await sql`SELECT runtime_attempt_id FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`;
        if (!present) return;
        const saved = await binding(sql);
        if (saved.deleting || saved.deleted || !saved.attemptedAt) return;
        const actor = await observe(sql, saved);
        if (actor.status.state !== "ACTOR_STATE_RUNNING") return;
        const [attempt] = await sql<
          { userID: string }[]
        >`SELECT created_by AS "userID" FROM factory.runtime_attempt a WHERE id=${attemptID}
           AND (state IN ('starting','ready') OR (${Boolean(workspaceID && sources)} AND state IN ('failed','pausing')
             AND EXISTS(
               SELECT 1 FROM factory.development_workspace w JOIN factory.substrate_source s ON s.workspace_id=w.id
               JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id AND b.actor_uid=s.actor_uid
               WHERE w.id=a.workspace_id AND w.kind='personal' AND s.owner='actor'
                 AND ((a.ready_at IS NULL AND a.failure IS NOT NULL)
                   OR (a.state='pausing' AND a.ready_at IS NOT NULL AND NOT s.writable AND s.checkpoint_id IS NOT NULL)))))
          AND stop_intended_at IS NULL`;
        if (!attempt) return;
        const principal = await sql.begin((tx) =>
          preparationID
            ? substratePrebuildPrincipalIn(tx, attemptID)
            : verificationID
              ? substrateVerificationPrincipalIn(tx, attemptID)
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
          personalWorkspaceIdentity(config.projectID, userID).workspaceID !== workspaceID
        )
          throw new CommandError("forbidden", "Native owned Workspace identity differs");
        const [existing] =
          await sql`SELECT runtime_attempt_id FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`;
        if (!existing) {
          // Source portability is a later gate. Never migrate, clone over, or
          // discard a retained Workspace or activate Coding from this slice.
          const prior =
            await sql`SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspaceID ?? null} OR id=${attemptID}`;
          const source =
            await sql`SELECT workspace_id FROM factory.workspace_source WHERE workspace_id=${workspaceID ?? null}`;
          if (prior.length || source.length)
            throw new Error(
              "Native owned proof requires a fresh Workspace; Source handoff is not enabled",
            );
          await sql.begin(async (tx) => {
            if (verificationID) {
              const grant = await substrateVerificationGrantIn(
                tx,
                config.projectID,
                verificationID,
                attemptID,
                userID,
              );
              await admitComputeIn(
                tx,
                config.projectID,
                "verification",
                false,
                "verification",
                substrateResourceReservation(config),
              );
              await tx`INSERT INTO factory.runtime_attempt(id,project_id,verification_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id)
                VALUES(${attemptID},${config.projectID},${verificationID},'verification',${config.generation},${grant.revision},'create-intended',${hashConnectorToken(tokens.parent)},${hashConnectorToken(tokens.child)},now(),${userID},true,NULL,NULL)`;
              await tx`UPDATE factory.verification SET runtime_attempt_id=${attemptID},state='runner-starting',updated_at=now()
                WHERE id=${verificationID} AND runtime_attempt_id IS NULL`;
            } else if (preparationID) {
              const grant = await substratePrebuildGrantIn(
                tx,
                config.projectID,
                preparationID,
                attemptID,
                userID,
              );
              await admitComputeIn(
                tx,
                config.projectID,
                "prebuild",
                false,
                "prebuild",
                substrateResourceReservation(config),
              );
              await tx`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id)
                VALUES(${attemptID},${config.projectID},'prebuild',${config.generation},${grant.revision},'create-intended',${hashConnectorToken(tokens.parent)},${hashConnectorToken(tokens.child)},now(),${userID},true,NULL,NULL)`;
              await tx`UPDATE factory.project_image_preparation SET runtime_attempt_id=${attemptID},state='running',updated_at=now()
                WHERE id=${preparationID} AND runtime_attempt_id IS NULL`;
            } else {
              if (!workspaceID) throw new Error("Native Workspace identity is missing");
              await substrateWorkspaceGrantIn(database, tx, workspaceID, userID, true);
              await admitComputeIn(
                tx,
                config.projectID,
                "development",
                false,
                "development",
                substrateResourceReservation(config),
              );
              await tx`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,change_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,substrate,factorybox_worker_id,factorybox_admission_id)
              SELECT ${attemptID},project_id,id,change_id,${config.generation},source_revision,'create-intended',${hashConnectorToken(tokens.parent)},${hashConnectorToken(tokens.child)},now(),${userID},true,NULL,NULL
                FROM factory.development_workspace WHERE id=${workspaceID}`;
            }
            await tx`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent) VALUES(${attemptID},${atespace},${actorName},${JSON.stringify(retainedIntent)}::text::jsonb)`;
            if (config.environment)
              await tx`INSERT INTO factory.runtime_environment_intent(runtime_attempt_id,environment,version,secret_key) VALUES(${attemptID},${"preparationID" in config ? config.environment.environment : "development"},${config.environment.version},${config.environment.secretKey})`;
            if (config.declaredApps)
              await tx`UPDATE factory.runtime_attempt SET declared_apps=${JSON.stringify(config.declaredApps)}::text::jsonb WHERE id=${attemptID}`;
            if (workspace.changeID)
              await tx`UPDATE factory.change SET runtime_attempt_id=${attemptID},state='starting',failure=NULL,version=version+1 WHERE id=${workspace.changeID}`;
          });
        }
        let saved = await binding(sql);
        if (saved.deleting || saved.deleted)
          throw new Error("Native name is retired; it cannot be recreated");
        await profile();
        if (!saved.attemptedAt) {
          await currentGrant(sql, userID, true);
          if (await getActor())
            throw new Error("Foreign or already-existing Actor was not adopted");
          await sql`UPDATE factory.substrate_binding SET create_attempted_at=now() WHERE runtime_attempt_id=${attemptID} AND create_attempted_at IS NULL`;
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
              await sql`UPDATE factory.substrate_binding SET create_rejected=true WHERE runtime_attempt_id=${attemptID}`;
            throw error;
          }
          await remember(sql, saved, created);
          saved = await binding(sql);
        }
        let actor = await observe(sql, saved);
        await requireSettledBootstrap(sql, saved, actor.status.lastAssignedGeneration);
        if (workspaceID) await sources?.attach(workspaceID, actor.metadata.uid, sql);
        await egress();
        await sql`UPDATE factory.runtime_attempt SET state='starting',create_observed_at=COALESCE(create_observed_at,now()),updated_at=now() WHERE id=${attemptID} AND state='create-intended' AND stop_intended_at IS NULL`;
        allow(actor.metadata.uid);
        // Create produces a natively SUSPENDED Actor. Resume uses that same
        // original identity; no source hooks, prompts or model queues are replayed.
        if (actor.status.state === "ACTOR_STATE_SUSPENDED") {
          // Start may be an explicit continuation after a writer transfer. Do
          // not reuse the original creator's now-expired commissioned authority.
          await currentGrant(sql, userID, true);
          if (actor.status.lastAssignedGeneration)
            requireDurableROOTFS(actor, { ...saved, actorUID: actor.metadata.uid });
          if (workspaceID) await sources?.resume(workspaceID, attemptID, sql);
          await sql`UPDATE factory.runtime_attempt SET state='starting',failure=NULL,updated_at=now() WHERE id=${attemptID} AND stop_intended_at IS NULL`;
          await call("ResumeActor", { actor: ref });
          actor = await observe(sql, await binding(sql));
        }
        if (actor.status.state === "ACTOR_STATE_RUNNING") {
          await sql`UPDATE factory.runtime_attempt SET state='starting',create_observed_at=COALESCE(create_observed_at,now()),failure=NULL,updated_at=now() WHERE id=${attemptID} AND state='create-intended' AND stop_intended_at IS NULL`;
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
          await sql`UPDATE factory.runtime_attempt SET state='failed',failure=${failure},updated_at=now()
            WHERE id=${attemptID} AND state IN ('starting','ready','pausing','paused','failed') AND stop_intended_at IS NULL
              AND (state<>'failed' OR failure IS DISTINCT FROM ${failure})`;
        }
        let sourceHandoff: "pending" | "confirmed-same-node" = "pending";
        const [source] = await sql`
          SELECT s.workspace_id FROM factory.substrate_source s
          JOIN factory.runtime_attempt a ON a.workspace_id=s.workspace_id
          WHERE a.id=${attemptID} AND a.state='paused' AND a.stop_intended_at IS NULL
            AND s.actor_uid=${actor.metadata.uid} AND s.owner='service' AND s.writable
            AND s.generation>0 AND s.service_base IS NOT NULL
            AND s.checkpoint->>'actorUID'=${actor.metadata.uid}`;
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
        if (saved.deleting || saved.deleted) throw new Error("Native Actor is stopping");
        const before = await observe(sql, saved);
        await requireSettledBootstrap(sql, saved, before.status.lastAssignedGeneration);
        if (before.status.state === "ACTOR_STATE_SUSPENDED" && before.status.lastAssignedGeneration)
          requireDurableROOTFS(before, saved);
        if (before.status.state === "ACTOR_STATE_SUSPENDED")
          if (workspaceID) await sources?.resume(workspaceID, attemptID, sql);
        await egress();
        // Public Resume/Suspend have ObjectRef only, no UID/version options.
        // Names are never reused; Get + pinned template + post-observation fence.
        // ROOTFS starts fresh processes during the native wakeup probe. Their
        // frozen environment endpoint must be admitted before dispatch, while
        // Connector upgrades still require the independently observed RUNNING allocation.
        await sql`UPDATE factory.runtime_attempt SET state='starting',failure=NULL,updated_at=now() WHERE id=${attemptID} AND stop_intended_at IS NULL`;
        if (saved.actorUID) allow(saved.actorUID);
        await call("ResumeActor", { actor: ref });
        const actor = await observe(sql, await binding(sql));
        if (actor.status.state === "ACTOR_STATE_RUNNING") {
          await sql`UPDATE factory.runtime_attempt SET state='starting',failure=NULL,updated_at=now() WHERE id=${attemptID} AND stop_intended_at IS NULL`;
          allow(actor.metadata.uid);
        }
      });
    },
    async suspend() {
      return locked(async (sql) => {
        const saved = await binding(sql);
        if (saved.deleting || saved.deleted) throw new Error("Native Actor is stopping");
        const before = await observe(sql, saved);
        const [recorded] = await sql<
          { state: string }[]
        >`SELECT state::text AS state FROM factory.runtime_attempt WHERE id=${attemptID}`;
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
        // Re-enter only after a positive durable observation of that exact
        // UUID/generation. PENDING alone cannot authorize another Suspend RPC.
        const pending = reentering ? requireRecordedPause(before, saved) : undefined;
        const completing =
          before.status.state === "ACTOR_STATE_SUSPENDED" &&
          (recorded?.state === "pausing" || recorded?.state === "paused");
        // An existing completed native pause can be reconciled without Source
        // handoff. A disconnected Parent cannot prove the workload is still
        // checkpointable: fscheckpoint of an exited workload can destroy its
        // remaining state and leave only a CRASHED/PENDING native outcome.
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
            "Initial Source is unavailable. No native checkpoint was dispatched because workload liveness and preservation are unconfirmed.",
          );
        const retainBootstrap = bootstrap && completing;
        await sql`UPDATE factory.runtime_attempt SET state='pausing',updated_at=now() WHERE id=${attemptID} AND stop_intended_at IS NULL`;
        if (workspaceID && !retainBootstrap)
          await sources?.freezeActor(workspaceID, attemptID, sql);
        hub.revoke(attemptID);
        // A lost reply can leave the recorded pause already completed natively.
        // Reconcile that exact durable result instead of dispatching it again.
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
          {
            ...saved,
            actorUID: before.metadata.uid,
          },
          pending,
        );
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
        // Independent Get, not the Suspend reply, established COMPLETED. Keep
        // the last good checkpoint on any rejection; never authorize Source release.
        await sql`UPDATE factory.substrate_binding SET checkpoint=${JSON.stringify(checkpoint)}::text::jsonb WHERE runtime_attempt_id=${attemptID}`;
        await sql`UPDATE factory.runtime_attempt SET state='paused',failure=CASE WHEN ready_at IS NULL THEN failure ELSE NULL END,updated_at=now() WHERE id=${attemptID} AND stop_intended_at IS NULL`;
        if (workspaceID && !retainBootstrap) await sources?.paused(workspaceID, sql);
      });
    },
    async stop() {
      // Until independent Source handoff exists, a normal product Stop must not
      // delete the Actor that holds the user's checkout. Native synchronous
      // Suspend stops compute and retains its verified ROOTFS; report paused,
      // never fabricate a deletion. Only explicitly disposable owned-test DBs
      // use the Delete proof below.
      if (config.deployment === "fresh-workspaces" && workspaceID) return this.suspend();
      return locked(async (sql) => {
        let saved = await binding(sql);
        if (saved.deleted) return;
        await sql`UPDATE factory.runtime_attempt SET stop_intended_at=COALESCE(stop_intended_at,now()),state='stopping',updated_at=now() WHERE id=${attemptID}`;
        await sql`UPDATE factory.substrate_binding SET delete_intended_at=COALESCE(delete_intended_at,now()) WHERE runtime_attempt_id=${attemptID}`;
        hub.revoke(attemptID);
        saved = await binding(sql);
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
        await sql`UPDATE factory.substrate_binding SET deleted_at=now() WHERE runtime_attempt_id=${attemptID} AND deleted_at IS NULL`;
        await sql`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now(),failure=NULL,updated_at=now() WHERE id=${attemptID}`;
      });
    },
    async authorizeConnector(request: Request) {
      if (request.headers.get("x-factory-runtime-attempt") !== attemptID) return false;
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
        const [attempt] = await sql<
          { userID: string }[]
        >`SELECT created_by AS "userID" FROM factory.runtime_attempt a WHERE id=${attemptID}
          AND generation=${config.generation} AND (state IN ('starting','ready') OR (${retainedSourceParent} AND state IN ('failed','pausing'))) AND stop_intended_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)`;
        if (!attempt) return false;
        const principal = await sql.begin((tx) =>
          preparationID
            ? substratePrebuildPrincipalIn(tx, attemptID)
            : verificationID
              ? substrateVerificationPrincipalIn(tx, attemptID)
              : substrateRuntimePrincipalIn(tx, attemptID, retainedSourceParent),
        );
        await currentGrant(sql, principal);
        const actor = await observe(sql, saved);
        return actor.status.state === "ACTOR_STATE_RUNNING";
      }).catch(() => false);
    },
  };
}
