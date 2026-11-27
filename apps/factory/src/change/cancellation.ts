import { and, eq, inArray, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { change as changeTable, operation as operationTable, runtimeAttempt } from "#db/schema";
import type { RuntimeAttemptView } from "../runtime/types";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  stop(attemptID: string): Promise<RuntimeAttemptView | null>;
};

export function createChangeCancellation(database: Database, runtime: RuntimeController) {
  const cancellationObservers = new Set<string>();

  async function settleCancellingChange(
    changeID: string,
    values:
      | { state: "cancelled"; cancelledAt: ReturnType<typeof query> }
      | { state: "failed"; failure: string },
  ) {
    await database.db
      .update(changeTable)
      .set({ ...values, version: query`${changeTable.version} + 1` })
      .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "cancelling")));
  }

  function observeCancellation(changeID: string) {
    if (cancellationObservers.has(changeID)) return;
    cancellationObservers.add(changeID);
    void (async () => {
      try {
        for (let observation = 0; observation < 360; observation += 1) {
          const rows = await database.db
            .select({
              state: changeTable.state,
              runtimeState: runtimeAttempt.state,
              failure: runtimeAttempt.failure,
            })
            .from(changeTable)
            .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
            .where(eq(changeTable.id, changeID));
          const current = rows[0];
          if (current?.state !== "cancelling") return;
          if (current.runtimeState === null || current.runtimeState === "stopped") {
            await settleCancellingChange(changeID, {
              state: "cancelled",
              cancelledAt: query`now()`,
            });
            return;
          }
          if (current.runtimeState === "failed") {
            await settleCancellingChange(changeID, {
              state: "failed",
              failure: current.failure ?? "Runtime cleanup failed",
            });
            return;
          }
          await Bun.sleep(1_000);
        }
        await settleCancellingChange(changeID, {
          state: "failed",
          failure: "Change cancellation did not settle",
        });
      } finally {
        cancellationObservers.delete(changeID);
      }
    })();
  }

  async function cancel(changeID: string) {
    const projects = await database.db
      .select({ projectID: changeTable.projectId })
      .from(changeTable)
      .where(eq(changeTable.id, changeID));
    const projectID = projects[0]?.projectID;
    if (!projectID) return;
    const change = await database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${projectID}`}))`;
      const [row] = await drizzleTransaction(sql)
        .update(changeTable)
        .set({
          state: "cancelling",
          cancelRequestedAt: query`now()`,
          version: query`${changeTable.version} + 1`,
        })
        .where(
          and(
            eq(changeTable.id, changeID),
            inArray(changeTable.state, ["branch-pending", "starting", "active", "failed"]),
          ),
        )
        .returning({ attemptID: changeTable.runtimeAttemptId });
      return row;
    });
    if (!change) return;
    await database.db
      .update(operationTable)
      .set({
        state: "cancelled",
        activeKey: null,
        completedAt: query`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(operationTable.kind, "delivery.branch_create"),
          eq(operationTable.scopeType, "change"),
          eq(operationTable.scopeId, changeID),
          inArray(operationTable.state, ["pending", "ambiguous"]),
        ),
      );
    if (change.attemptID) await runtime.stop(change.attemptID);
    observeCancellation(changeID);
  }

  return { cancel, observeCancellation };
}
