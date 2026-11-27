import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql as query } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import {
  type NativeCapacityNode,
  nativeCapacityAdmittedNodeReady,
  nativeCapacityCandidates,
  nativeCapacityOriginalNode,
  nativeCapacityOwner,
  nativeCapacityReadyReplicas,
  nativeCapacityReservedPoolResources,
  renderNativeCapacityPool,
  requireNativeCapacityBase,
  requireNativeCapacityPool,
  requireNativeCapacitySandbox,
  runNativeCapacityKubernetes,
} from "#runtime-kubernetes/substrate-capacity";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import { CommandError } from "../command-error";
import { installationInMaintenance } from "../installation/maintenance";
import type {
  SubstrateCapacityConfiguration,
  SubstrateCapacityResources,
} from "./substrate-capacity-contract";

type Database = ReturnType<typeof createDatabase>;
const CAPACITY_INSTALLATION_KIND = "runtime.capacity_installation";
const CAPACITY_INSTALLATION_SCOPE_TYPE = "installation";
const WORKER_CAPACITY_KIND = "runtime.worker_capacity";
const WORKER_CAPACITY_SCOPE_TYPE = "worker";
type Intent = {
  database: string;
  selector: Record<string, string>;
  baseUID: string;
  sandboxUID: string;
  node: NativeCapacityNode;
  pool: ReturnType<typeof renderNativeCapacityPool>;
};
type Fact = {
  nodeUID: string;
  intent: Intent;
  attemptedAt: string | null;
  rejected: boolean;
  pool: { uid: string } | null;
};
type InstallationIntent = {
  database: string;
  selector: Record<string, string>;
  sandboxUID: string;
  base: { uid: string; name: string; namespace: string; workerImage: string };
  node: NativeCapacityNode;
};
type InstallationPayload = {
  owner: string;
  intent: InstallationIntent;
};
type WorkerCapacityPayload = {
  owner: string;
  nodeUid: string;
  intent: Intent;
  attemptedAt: string | null;
  rejected: boolean;
};
type WorkerCapacityResult = {
  pool?: Fact["pool"];
};

