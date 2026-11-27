import { and, asc, desc, eq, inArray, isNull, ne, sql as query } from "drizzle-orm";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentTurnIntent,
  requirementApproval,
  requirementRevision,
  technicalDesignRevision,
  ticketConversation,
  ticketDocumentRevision,
} from "#db/schema";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { technicalPlanningOutstandingIn } from "../technical-design/api";

export type ImplementationAdmission = {
  commandID: string;
  revisionID: string;
  technicalDesignRevisionID?: string;
  codingReasoning?: CodingReasoning;
  expectedBaseSHA?: string;
  admitBuild(sql: DatabaseTransaction, changeID: string): Promise<unknown>;
};

export async function ensureImplementationApprovalIn(
  sql: DatabaseTransaction,
  ticketID: string,
  projectID: string,
  userID: string,
  implementation: ImplementationAdmission,
) {
  const db = drizzleTransaction(sql);
  const [command] = await db
    .select({
      ticketID: agentTurn.ticketId,
      userID: agentTurn.createdBy,
      revisionID: query<string>`${agentTurn.authority}->>'requirementRevisionId'`,
      kind: query<string>`${agentTurn.input}->>'kind'`,
    })
    .from(agentTurn)
    .where(eq(agentTurn.commandId, implementation.commandID));
  if (
    command &&
    (command.ticketID !== ticketID ||
      command.userID !== userID ||
      command.revisionID !== implementation.revisionID ||
      command.kind !== "change-start")
  )
    throw new CommandError(
      "conflict",
      "The implementation command identity was reused with different input",
    );
  const [latest] = await db
    .select({ id: requirementRevision.id })
    .from(requirementRevision)
    .where(eq(requirementRevision.ticketId, ticketID))
    .orderBy(desc(requirementRevision.ordinal))
    .limit(1);
  if (latest?.id !== implementation.revisionID)
    throw new CommandError(
      "conflict",
      "The Ticket changed. Review the current requirements before implementing.",
    );
  const [document] = await db
    .select({ revisionID: ticketDocumentRevision.requirementRevisionId })
    .from(ticketDocumentRevision)
    .where(eq(ticketDocumentRevision.ticketId, ticketID))
    .orderBy(desc(ticketDocumentRevision.ordinal))
    .limit(1);
  if (document && document.revisionID !== implementation.revisionID)
    throw new CommandError("conflict", "Finish the current specification before implementing.");
  if (await technicalPlanningOutstandingIn(sql, ticketID, implementation.revisionID))
    throw new CommandError(
      "conflict",
      "Finish Technical Planning before implementing this Ticket.",
    );
  const [technical] = await db
    .select({
      id: technicalDesignRevision.id,
      requirementRevisionID: technicalDesignRevision.requirementRevisionId,
    })
    .from(technicalDesignRevision)
    .where(eq(technicalDesignRevision.ticketId, ticketID))
    .orderBy(desc(technicalDesignRevision.ordinal))
    .limit(1);
  if (technical || implementation.technicalDesignRevisionID) {
    await projectDevelopmentAuthorityIn(sql, userID, projectID);
    if (
      technical?.id !== implementation.technicalDesignRevisionID ||
      technical?.requirementRevisionID !== implementation.revisionID
    )
      throw new CommandError(
        "conflict",
        "Review the current technical design for these exact requirements before implementing.",
      );
  }
  const [approval] = await db
    .select({
      revisionID: requirementApproval.requirementRevisionId,
      technicalID: requirementApproval.technicalDesignRevisionId,
    })
    .from(requirementApproval)
    .where(eq(requirementApproval.ticketId, ticketID));
  if (approval && approval.revisionID !== implementation.revisionID)
    throw new CommandError("conflict", "This Ticket already implements different requirements.");
  if (approval && approval.technicalID !== (implementation.technicalDesignRevisionID ?? null))
    throw new CommandError("conflict", "This Ticket keeps its approved technical design.");
  if (!approval)
    await db.insert(requirementApproval).values({
      id: crypto.randomUUID(),
      ticketId: ticketID,
      requirementRevisionId: implementation.revisionID,
      technicalDesignRevisionId: implementation.technicalDesignRevisionID ?? null,
      approvedBy: userID,
    });
  const [busy] = await db
    .select({ id: agentTurn.id })
    .from(agentTurn)
    .where(
      and(
        eq(agentTurn.ticketId, ticketID),
        isNull(agentTurn.changeId),
        inArray(agentTurn.state, ["pending", "dispatching", "running"]),
      ),
    );
  if (busy)
    throw new CommandError("conflict", "Wait for the Requirements response before implementing.");
  await db
    .update(ticketConversation)
    .set({
      mode: "build",
      version: query`${ticketConversation.version} + 1`,
      updatedAt: query`now()`,
    })
    .where(and(eq(ticketConversation.ticketId, ticketID), ne(ticketConversation.mode, "build")));
}

export async function admitChangeBuildIn(
  sql: DatabaseTransaction,
  changeID: string,
  implementation: ImplementationAdmission,
) {
  const db = drizzleTransaction(sql);
  const [bootstrap] = await db
    .select({
      commandID: agentTurn.commandId,
      reasoning: query<string | null>`${agentTurn.authority}->>'codingReasoning'`,
    })
    .from(agentTurn)
    .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
    .where(and(eq(agentTurn.changeId, changeID), eq(changeAgentTurnIntent.bootstrap, true)))
    .orderBy(asc(agentTurn.createdAt))
    .limit(1);
  // A second viewer commissioning already-admitted work does not start a
  // second inference. The original command can still replay its exact input.
  if (!bootstrap || bootstrap.commandID === implementation.commandID)
    await implementation.admitBuild(sql, changeID);
  else if (implementation.codingReasoning && implementation.codingReasoning !== bootstrap.reasoning)
    throw new CommandError(
      "conflict",
      "This Change keeps its original reasoning. Start a new Change to choose different reasoning.",
    );
}
