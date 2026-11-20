import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { createDatabase } from "../../db/src/client";
import { requirementRevision, ticket, ticketDocumentRevision } from "../../db/src/schema";
import { requirementDigest } from "../../requirement-domain/src/requirement";
import { createTicketInput } from "../../ticket-domain/src/ticket";

// Server-side product authoring. The caller owns the transaction and authorization.
type Database = ReturnType<typeof createDatabase>["db"];
type DocumentAuthor = {
  inputDigest: string;
  authorKind: "human" | "ai";
  proposalEntryId?: string;
};

/** Write immutable authoring snapshots after the caller checks authority, scope and revision bases. */
export async function appendTicketAuthoringIn(
  db: Pick<Database, "insert">,
  input: {
    ticketId: string;
    createdBy: string;
    title: string;
    description: string;
    canonicalContent: string;
    requirement?: { id: string; ordinal: number };
    document?: DocumentAuthor & {
      id: string;
      ordinal: number;
      requirementRevisionId: string | null;
    };
  },
) {
  const contentDigest = requirementDigest(input.canonicalContent);
  if (input.requirement)
    await db
      .insert(requirementRevision)
      .values({
        id: input.requirement.id,
        ticketId: input.ticketId,
        ordinal: input.requirement.ordinal,
        canonicalContent: input.canonicalContent,
        contentDigest,
        createdBy: input.createdBy,
      })
      .returning({ id: requirementRevision.id });
  if (input.document)
    await db
      .insert(ticketDocumentRevision)
      .values({
        id: input.document.id,
        ticketId: input.ticketId,
        ordinal: input.document.ordinal,
        title: input.title,
        description: input.description,
        canonicalContent: input.canonicalContent,
        contentDigest,
        requirementRevisionId: input.document.requirementRevisionId,
        inputDigest: input.document.inputDigest,
        createdBy: input.createdBy,
        authorKind: input.document.authorKind,
        proposalEntryId: input.document.proposalEntryId ?? null,
      })
      .returning({ id: ticketDocumentRevision.id });
}

/** Initial Ticket authoring only. Callers retain command replay, provenance and approval decisions. */
export async function insertInitialTicketIn(
  db: Pick<Database, "insert">,
  input: {
    id: string;
    projectId: string;
    epicId?: string | null;
    title: string;
    description: string;
    state: "inbox" | "ready";
    createdBy: string;
    // The planning create command checks the saved content itself on replay.
    ignoreExisting?: true;
    authoring?: {
      requirement: { id: string; canonicalContent: string };
      document?: DocumentAuthor & { id: string };
    };
  },
) {
  const insert = db.insert(ticket).values({
    id: input.id,
    projectId: input.projectId,
    epicId: input.epicId ?? null,
    title: input.title,
    description: input.description,
    state: input.state,
    createdBy: input.createdBy,
  });
  const created = await (input.ignoreExisting
    ? insert.onConflictDoNothing({ target: ticket.id })
    : insert
  ).returning({ id: ticket.id });
  if (created.length && input.authoring)
    await appendTicketAuthoringIn(db, {
      ticketId: input.id,
      createdBy: input.createdBy,
      title: input.title,
      description: input.description,
      canonicalContent: input.authoring.requirement.canonicalContent,
      requirement: { id: input.authoring.requirement.id, ordinal: 1 },
      ...(input.authoring.document
        ? {
            document: {
              ...input.authoring.document,
              ordinal: 1,
              requirementRevisionId: input.authoring.requirement.id,
            },
          }
        : {}),
    });
  return created;
}

/** The authoritative create command shared by Zero planning and Factory MCP. */
export async function createPlanningTicketIn(
  db: Pick<Database, "insert" | "select" | "execute">,
  userID: string,
  value: unknown,
) {
  const input = createTicketInput.parse(value);
  const access = z.array(z.object({ allowed: z.boolean() })).parse(
    await db.execute(sql`
    WITH account AS (SELECT user_id FROM factory.account_access WHERE user_id=${userID}::uuid
      AND disabled_at IS NULL AND directory_disabled_at IS NULL FOR SHARE),
    membership AS (SELECT user_id FROM factory.project_membership
      WHERE project_id=${input.projectId}::uuid AND user_id=${userID}::uuid FOR SHARE),
    project AS (SELECT id FROM factory.project WHERE id=${input.projectId}::uuid FOR SHARE)
    SELECT EXISTS(SELECT 1 FROM project) AND EXISTS(SELECT 1 FROM account) AND
      (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID}::uuid)
       OR EXISTS(SELECT 1 FROM membership)) AS allowed
  `),
  );
  if (!access[0]?.allowed) throw new Error("Project not found");
  const state = input.state ?? "inbox";
  const created = await insertInitialTicketIn(db, {
    ...input,
    state,
    createdBy: userID,
    ignoreExisting: true,
  });
  if (!created.length) {
    const previous = await db
      .select({ id: ticket.id })
      .from(ticket)
      .where(
        and(
          eq(ticket.id, input.id),
          eq(ticket.projectId, input.projectId),
          eq(ticket.createdBy, userID),
          eq(ticket.title, input.title),
          eq(ticket.description, input.description),
          eq(ticket.state, state),
        ),
      );
    if (!previous.length)
      throw new Error(
        "This draft was already created with different content. Open the saved Ticket.",
      );
  }
  return { id: input.id, projectId: input.projectId, title: input.title, state };
}