// Installation capacity only. The native WorkerPool controller creates workers;
// the normal Substrate allocator still places Actors and enforces their budgets.
export function createSubstrateCapacity(
  database: Database,
  config: SubstrateCapacityConfiguration,
  run = runNativeCapacityKubernetes,
) {
  const selector = config.workerSelector;
  const architecture = nativeRuntimeArchitecture(config.runtime);
  const owner = nativeCapacityOwner(selector);
  const labelSelector = Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join(",");
  async function json(args: readonly string[]) {
    const result = await run(args);
    if (result.exitCode !== 0) throw new Error("Native worker capacity observation is unavailable");
    return JSON.parse(result.stdout);
  }
  async function getPool(intent: Intent) {
    const result = await run([
      "get",
      "workerpool",
      intent.pool.metadata.name,
      "-n",
      intent.pool.metadata.namespace,
      "--ignore-not-found=true",
      "-o",
      "json",
    ]);
    if (result.exitCode !== 0)
      throw new Error("Original native capacity WorkerPool observation is unavailable");
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }
  async function facts(sql = database.client): Promise<Fact[]> {
    const rows = await drizzleTransaction(sql)
      .select({
        payload: operation.payload,
        result: operation.result,
      })
      .from(operation)
      .where(
        and(
          eq(operation.kind, WORKER_CAPACITY_KIND),
          eq(operation.scopeType, WORKER_CAPACITY_SCOPE_TYPE),
          query`${operation.payload}->>'owner'=${owner}`,
        ),
      )
      .orderBy(query`${operation.payload}->>'nodeUid'`);
    return rows.map((row) => {
      const payload = row.payload as WorkerCapacityPayload;
      const result = (row.result ?? {}) as WorkerCapacityResult;
      return {
        nodeUID: payload.nodeUid,
        intent: payload.intent,
        attemptedAt: payload.attemptedAt ?? null,
        rejected: payload.rejected ?? false,
        pool: result.pool ?? null,
      };
    });
  }
  async function ensure() {
    if (await installationInMaintenance(database)) return { ready: [], refused: [] };
    const sql = database.coordination();
    const db = drizzleTransaction(sql);
    const capacityIdentity = (nodeUID: string) =>
      and(
        eq(operation.kind, WORKER_CAPACITY_KIND),
        eq(operation.scopeType, WORKER_CAPACITY_SCOPE_TYPE),
        eq(operation.scopeId, `${owner}:${nodeUID}`),
      );
    let locked = false;
    try {
      // Share the installation's existing worker-create admission lock. K8s
      // requests also reserve the full selected budget while a pool is pending.
      const [lock] = await sql<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext('factory-substrate-capacity')) AS acquired`;
      if (!lock?.acquired) return { ready: [], refused: [] };
      locked = true;
      const [currentDatabase] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      if (currentDatabase?.name !== config.database)
        throw new Error("Native worker admission database differs from its installation");
      const [poolsInput, nodesInput, podsInput, sandboxInput] = await Promise.all([
        json(["get", "workerpools", "--all-namespaces", "-l", labelSelector, "-o", "json"]),
        json(["get", "nodes", "-o", "json"]),
        json(["get", "pods", "--all-namespaces", "-o", "json"]),
        json(["get", "sandboxconfig", config.profile, "-o", "json"]),
      ]);
      const base = requireNativeCapacityBase(poolsInput, selector, architecture);
      const baseNamespace = base.metadata.namespace;
      if (!baseNamespace) throw new Error("Original native WorkerPool namespace is unavailable");
      const sandboxUID = requireNativeCapacitySandbox(sandboxInput);
      const saved = await facts(sql);
      const ready: Array<{ cpuMilli: number; memoryMiB: number }> = [];
      const [installed] = await db
        .select({
          payload: operation.payload,
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, CAPACITY_INSTALLATION_KIND),
            eq(operation.scopeType, CAPACITY_INSTALLATION_SCOPE_TYPE),
            eq(operation.scopeId, owner),
          ),
        );
      let original = installed ? (installed.payload as InstallationPayload).intent : undefined;
      const originalNode = nativeCapacityOriginalNode(nodesInput, base, architecture);
      const baseReadyReplicas = nativeCapacityReadyReplicas(base);
      if (!original && originalNode && baseReadyReplicas >= 1) {
        original = {
          database: config.database,
          selector,
          sandboxUID,
          base: {
            uid: base.metadata.uid,
            name: base.metadata.name,
            namespace: baseNamespace,
            workerImage: base.spec.workerImage,
          },
          node: originalNode,
        };
        if (
          !/^[a-f0-9]{32}$/.test(owner) ||
          original.database !== currentDatabase.name ||
          !original.base.uid ||
          !original.node.uid ||
          !original.sandboxUID
        )
          throw new Error("Native capacity requires its observed installation identity");
        await db.insert(operation).values({
          id: crypto.randomUUID(),
          kind: CAPACITY_INSTALLATION_KIND,
          scopeType: CAPACITY_INSTALLATION_SCOPE_TYPE,
          scopeId: owner,
          idempotencyKey: `${CAPACITY_INSTALLATION_KIND}:${owner}`,
          state: "active",
          payload: { owner, intent: original },
        });
      }
      if (original) {
        if (
          original.database !== config.database ||
          !isDeepStrictEqual(original.selector, selector) ||
          original.sandboxUID !== sandboxUID ||
          original.base.uid !== base.metadata.uid ||
          original.base.name !== base.metadata.name ||
          original.base.namespace !== base.metadata.namespace ||
          original.base.workerImage !== base.spec.workerImage ||
          original.node.architecture !== architecture
        )
          throw new Error("Native capacity profile or original installation identity changed");
        if (
          baseReadyReplicas >= 1 &&
          base.spec.template.nodeSelector["kubernetes.io/hostname"] === original.node.hostname &&
          nativeCapacityAdmittedNodeReady(nodesInput, original.node) &&
          isDeepStrictEqual(nativeCapacityReservedPoolResources(base), original.node.resources)
        ) {
          for (let slot = 0; slot < baseReadyReplicas; slot++) ready.push(original.node.resources);
        }
      } else if (
        baseReadyReplicas >= 1 &&
        !base.spec.template.nodeSelector["kubernetes.io/hostname"]
      ) {
        const baseResources = nativeCapacityReservedPoolResources(base);
        if (baseResources) {
          for (let slot = 0; slot < baseReadyReplicas; slot++) ready.push(baseResources);
        }
      }
      for (const row of saved) {
        if (
          row.intent.database !== config.database ||
          !isDeepStrictEqual(row.intent.selector, selector) ||
          row.intent.baseUID !== base.metadata.uid ||
          row.intent.pool.spec.workerImage !== base.spec.workerImage ||
          row.intent.sandboxUID !== sandboxUID ||
          row.intent.node.architecture !== architecture
        )
          throw new Error(
            "Native worker capacity profile or original installation identity changed",
          );
        if (row.rejected)
          throw new Error("Native capacity creation was rejected; foreign pools are never adopted");
        if (!row.attemptedAt) continue;
        const actual = await getPool(row.intent);
        if (!actual)
          throw new Error(
            "Original native capacity WorkerPool is missing; creation is never replayed",
          );
        const observed = requireNativeCapacityPool(
          actual,
          row.intent.pool,
          row.attemptedAt,
          row.pool?.uid,
        );
        if (!row.pool)
          await db
            .update(operation)
            .set({
              result: { pool: { uid: observed.metadata.uid } },
              updatedAt: query`now()`,
            })
            .where(
              and(
                capacityIdentity(row.nodeUID),
                query`(${operation.payload}->>'attemptedAt') IS NOT NULL`,
                isNull(operation.result),
              ),
            );
        const observedReadyReplicas = nativeCapacityReadyReplicas(observed);
        if (
          observedReadyReplicas >= 1 &&
          nativeCapacityAdmittedNodeReady(nodesInput, row.intent.node)
        ) {
          for (let slot = 0; slot < observedReadyReplicas; slot++) {
            ready.push(row.intent.node.resources);
          }
        }
      }
      // Existing pools keep their admitted budgets. Only never-dispatched node
      // intents participate in fresh node/Pod resource admission again.
      const nodes = z
        .object({
          items: z.array(
            z.object({ metadata: z.object({ uid: z.string() }).passthrough() }).passthrough(),
          ),
        })
        .parse(nodesInput);
      const discovered = nativeCapacityCandidates(
        {
          items: nodes.items.filter(
            (node) => !saved.some((row) => row.nodeUID === node.metadata.uid && row.attemptedAt),
          ),
        },
        podsInput,
        architecture,
      );
      for (const node of discovered.candidates) {
        let row = saved.find((value) => value.nodeUID === node.uid);
        if (
          row &&
          (row.intent.node.name !== node.name ||
            row.intent.node.bootID !== node.bootID ||
            row.intent.node.hostname !== node.hostname)
        )
          throw new Error("Original native capacity node identity or boot changed");
        if (
          row &&
          (node.resources.cpuMilli < row.intent.node.resources.cpuMilli ||
            node.resources.memoryMiB < row.intent.node.resources.memoryMiB)
        )
          throw new Error(
            "Original native capacity budget no longer fits current node reservations",
          );
        if (!row) {
          const intent: Intent = {
            database: config.database,
            selector,
            baseUID: base.metadata.uid,
            sandboxUID,
            node,
            pool: renderNativeCapacityPool(base, node, selector, crypto.randomUUID()),
          };
          await db.insert(operation).values({
            id: crypto.randomUUID(),
            kind: WORKER_CAPACITY_KIND,
            scopeType: WORKER_CAPACITY_SCOPE_TYPE,
            scopeId: `${owner}:${node.uid}`,
            idempotencyKey: `${WORKER_CAPACITY_KIND}:${owner}:${node.uid}`,
            state: "active",
            payload: {
              owner,
              nodeUid: node.uid,
              intent,
              attemptedAt: null,
              rejected: false,
            },
          });
          row = { nodeUID: node.uid, intent, attemptedAt: null, rejected: false, pool: null };
        }
        if (row.rejected)
          throw new Error("Native capacity creation was rejected; foreign pools are never adopted");
        let actual = await getPool(row.intent);
        if (!row.attemptedAt) {
          if (actual) throw new Error("Preexisting native capacity WorkerPool was not adopted");
          // Keep the existing maintenance row shared through dispatch. Commit
          // creation facts on the normal pool before the external create, so a
          // lost reply remains recoverable even if this observer exits.
          await sql`BEGIN`;
          try {
            const [maintenance] = await db
              .select({ state: operation.state })
              .from(operation)
              .where(
                and(
                  eq(operation.kind, "installation.maintenance"),
                  eq(operation.idempotencyKey, "installation.maintenance:singleton"),
                ),
              )
              .for("share");
            if (!maintenance) throw new Error("Installation maintenance state is unavailable");
            if (maintenance.state === "enabled") return { ready: [], refused: discovered.refused };
            const [dispatch] = await database.db
              .update(operation)
              .set({
                payload: query`${operation.payload} || jsonb_build_object('attemptedAt', now()::text)`,
                updatedAt: query`now()`,
              })
              .where(
                and(
                  capacityIdentity(node.uid),
                  query`(${operation.payload}->>'attemptedAt') IS NULL`,
                ),
              )
              .returning({
                attemptedAt: query<string>`${operation.payload}->>'attemptedAt'`,
              });
            if (!dispatch) throw new Error("Original native capacity dispatch is unsettled");
            row.attemptedAt = dispatch.attemptedAt;
            const result = await run(
              ["create", "-f", "-", "-o", "json"],
              JSON.stringify(row.intent.pool),
            );
            if (result.exitCode !== 0) {
              if (/AlreadyExists|Forbidden|Unauthorized|Invalid/.test(result.stderr))
                await database.db
                  .update(operation)
                  .set({
                    payload: query`${operation.payload} || jsonb_build_object('rejected', true)`,
                    updatedAt: query`now()`,
                  })
                  .where(capacityIdentity(node.uid));
              throw new Error(
                "Native capacity creation outcome is unconfirmed; original names and intent retained",
              );
            }
            actual = JSON.parse(result.stdout);
            const confirmed = requireNativeCapacityPool(actual, row.intent.pool, row.attemptedAt);
            await database.db
              .update(operation)
              .set({
                result: { pool: { uid: confirmed.metadata.uid } },
                updatedAt: query`now()`,
              })
              .where(
                and(
                  capacityIdentity(node.uid),
                  query`(${operation.payload}->>'attemptedAt') IS NOT NULL`,
                  isNull(operation.result),
                ),
              );
            row.pool = { uid: confirmed.metadata.uid };
          } finally {
            await sql`ROLLBACK`;
          }
        }
        if (!actual)
          throw new Error(
            "Native capacity creation outcome is unconfirmed; no create was repeated",
          );
        const observed = requireNativeCapacityPool(
          actual,
          row.intent.pool,
          row.attemptedAt,
          row.pool?.uid,
        );
        if (!row.pool)
          await db
            .update(operation)
            .set({
              result: { pool: { uid: observed.metadata.uid } },
              updatedAt: query`now()`,
            })
            .where(
              and(
                capacityIdentity(node.uid),
                query`(${operation.payload}->>'attemptedAt') IS NOT NULL`,
                isNull(operation.result),
              ),
            );
        const createdReadyReplicas = nativeCapacityReadyReplicas(observed);
        for (let slot = 0; slot < createdReadyReplicas; slot++) {
          ready.push(row.intent.node.resources);
        }
      }
      return { ready, refused: discovered.refused };
    } catch (cause) {
      if (cause instanceof z.ZodError) {
        const firstPath = cause.issues[0]?.path.join(".");
        throw new CommandError(
          "unavailable",
          `Native worker capacity observation returned an unexpected cluster format${firstPath ? ` (${firstPath})` : ""}. No new runtime was started.`,
          { cause },
        );
      }
      throw cause;
    } finally {
      try {
        if (locked) await sql`SELECT pg_advisory_unlock(hashtext('factory-substrate-capacity'))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  return {
    ensure,
    async requireReady(resources: SubstrateCapacityResources) {
      const observed = await ensure();
      if (
        !observed.ready.some(
          (worker) =>
            worker.cpuMilli >= resources.cpuMilli && worker.memoryMiB > resources.memoryMiB,
        )
      )
        throw new CommandError(
          "unavailable",
          "Additional native capacity is preparing or unavailable. No new runtime was started.",
        );
    },
  };
}
