import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type NativeCapacityNode,
  nativeCapacityCandidates,
  nativeCapacityNodeReady,
  nativeCapacityOwner,
  renderNativeCapacityPool,
  requireNativeCapacityBase,
  requireNativeCapacityPool,
  requireNativeCapacitySandbox,
  runNativeCapacityKubernetes,
} from "../../../../packages/runtime-kubernetes/src/substrate-capacity";
import { CommandError } from "../command-error";
import { installationInMaintenance } from "../installation/maintenance";
import type { SubstrateWorkspaceConfiguration } from "./substrate-workspaces";

type Database = ReturnType<typeof createDatabase>;
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

// Installation capacity only. The native WorkerPool controller creates workers;
// the normal Substrate allocator still places Actors and enforces their budgets.
export function createSubstrateCapacity(
  database: Database,
  config: SubstrateWorkspaceConfiguration,
  run = runNativeCapacityKubernetes,
) {
  const selector = config.workerSelector;
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
  async function facts(sql = database.client) {
    return sql<
      Fact[]
    >`SELECT node_uid::text AS "nodeUID",intent,attempted_at::text AS "attemptedAt",rejected,pool
      FROM factory.substrate_worker_capacity WHERE owner=${owner} ORDER BY node_uid`;
  }
  async function ensure() {
    if (await installationInMaintenance(database)) return { ready: [], refused: [] };
    const sql = database.coordination();
    let locked = false;
    try {
      // Share the installation's existing worker-create admission lock. K8s
      // requests also reserve the full selected budget while a pool is pending.
      const [lock] = await sql<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext('factorybox-worker-create')) AS acquired`;
      if (!lock?.acquired) return { ready: [], refused: [] };
      locked = true;
      const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      if (db?.name !== config.database)
        throw new Error("Native worker admission database differs from its installation");
      const [poolsInput, nodesInput, podsInput, sandboxInput] = await Promise.all([
        json(["get", "workerpools", "--all-namespaces", "-l", labelSelector, "-o", "json"]),
        json(["get", "nodes", "-o", "json"]),
        json(["get", "pods", "--all-namespaces", "-o", "json"]),
        json(["get", "sandboxconfig", config.profile, "-o", "json"]),
      ]);
      const base = requireNativeCapacityBase(poolsInput, selector);
      const sandboxUID = requireNativeCapacitySandbox(sandboxInput);
      const saved = await facts(sql);
      const ready: Array<{ cpuMilli: number; memoryMiB: number }> = [];
      for (const row of saved) {
        if (
          row.intent.database !== config.database ||
          !isDeepStrictEqual(row.intent.selector, selector) ||
          row.intent.baseUID !== base.metadata.uid ||
          row.intent.sandboxUID !== sandboxUID
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
          await sql`UPDATE factory.substrate_worker_capacity SET pool=${JSON.stringify({ uid: observed.metadata.uid })}::text::jsonb WHERE owner=${owner} AND node_uid=${row.nodeUID}`;
        if (
          observed.status?.readyReplicas === 1 &&
          nativeCapacityNodeReady(nodesInput, row.intent.node)
        )
          ready.push(row.intent.node.resources);
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
          await sql`INSERT INTO factory.substrate_worker_capacity(owner,node_uid,intent) VALUES(${owner},${node.uid},${JSON.stringify(intent)}::text::jsonb)`;
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
            const [maintenance] = await sql<
              { enabled: boolean }[]
            >`SELECT enabled FROM factory.installation_maintenance WHERE singleton FOR SHARE`;
            if (!maintenance) throw new Error("Installation maintenance state is unavailable");
            if (maintenance.enabled) return { ready: [], refused: discovered.refused };
            const [dispatch] = await database.client<
              { attemptedAt: string }[]
            >`UPDATE factory.substrate_worker_capacity SET attempted_at=now()
            WHERE owner=${owner} AND node_uid=${node.uid} AND attempted_at IS NULL RETURNING attempted_at::text AS "attemptedAt"`;
            if (!dispatch) throw new Error("Original native capacity dispatch is unsettled");
            row.attemptedAt = dispatch.attemptedAt;
            const result = await run(
              ["create", "-f", "-", "-o", "json"],
              JSON.stringify(row.intent.pool),
            );
            if (result.exitCode !== 0) {
              if (/AlreadyExists|Forbidden|Unauthorized|Invalid/.test(result.stderr))
                await database.client`UPDATE factory.substrate_worker_capacity SET rejected=true WHERE owner=${owner} AND node_uid=${node.uid}`;
              throw new Error(
                "Native capacity creation outcome is unconfirmed; original names and intent retained",
              );
            }
            actual = JSON.parse(result.stdout);
            const confirmed = requireNativeCapacityPool(actual, row.intent.pool, row.attemptedAt);
            await database.client`UPDATE factory.substrate_worker_capacity SET pool=${JSON.stringify({ uid: confirmed.metadata.uid })}::text::jsonb WHERE owner=${owner} AND node_uid=${node.uid}`;
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
          await sql`UPDATE factory.substrate_worker_capacity SET pool=${JSON.stringify({ uid: observed.metadata.uid })}::text::jsonb WHERE owner=${owner} AND node_uid=${node.uid}`;
        if (observed.status?.readyReplicas === 1) ready.push(row.intent.node.resources);
      }
      return { ready, refused: discovered.refused };
    } finally {
      try {
        if (locked) await sql`SELECT pg_advisory_unlock(hashtext('factorybox-worker-create'))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  return {
    ensure,
    async requireReady(resources: { cpuMilli: number; memoryMiB: number }) {
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
