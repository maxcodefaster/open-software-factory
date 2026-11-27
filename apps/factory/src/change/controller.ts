import { and, eq, inArray, isNull, sql as query } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import { change as changeTable } from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { reportFailure } from "../failure-log";
import type { RuntimeAttemptView } from "../runtime/types";
import { createBranchReconciler } from "./branch-reconcile";
import { createChangeCancellation } from "./cancellation";
import { commissionChangeIn } from "./commission";
import type { ImplementationAdmission } from "./requirement-approval";
import { getChangeView, listChangeViews } from "./views";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  stop(attemptID: string): Promise<RuntimeAttemptView | null>;
};

export function createChangeController(
  database: Database,
  runtime: RuntimeController,
  onReady?: (changeID: string) => Promise<void>,
  protectNewBranch?: (changeID: string) => Promise<void>,
  forgeOverride?: ReturnType<typeof createForgejoClient>,
) {
  const {
    FACTORY_FORGEJO_API_URL,
    FACTORY_FORGEJO_PUBLIC_URL,
    FACTORY_FORGEJO_TOKEN,
    FACTORY_FORGEJO_OWNER,
  } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge =
    forgeOverride ??
    createForgejoClient({
      apiURL: FACTORY_FORGEJO_API_URL,
      token: FACTORY_FORGEJO_TOKEN,
    });
  const forgeOrigins = new Set([
    new URL(FACTORY_FORGEJO_API_URL).origin,
    ...(FACTORY_FORGEJO_PUBLIC_URL ? [new URL(FACTORY_FORGEJO_PUBLIC_URL).origin] : []),
  ]);
  const reconciler = createBranchReconciler({ database, forge, onReady, protectNewBranch });
  const cancellation = createChangeCancellation(database, runtime);

  return {
    async recover() {
      await reconciler.recoverPendingBranches();
      const changes = await database.db
        .select({
          id: changeTable.id,
          state: changeTable.state,
          runtimeAttemptID: changeTable.runtimeAttemptId,
        })
        .from(changeTable)
        .where(inArray(changeTable.state, ["branch-pending", "starting", "cancelling"]));
      for (const change of changes) {
        if (change.state === "branch-pending") void reconciler.reconcile(change.id);
        // Runtime recovery observes the recorded attempt itself. Reopening a
        // Change cannot commission a replacement generation after Stop/failure.
        if (change.state === "starting" && !change.runtimeAttemptID) {
          await database.db
            .update(changeTable)
            .set({ state: "active", version: query`${changeTable.version} + 1` })
            .where(
              and(
                eq(changeTable.id, change.id),
                eq(changeTable.state, "starting"),
                isNull(changeTable.runtimeAttemptId),
              ),
            );
        }
        if (change.state === "cancelling") {
          if (change.runtimeAttemptID) {
            void runtime
              .stop(change.runtimeAttemptID)
              .catch(reportFailure("Cancelled change runtime stop"));
          }
          cancellation.observeCancellation(change.id);
        }
      }
    },
    async start(ticketID: string, userID: string, implementation: ImplementationAdmission) {
      const changeID = await commissionChangeIn(database, ticketID, userID, implementation, {
        forge,
        forgeOrigins,
        forgeOwner: FACTORY_FORGEJO_OWNER,
      });
      if (!changeID) return null;
      void reconciler.reconcile(changeID);
      const change = await this.get(changeID);
      if (change?.state === "active") await onReady?.(changeID);
      return change;
    },
    async cancel(changeID: string) {
      await cancellation.cancel(changeID);
      return this.get(changeID);
    },
    async get(changeID: string) {
      return getChangeView(database, changeID);
    },
    async list(projectID: string | undefined, userID: string) {
      return listChangeViews(database, projectID, userID);
    },
    reconcile: reconciler.reconcile,
  };
}
