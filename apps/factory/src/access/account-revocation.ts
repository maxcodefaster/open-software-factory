import { and, eq, inArray, isNotNull, notExists } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  administrator,
  agentTurn,
  change,
  changeWriter,
  projectMembership,
} from "../../../../packages/db/src/schema";

export function createAccountRevocation(options: {
  database: ReturnType<typeof createDatabase>;
  sweepRuntime: () => Promise<void>;
  reconcileEditor: (userID: string) => Promise<void>;
  reconcileSources: (userID: string) => Promise<void>;
  stopRuntime: (attemptID: string) => Promise<unknown>;
  stopAgent: (changeID: string) => Promise<unknown>;
  reconcileForge: (userID: string) => Promise<unknown>;
}) {
  return async (userID: string, disabled: boolean) => {
    await options.sweepRuntime();
    // Forge reconciliation may remain pending and be retried. Only lost
    // authority invalidates newly opened editing access on those retries.
    await options.reconcileEditor(userID);
    await options.reconcileSources(userID);
    const db = drizzleTransaction(options.database.client);
    const administratorAccess = db
      .select({ userID: administrator.userId })
      .from(administrator)
      .where(eq(administrator.userId, userID));
    const humanWork = await db
      .select({ attemptID: change.runtimeAttemptId })
      .from(changeWriter)
      .innerJoin(change, eq(change.id, changeWriter.changeId))
      .where(
        and(
          eq(changeWriter.userId, userID),
          isNotNull(change.runtimeAttemptId),
          disabled
            ? undefined
            : and(
                notExists(administratorAccess),
                notExists(
                  db
                    .select({ userID: projectMembership.userId })
                    .from(projectMembership)
                    .where(
                      and(
                        eq(projectMembership.projectId, change.projectId),
                        eq(projectMembership.userId, userID),
                        eq(projectMembership.role, "developer"),
                      ),
                    ),
                ),
              ),
        ),
      );
    for (const work of humanWork) if (work.attemptID) await options.stopRuntime(work.attemptID);
    const changes = await db
      .selectDistinct({ id: change.id })
      .from(agentTurn)
      .innerJoin(change, eq(change.id, agentTurn.changeId))
      .where(
        and(
          eq(agentTurn.createdBy, userID),
          inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
          disabled
            ? undefined
            : and(
                notExists(administratorAccess),
                notExists(
                  db
                    .select({ userID: projectMembership.userId })
                    .from(projectMembership)
                    .where(
                      and(
                        eq(projectMembership.projectId, change.projectId),
                        eq(projectMembership.userId, userID),
                      ),
                    ),
                ),
              ),
        ),
      );
    for (const change of changes) await options.stopAgent(change.id);
    await options.reconcileForge(userID);
  };
}
