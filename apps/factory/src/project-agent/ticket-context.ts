import { and, desc, eq, exists, isNull, or, sql as expression } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  change,
  epic,
  project as projectModel,
  requirementRevision,
  ticket,
  ticketDependency,
  ticketDocumentRevision,
} from "../../../../packages/db/src/schema";
import { z } from "zod";

const ticketContext = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    documentId: z.uuid().nullable(),
    title: z.string().max(200),
    description: z.string().max(10000),
    revisionId: z.uuid().nullable(),
    requirement: z.string().max(12000).nullable(),
    truncated: z.boolean(),
    implementationAdmitted: z.boolean(),
  })
  .strict();

export async function admittedTicketContext(
  sql: DatabaseTransaction,
  projectID: string,
  ticketID: string | null,
) {
  if (!ticketID) return undefined;
  const db = drizzleTransaction(sql);
  const document = db
    .select({
      id: ticketDocumentRevision.id,
      content: ticketDocumentRevision.canonicalContent,
    })
    .from(ticketDocumentRevision)
    .where(eq(ticketDocumentRevision.ticketId, ticket.id))
    .orderBy(desc(ticketDocumentRevision.ordinal))
    .limit(1)
    .as("document");
  const revision = db
    .select({
      id: requirementRevision.id,
      content: requirementRevision.canonicalContent,
    })
    .from(requirementRevision)
    .where(eq(requirementRevision.ticketId, ticket.id))
    .orderBy(desc(requirementRevision.ordinal))
    .limit(1)
    .as("revision");
  const content = expression`COALESCE(${document.content},${revision.content})`;
  const rows = await db
    .select({
      id: ticket.id,
      version: expression<number>`${ticket.version}::integer`,
      documentId: document.id,
      title: expression<string>`left(${ticket.title},200)`,
      description: expression<string>`left(${ticket.description},10000)`,
      revisionId: revision.id,
      requirement: expression<string | null>`left(${content},12000)`,
      implementationAdmitted: exists(
        db.select({ id: change.id }).from(change).where(eq(change.ticketId, ticket.id)),
      ),
      truncated: expression<boolean>`length(${ticket.description})>10000 OR COALESCE(length(${content})>12000,false)`,
    })
    .from(ticket)
    .leftJoinLateral(document, expression`true`)
    .leftJoinLateral(revision, expression`true`)
    .where(and(eq(ticket.id, ticketID), eq(ticket.projectId, projectID)));
  if (!rows[0]) throw new Error("Selected Ticket context unavailable");
  return ticketContext.parse(rows[0]);
}

export async function admittedProjectContext(
  sql: DatabaseTransaction,
  projectID: string,
  ticketID: string | null,
) {
  const db = drizzleTransaction(sql);
  const [project] = await db
    .select({
      id: projectModel.id,
      name: projectModel.name,
      defaultBranch: projectModel.defaultBranch,
    })
    .from(projectModel)
    .where(eq(projectModel.id, projectID));
  const relationships = ticketID
    ? await db
        .select({
          source: expression<string>`'epic'::text`,
          id: epic.id,
          title: epic.title,
          version: expression<number>`${epic.version}::integer`,
          relationship: expression<string>`'parent-epic'::text`,
        })
        .from(epic)
        .innerJoin(ticket, eq(ticket.epicId, epic.id))
        .where(and(eq(ticket.id, ticketID), eq(ticket.projectId, projectID)))
        .unionAll(
          db
            .select({
              source: expression<string>`'ticket'::text`,
              id: ticket.id,
              title: ticket.title,
              version: expression<number>`${ticket.version}::integer`,
              relationship: expression<string>`CASE WHEN ${ticketDependency.ticketId}=${ticketID} THEN 'prerequisite' ELSE 'dependent' END`,
            })
            .from(ticketDependency)
            .innerJoin(
              ticket,
              eq(
                ticket.id,
                expression<string>`CASE WHEN ${ticketDependency.ticketId}=${ticketID} THEN ${ticketDependency.prerequisiteId} ELSE ${ticketDependency.ticketId} END`,
              ),
            )
            .where(
              and(
                eq(ticketDependency.projectId, projectID),
                or(
                  eq(ticketDependency.ticketId, ticketID),
                  eq(ticketDependency.prerequisiteId, ticketID),
                ),
                isNull(ticket.trashedAt),
              ),
            ),
        )
        .limit(40)
    : [];
  return { project, relationships };
}
