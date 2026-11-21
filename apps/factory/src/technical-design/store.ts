import { createHash } from "node:crypto";
import { and, desc, eq, exists, sql as expression, notExists } from "drizzle-orm";
import type { z } from "zod";
import type { sourceCitationInput } from "../../../../packages/conversation-domain/src/conversation";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  requirementApproval,
  requirementRevision,
  technicalDesignRevision,
  ticket,
  ticketDocumentRevision,
} from "../../../../packages/db/src/schema";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";
import {
  type TechnicalDesignContent,
  type TechnicalPlanningBase,
  technicalDesignContentInput,
  validateTechnicalDesignCoverage,
} from "../../../../packages/requirement-domain/src/technical-design";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { diagramRendererVersion } from "./diagrams";

export async function technicalPlanningOutstandingIn(
  sql: DatabaseTransaction,
  ticketID: string,
  requirementRevisionID: string | null,
) {
  const db = drizzleTransaction(sql);
  const request = db
    .select({ id: agentTurn.id })
    .from(agentTurn)
    .where(
      and(
        eq(agentTurn.ticketId, ticketID),
        expression`${agentTurn.input}->>'intent'='technical-planning'`,
      ),
    )
    .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
    .limit(1)
    .as("request");
  const [outstanding] = await db
    .select({ id: request.id })
    .from(request)
    .where(
      notExists(
        db
          .select({ id: technicalDesignRevision.id })
          .from(technicalDesignRevision)
          .where(
            and(
              eq(technicalDesignRevision.ticketId, ticketID),
              requirementRevisionID
                ? eq(technicalDesignRevision.requirementRevisionId, requirementRevisionID)
                : expression`false`,
              eq(technicalDesignRevision.planningTurnId, request.id),
            ),
          ),
      ),
    );
  return Boolean(outstanding);
}

export async function saveTechnicalDesignIn(
  sql: DatabaseTransaction,
  input: {
    id: string;
    ticketID: string;
    userID: string;
    base: TechnicalPlanningBase;
    content: TechnicalDesignContent;
    citations: z.infer<typeof sourceCitationInput>[];
    renders: (string | null)[];
    turnID?: string;
  },
) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${input.ticketID}`}))`;
  const db = drizzleTransaction(sql);
  const [savedTicket] = await db
    .select({
      projectID: ticket.projectId,
      trashed: expression<boolean>`${ticket.trashedAt} IS NOT NULL OR ${ticket.convertedToEpicId} IS NOT NULL OR ${ticket.state} IN ('cancelled','done')`,
      admitted: exists(
        db
          .select({ id: requirementApproval.id })
          .from(requirementApproval)
          .where(eq(requirementApproval.ticketId, ticket.id)),
      ),
    })
    .from(ticket)
    .where(eq(ticket.id, input.ticketID))
    .for("update");
  if (!savedTicket) throw new CommandError("not-found", "Ticket not found.");
  await projectDevelopmentAuthorityIn(sql, input.userID, savedTicket.projectID);
  const content = technicalDesignContentInput.parse(input.content);
  const canonical = JSON.stringify(content);
  if (Buffer.byteLength(canonical) > 96 * 1024)
    throw new CommandError(
      "conflict",
      "Shorten the technical design before saving. Your draft is retained.",
    );
  const digest = createHash("sha256").update(canonical).digest("hex");
  const [replay] = await db
    .select({
      contentDigest: technicalDesignRevision.contentDigest,
      userID: technicalDesignRevision.createdBy,
      ticketID: technicalDesignRevision.ticketId,
      previousID: technicalDesignRevision.previousRevisionId,
      productID: technicalDesignRevision.requirementRevisionId,
      sourceCommit: technicalDesignRevision.sourceCommit,
      requestID: technicalDesignRevision.planningTurnId,
    })
    .from(technicalDesignRevision)
    .where(eq(technicalDesignRevision.id, input.id));
  if (replay) {
    if (
      replay.contentDigest !== digest ||
      replay.userID !== input.userID ||
      replay.ticketID !== input.ticketID ||
      replay.previousID !== input.base.previousDesignId ||
      replay.productID !== input.base.requirementRevisionId ||
      replay.sourceCommit !== input.base.sourceCommit ||
      replay.requestID !== (input.base.requestId ?? null)
    )
      throw new CommandError("conflict", "This technical design command has different input.");
    return;
  }
  const [revision] = await db
    .select({ id: requirementRevision.id, canonical: requirementRevision.canonicalContent })
    .from(requirementRevision)
    .where(eq(requirementRevision.ticketId, input.ticketID))
    .orderBy(desc(requirementRevision.ordinal))
    .limit(1);
  const [document] = await db
    .select({
      id: ticketDocumentRevision.id,
      revisionID: ticketDocumentRevision.requirementRevisionId,
    })
    .from(ticketDocumentRevision)
    .where(eq(ticketDocumentRevision.ticketId, input.ticketID))
    .orderBy(desc(ticketDocumentRevision.ordinal))
    .limit(1);
  const [previous] = await db
    .select({ id: technicalDesignRevision.id, ordinal: technicalDesignRevision.ordinal })
    .from(technicalDesignRevision)
    .where(eq(technicalDesignRevision.ticketId, input.ticketID))
    .orderBy(desc(technicalDesignRevision.ordinal))
    .limit(1);
  if (
    savedTicket.admitted ||
    savedTicket.trashed ||
    revision?.id !== input.base.requirementRevisionId ||
    (document?.id ?? null) !== input.base.documentId ||
    (document && document.revisionID !== revision?.id) ||
    (previous?.id ?? null) !== input.base.previousDesignId
  )
    throw new CommandError(
      "conflict",
      "The Ticket changed. Plan against the current product specification.",
    );
  try {
    validateTechnicalDesignCoverage(
      content,
      requirementContentInput.parse(JSON.parse(revision.canonical)).acceptanceCriteria,
    );
  } catch {
    throw new CommandError(
      "conflict",
      "Map every product acceptance criterion to a concrete validation check.",
    );
  }
  if (input.renders.length !== content.diagrams.length)
    throw new CommandError("conflict", "Every architecture diagram needs a rendering outcome.");
  await db.insert(technicalDesignRevision).values({
    id: input.id,
    ticketId: input.ticketID,
    requirementRevisionId: input.base.requirementRevisionId,
    previousRevisionId: input.base.previousDesignId,
    ordinal: (previous?.ordinal ?? 0) + 1,
    sourceCommit: input.base.sourceCommit,
    canonicalContent: canonical,
    contentDigest: digest,
    citations: input.citations,
    diagramRenders: input.renders,
    rendererVersion: diagramRendererVersion,
    createdBy: input.userID,
    authorKind: input.turnID ? "ai" : "human",
    turnId: input.turnID ?? null,
    planningTurnId: input.base.requestId ?? null,
  });
}
