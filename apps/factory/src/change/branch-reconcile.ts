import { and, DrizzleQueryError, eq, inArray, isNull, lt, or, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { change as changeTable, operation as operationTable } from "#db/schema";
import {
  type createForgejoClient,
  ForgeAmbiguousWriteError,
  ForgeConflictError,
} from "#forge/forge";

type Database = ReturnType<typeof createDatabase>;
type ReservedConnection = Awaited<ReturnType<Database["client"]["reserve"]>>;
type ReservedDB = Omit<Database["db"], "transaction">;

async function withReservedTransaction(lock: ReservedConnection, work: () => Promise<void>) {
  await lock`BEGIN`;
  try {
    await work();
    await lock`COMMIT`;
  } catch (cause) {
    await lock`ROLLBACK`;
    throw cause;
  }
}

function executingBranchOperation(operationID: string) {
  return and(
    eq(operationTable.id, operationID),
    eq(operationTable.kind, "delivery.branch_create"),
    eq(operationTable.state, "executing"),
  );
}

export function createBranchReconciler(options: {
  database: Database;
  forge: ReturnType<typeof createForgejoClient>;
  onReady?: ((changeID: string) => Promise<void>) | undefined;
  protectNewBranch?: ((changeID: string) => Promise<void>) | undefined;
}) {
  const { database, forge, onReady, protectNewBranch } = options;
  const running = new Set<string>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();

  function retry(changeID: string, delay: number) {
    clearTimeout(retries.get(changeID));
    const timer = setTimeout(() => {
      retries.delete(changeID);
      void reconcile(changeID);
    }, delay);
    timer.unref();
    retries.set(changeID, timer);
  }

  async function markAmbiguous(
    db: ReservedDB,
    operationID: string,
    changeID: string,
    error: string,
    delaySeconds: number,
  ) {
    const reconcileAfter =
      delaySeconds > 0
        ? query`to_jsonb((now() + (${delaySeconds} * interval '1 second'))::text)`
        : query`to_jsonb(now()::text)`;
    await db
      .update(operationTable)
      .set({
        state: "ambiguous",
        leaseOwner: null,
        leaseExpiresAt: null,
        payload: query`jsonb_set(${operationTable.payload}, '{reconcileAfter}', ${reconcileAfter})`,
        error,
        updatedAt: query`now()`,
      })
      .where(executingBranchOperation(operationID));
    retry(changeID, Math.max(delaySeconds, 1) * 1_000);
  }

  async function reconcile(changeID: string) {
    if (running.has(changeID)) return;
    // Explicit recovery supersedes a previously scheduled retry. A successful
    // reconciliation must not leave that callback using an obsolete lifetime.
    clearTimeout(retries.get(changeID));
    retries.delete(changeID);
    running.add(changeID);
    try {
      for (;;) {
        const claimed = await database.db
          .update(operationTable)
          .set({
            state: "executing",
            payload: query`${operationTable.payload} || jsonb_build_object(
              'attemptCount', COALESCE((${operationTable.payload}->>'attemptCount')::integer, 0) + 1,
              'leaseGeneration', COALESCE((${operationTable.payload}->>'leaseGeneration')::bigint, 0) + 1
            )`,
            leaseOwner: "factory-server",
            leaseExpiresAt: query`now() + interval '30 seconds'`,
            updatedAt: query`now()`,
          })
          .from(changeTable)
          .where(
            and(
              eq(operationTable.kind, "delivery.branch_create"),
              eq(operationTable.scopeType, "change"),
              eq(operationTable.scopeId, changeID),
              eq(changeTable.id, changeID),
              eq(changeTable.state, "branch-pending"),
              inArray(operationTable.state, ["pending", "ambiguous"]),
              query`COALESCE((${operationTable.payload}->>'reconcileAfter')::timestamptz, ${operationTable.createdAt}) <= now()`,
              or(
                isNull(operationTable.leaseExpiresAt),
                lt(operationTable.leaseExpiresAt, query`now()`),
              ),
            ),
          )
          .returning({
            operationID: operationTable.id,
            owner: query<string>`${operationTable.payload}->>'repositoryOwner'`,
            repository: query<string>`${operationTable.payload}->>'repositoryName'`,
            branch: query<string>`${operationTable.payload}->>'branchName'`,
            startSHA: query<string>`${operationTable.payload}->>'startSha'`,
            attempts: query<number>`(${operationTable.payload}->>'attemptCount')::integer`,
            userID: changeTable.createdBy,
          });
        const operation = claimed[0];
        if (!operation) return;
        const repository = { owner: operation.owner, name: operation.repository };
        const lock = await database.client.reserve();
        const db = drizzleTransaction(lock);
        await lock`SELECT pg_advisory_lock(hashtext(${`forge:${operation.owner}/${operation.repository}`}))`;
        try {
          let branch: Awaited<ReturnType<typeof forge.ensureBranch>>;
          try {
            // Forgejo accepts protection for a branch that does not exist yet.
            // Never create a temporarily writable Change branch.
            try {
              await protectNewBranch?.(changeID);
            } catch {
              throw new ForgeAmbiguousWriteError("Change branch protection is not confirmed");
            }
            const existingBranch = await forge.getBranch(repository, operation.branch);
            if (!existingBranch) {
              const currentDefault = await forge.getDefaultBranch(repository);
              if (currentDefault.headSha !== operation.startSHA) {
                throw new ForgeConflictError(
                  "Project default branch moved before Change branch creation",
                );
              }
            }
            branch = await forge.ensureBranch(repository, operation.branch, operation.startSHA);
          } catch (cause) {
            if (cause instanceof ForgeAmbiguousWriteError && operation.attempts < 12) {
              await markAmbiguous(
                db,
                operation.operationID,
                changeID,
                cause.message,
                Math.min(2 ** operation.attempts, 30),
              );
              return;
            }
            const message = cause instanceof Error ? cause.message : "branch creation failed";
            await withReservedTransaction(lock, async () => {
              await db
                .update(operationTable)
                .set({
                  state: "failed",
                  activeKey: null,
                  completedAt: query`now()`,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  error: message,
                  updatedAt: query`now()`,
                })
                .where(executingBranchOperation(operation.operationID));
              await db
                .update(changeTable)
                .set({
                  state: "failed",
                  failure: message,
                  version: query`${changeTable.version} + 1`,
                })
                .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "branch-pending")));
            });
            return;
          }
          try {
            await withReservedTransaction(lock, async () => {
              await db
                .update(operationTable)
                .set({
                  state: "succeeded",
                  activeKey: null,
                  result: { observedHeadSha: branch.headSha },
                  completedAt: query`now()`,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  updatedAt: query`now()`,
                  error: null,
                })
                .where(executingBranchOperation(operation.operationID));
              await db
                .update(changeTable)
                .set({ state: "active", version: query`${changeTable.version} + 1` })
                .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "branch-pending")));
            });
          } catch (cause) {
            const failure = cause instanceof DrizzleQueryError ? cause.cause : cause;
            await markAmbiguous(
              db,
              operation.operationID,
              changeID,
              failure instanceof Error ? failure.message : "branch result persistence failed",
              0,
            );
            return;
          }
        } finally {
          await lock`SELECT pg_advisory_unlock(hashtext(${`forge:${operation.owner}/${operation.repository}`}))`;
          lock.release();
        }
        await onReady?.(changeID);
        return;
      }
    } finally {
      running.delete(changeID);
    }
  }

  async function recoverPendingBranches() {
    await database.db
      .update(operationTable)
      .set({
        state: "ambiguous",
        leaseOwner: null,
        leaseExpiresAt: null,
        payload: query`jsonb_set(${operationTable.payload}, '{reconcileAfter}', to_jsonb(now()::text))`,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(operationTable.kind, "delivery.branch_create"),
          inArray(operationTable.state, ["executing", "ambiguous"]),
        ),
      );
  }

  return { reconcile, recoverPendingBranches };
}
