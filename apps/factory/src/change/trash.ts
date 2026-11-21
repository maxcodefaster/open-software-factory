import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  developmentWorkspace,
  runtimeAttempt,
  ticket,
  verification as verificationRecord,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

type TrashRuntime = { stop(id: string): Promise<unknown> };
type TrashAgent = { stop(id: string): Promise<unknown> };
type TrashVerification = { stopForTrash(id: string): Promise<void> };

export function createTicketTrashController(
  database: ReturnType<typeof createDatabase>,
  runtime: TrashRuntime,
  agent: TrashAgent,
  verification: TrashVerification,
) {
  const running = new Set<string>();
  let closed = false;
  // Both Stop dispatch and confirmation observe the same Ticket-owned attempts.
  function unstoppedAttempts(ticketID: string) {
    return database.db
      .select({ id: runtimeAttempt.id })
      .from(runtimeAttempt)
      .leftJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
      .leftJoin(verificationRecord, eq(verificationRecord.id, runtimeAttempt.verificationId))
      .innerJoin(
        change,
        eq(
          change.id,
          sql<string>`COALESCE(${runtimeAttempt.changeId},${verificationRecord.changeId})`,
        ),
      )
      .where(
        and(
          eq(change.ticketId, ticketID),
          or(
            eq(developmentWorkspace.kind, "ticket"),
            eq(runtimeAttempt.isolatedKind, "verification"),
          ),
          ne(runtimeAttempt.state, "stopped"),
        ),
      );
  }
  async function reconcile(ticketID: string) {
    if (closed || running.has(ticketID)) return;
    running.add(ticketID);
    try {
      // Outside the Ticket transaction: Turn settlement locks Turn before Ticket.
      await database.db
        .update(agentTurn)
        .set({
          state: "stopped",
          ownerToken: null,
          ownerExpiresAt: null,
          outcomeSummary: "Ticket moved to Trash.",
          updatedAt: sql<Date>`now()`,
        })
        .where(
          and(
            eq(agentTurn.ticketId, ticketID),
            isNull(agentTurn.changeId),
            inArray(agentTurn.state, ["pending", "dispatching", "running"]),
          ),
        );
      const changes = await database.db
        .select({ id: change.id })
        .from(change)
        .where(eq(change.ticketId, ticketID));
      for (const change of changes) await agent.stop(change.id);
      for (const change of changes) await verification.stopForTrash(change.id);
      const attempts = await unstoppedAttempts(ticketID);
      for (const attempt of attempts) await runtime.stop(attempt.id);
      for (let observation = 0; observation < 60 && !closed; observation += 1) {
        const [work] = await unstoppedAttempts(ticketID).limit(1);
        if (!work) {
          await database.db
            .update(ticket)
            .set({ trashStopPending: false, trashError: null })
            .where(and(eq(ticket.id, ticketID), isNotNull(ticket.trashedAt)));
          return;
        }
        await Bun.sleep(1_000);
      }
      if (!closed)
        throw new Error("Workspace stop is not confirmed. Retry stopping before restoring.");
    } catch {
      if (!closed)
        await database.db
          .update(ticket)
          .set({ trashError: "Workspace stop is not confirmed. Retry stopping before restoring." })
          .where(and(eq(ticket.id, ticketID), isNotNull(ticket.trashedAt)));
    } finally {
      running.delete(ticketID);
    }
  }
  return {
    async trash(ticketID: string, userID: string) {
      await database.client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        // Match admission's Change/Ticket barrier without locking a Turn.
        // PostgreSQL's OF clause requires unqualified relation names.
        const lockedChange = alias(change, "locked_change");
        const lockedTicket = alias(ticket, "locked_ticket");
        await db
          .select({ id: lockedChange.id })
          .from(lockedChange)
          .innerJoin(lockedTicket, eq(lockedTicket.id, lockedChange.ticketId))
          .where(eq(lockedTicket.id, ticketID))
          .for("update", { of: [lockedChange, lockedTicket] });
        const [savedTicket] = await db
          .select({ projectID: ticket.projectId })
          .from(ticket)
          .where(eq(ticket.id, ticketID))
          .for("update");
        if (!savedTicket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(transaction, userID, savedTicket.projectID);
        const [delivery] = await db
          .select({ id: change.id })
          .from(change)
          .where(and(eq(change.ticketId, ticketID), eq(change.state, "delivering")));
        if (delivery)
          throw new CommandError(
            "conflict",
            "Wait for the approved Delivery to finish before moving this Ticket to Trash",
          );
        await db
          .update(ticket)
          .set({
            trashedAt: sql<Date>`COALESCE(${ticket.trashedAt},now())`,
            trashedBy: sql<string>`COALESCE(${ticket.trashedBy},${userID})`,
            version: sql<number>`CASE WHEN ${ticket.trashedAt} IS NULL THEN ${ticket.version}+1 ELSE ${ticket.version} END`,
            trashStopPending: true,
            trashError: null,
            updatedAt: sql<Date>`now()`,
          })
          .where(eq(ticket.id, ticketID));
        await db
          .update(verificationRecord)
          .set({
            state: "cancelled",
            completedAt: sql<Date>`COALESCE(${verificationRecord.completedAt},now())`,
            updatedAt: sql<Date>`now()`,
          })
          .where(
            and(
              inArray(
                verificationRecord.changeId,
                db.select({ id: change.id }).from(change).where(eq(change.ticketId, ticketID)),
              ),
              inArray(verificationRecord.state, ["pending", "runner-starting", "running"]),
            ),
          );
      });
      void reconcile(ticketID);
    },
    async restore(ticketID: string, userID: string, expectedVersion: number) {
      return database.client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        const [savedTicket] = await db
          .select({
            projectID: ticket.projectId,
            pending: ticket.trashStopPending,
            version: ticket.version,
          })
          .from(ticket)
          .where(eq(ticket.id, ticketID))
          .for("update");
        if (!savedTicket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(transaction, userID, savedTicket.projectID);
        if (savedTicket.version !== expectedVersion)
          throw new CommandError("conflict", "Ticket changed. Refresh Trash before restoring.");
        if (savedTicket.pending)
          throw new CommandError(
            "conflict",
            "Wait for Workspace stop confirmation before restoring",
          );
        await db
          .update(ticket)
          .set({
            trashedAt: null,
            trashedBy: null,
            trashError: null,
            version: sql<number>`${ticket.version}+1`,
            updatedAt: sql<Date>`now()`,
          })
          .where(and(eq(ticket.id, ticketID), isNotNull(ticket.trashedAt)));
      });
    },
    async recover() {
      const tickets = await database.db
        .select({ id: ticket.id })
        .from(ticket)
        .where(and(isNotNull(ticket.trashedAt), eq(ticket.trashStopPending, true)));
      for (const ticket of tickets) void reconcile(ticket.id);
    },
    close() {
      closed = true;
    },
  };
}
