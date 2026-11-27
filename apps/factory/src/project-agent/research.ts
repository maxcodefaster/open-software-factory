import { and, asc, desc, eq, exists, gt, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { attachmentIDs } from "#conversation-domain/attachments";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  administrator,
  epic,
  knowledgePage,
  projectMembership,
  requirementRevision,
  ticket,
  ticketDependency,
  ticketDocumentRevision,
} from "#db/schema";
import { createAccessController } from "../access/api";
import { CommandError } from "../command-error";

export const researchSource = z.enum(["knowledge", "ticket", "epic"]);
export const projectSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(500),
  source: researchSource.optional(),
});
export const projectReadInput = z.strictObject({
  source: researchSource,
  id: z.uuid(),
  offset: z.number().int().min(0).max(2_000_000).default(0),
  expectedVersion: z.number().int().nonnegative().optional(),
});
export const researchHit = z.object({
  source: researchSource,
  id: z.uuid(),
  label: z.string(),
  excerpt: z.string(),
});
export const researchDocument = researchHit.extend({
  body: z.string(),
  attachments: z.array(z.uuid()).optional(),
  version: z.number().int(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nullable(),
  relationships: z
    .array(
      z.object({
        source: researchSource,
        id: z.uuid(),
        label: z.string(),
        relationship: z.enum([
          "parent-epic",
          "member-ticket",
          "prerequisite",
          "dependent",
          "parent-page",
          "child-page",
        ]),
      }),
    )
    .max(40),
});
type Database = ReturnType<typeof createDatabase>;
type Source = z.infer<typeof researchSource>;

export function researchQuery(value: string) {
  return value.normalize("NFKC").trim().slice(0, 500);
}

export async function searchResearch(
  database: Database,
  projectID: string,
  userID: string,
  query: string,
  source?: Source,
) {
  await createAccessController(database).requireProject(userID, projectID);
  const text = researchQuery(query);
  if (!/[\p{L}\p{N}]/u.test(text)) return [];
  // Each branch keeps its indexed predicate. No generic search engine or code copy.
  const db = database.db;
  const input = db.$with("input").as(
    db
      .select({
        q: sql`websearch_to_tsquery('simple',${text})`.as("q"),
        text: sql<string>`lower(${text})`.as("text"),
      })
      .from(sql`(SELECT 1) AS input_seed`),
  );
  const newerDocument = alias(ticketDocumentRevision, "newer_document");
  const newerRequirement = alias(requirementRevision, "newer_requirement");
  const ticketScope = and(
    eq(ticket.projectId, projectID),
    ne(ticket.state, "cancelled"),
    isNull(ticket.trashedAt),
    isNull(ticket.convertedToEpicId),
    source ? sql<boolean>`${source}='ticket'` : undefined,
  );
  const ticketVector = sql`factory.research_vector(${ticket.title},${ticket.description})`;
  const documentVector = sql`factory.research_vector(${ticketDocumentRevision.title},${ticketDocumentRevision.canonicalContent})`;
  const epicVector = sql`factory.research_vector(${epic.title},${epic.description})`;
  const knowledgeVector = sql`factory.research_vector(${knowledgePage.title},${knowledgePage.currentBody})`;
  const candidates = db.$with("candidates").as(
    db
      .select({
        source: sql<Source>`'ticket'::text`.as("source"),
        id: ticket.id,
        label: sql<string>`${ticket.title}`.as("label"),
        body: sql<string>`${ticket.description}`.as("body"),
        updatedAt: ticket.updatedAt,
        vector: ticketVector.as("vector"),
      })
      .from(ticket)
      .crossJoin(input)
      .where(
        and(
          ticketScope,
          sql<boolean>`(${ticketVector} @@ ${input.q} OR lower(${ticket.title}) % ${input.text} OR
            lower(${ticket.title})=${input.text} OR
            'tck-'||left(replace(${ticket.id}::text,'-',''),6)=${input.text} OR ${ticket.id}::text=${input.text})`,
        ),
      )
      .unionAll(
        db
          .select({
            source: sql<Source>`'ticket'::text`,
            id: ticket.id,
            label: ticket.title,
            body: ticketDocumentRevision.canonicalContent,
            updatedAt: ticket.updatedAt,
            vector: documentVector,
          })
          .from(ticketDocumentRevision)
          .innerJoin(ticket, eq(ticket.id, ticketDocumentRevision.ticketId))
          .crossJoin(input)
          .where(
            and(
              ticketScope,
              sql<boolean>`${documentVector} @@ ${input.q}`,
              notExists(
                db
                  .select({ id: newerDocument.id })
                  .from(newerDocument)
                  .where(
                    and(
                      eq(newerDocument.ticketId, ticket.id),
                      gt(newerDocument.ordinal, ticketDocumentRevision.ordinal),
                    ),
                  ),
              ),
            ),
          ),
      )
      .unionAll(
        db
          .select({
            source: sql<Source>`'ticket'::text`,
            id: ticket.id,
            label: ticket.title,
            body: requirementRevision.canonicalContent,
            updatedAt: ticket.updatedAt,
            vector: sql`factory.research_vector(${ticket.title},${requirementRevision.canonicalContent})`,
          })
          .from(requirementRevision)
          .innerJoin(ticket, eq(ticket.id, requirementRevision.ticketId))
          .crossJoin(input)
          .where(
            and(
              ticketScope,
              sql<boolean>`factory.research_vector('',${requirementRevision.canonicalContent}) @@ ${input.q}`,
              notExists(
                db
                  .select({ id: ticketDocumentRevision.id })
                  .from(ticketDocumentRevision)
                  .where(eq(ticketDocumentRevision.ticketId, ticket.id)),
              ),
              notExists(
                db
                  .select({ id: newerRequirement.id })
                  .from(newerRequirement)
                  .where(
                    and(
                      eq(newerRequirement.ticketId, ticket.id),
                      gt(newerRequirement.ordinal, requirementRevision.ordinal),
                    ),
                  ),
              ),
            ),
          ),
      )
      .unionAll(
        db
          .select({
            source: sql<Source>`'epic'::text`,
            id: epic.id,
            label: epic.title,
            body: epic.description,
            updatedAt: epic.updatedAt,
            vector: epicVector,
          })
          .from(epic)
          .crossJoin(input)
          .where(
            and(
              eq(epic.projectId, projectID),
              source ? sql<boolean>`${source}='epic'` : undefined,
              sql<boolean>`(${epicVector} @@ ${input.q} OR lower(${epic.title}) % ${input.text} OR
                lower(${epic.title})=${input.text} OR ${epic.id}::text=${input.text})`,
            ),
          ),
      )
      .unionAll(
        db
          .select({
            source: sql<Source>`'knowledge'::text`,
            id: knowledgePage.id,
            label: knowledgePage.title,
            body: knowledgePage.currentBody,
            updatedAt: knowledgePage.updatedAt,
            vector: knowledgeVector,
          })
          .from(knowledgePage)
          .crossJoin(input)
          .where(
            and(
              eq(knowledgePage.projectId, projectID),
              eq(knowledgePage.state, "active"),
              source ? sql<boolean>`${source}='knowledge'` : undefined,
              sql<boolean>`(${knowledgeVector} @@ ${input.q} OR lower(${knowledgePage.title}) % ${input.text} OR
                lower(${knowledgePage.title})=${input.text} OR ${knowledgePage.id}::text=${input.text})`,
            ),
          ),
      ),
  );
  const rank = sql<number>`(CASE WHEN lower(${candidates.label})=${input.text} OR
    ${candidates.id}::text=${input.text} OR
    'tck-'||left(replace(${candidates.id}::text,'-',''),6)=${input.text} THEN 10 ELSE 0 END
    + ts_rank_cd(${candidates.vector},${input.q}) + similarity(lower(${candidates.label}),${input.text}))`;
  const ranked = db.$with("ranked").as(
    db
      .selectDistinctOn([candidates.source, candidates.id], {
        source: candidates.source,
        id: candidates.id,
        label: candidates.label,
        body: candidates.body,
        updatedAt: candidates.updatedAt,
        rank: rank.as("rank"),
      })
      .from(candidates)
      .crossJoin(input)
      .where(
        or(
          exists(
            db
              .select({ id: administrator.userId })
              .from(administrator)
              .where(eq(administrator.userId, userID)),
          ),
          exists(
            db
              .select({ id: projectMembership.userId })
              .from(projectMembership)
              .where(
                and(
                  eq(projectMembership.projectId, projectID),
                  eq(projectMembership.userId, userID),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(candidates.source), asc(candidates.id), desc(rank)),
  );
  const searchInput = db.select({ q: input.q }).from(input);
  const rows = await db
    .with(input, candidates, ranked)
    .select({
      source: ranked.source,
      id: ranked.id,
      label: ranked.label,
      excerpt: sql<string>`replace(replace(ts_headline('simple',${ranked.body},(${searchInput}),
        'MaxWords=60,MinWords=10,MaxFragments=1'),'<b>',''),'</b>','')`,
    })
    .from(ranked)
    .orderBy(desc(ranked.rank), desc(ranked.updatedAt), asc(ranked.id))
    .limit(8);
  return rows.map((row) => researchHit.parse({ ...row, excerpt: row.excerpt.slice(0, 1200) }));
}

export async function readResearch(
  database: Database,
  projectID: string,
  userID: string,
  source: Source,
  id: string,
  offset = 0,
  expectedVersion?: number,
) {
  z.number().int().min(0).max(2_000_000).parse(offset);
  return database.client.begin(async (transaction) => {
    const { projectAuthorityIn } = await import("../access/authority");
    await projectAuthorityIn(transaction, userID, projectID);
    const db = drizzleTransaction(transaction);
    const document = db
      .select({ body: ticketDocumentRevision.canonicalContent })
      .from(ticketDocumentRevision)
      .where(eq(ticketDocumentRevision.ticketId, ticket.id))
      .orderBy(desc(ticketDocumentRevision.ordinal))
      .limit(1);
    const requirement = db
      .select({ body: requirementRevision.canonicalContent })
      .from(requirementRevision)
      .where(eq(requirementRevision.ticketId, ticket.id))
      .orderBy(desc(requirementRevision.ordinal))
      .limit(1);
    const ticketScope = and(
      eq(ticket.projectId, projectID),
      ne(ticket.state, "cancelled"),
      isNull(ticket.trashedAt),
      isNull(ticket.convertedToEpicId),
    );
    const rows =
      source === "ticket"
        ? await db
            .select({
              id: ticket.id,
              label: ticket.title,
              version: ticket.version,
              body: sql<string>`${ticket.description} || E'\n' || coalesce((${document}),(${requirement}),'')`,
            })
            .from(ticket)
            .where(and(eq(ticket.id, id), ticketScope))
        : source === "epic"
          ? await db
              .select({
                id: epic.id,
                label: epic.title,
                version: epic.version,
                body: epic.description,
              })
              .from(epic)
              .where(and(eq(epic.id, id), eq(epic.projectId, projectID)))
          : await db
              .select({
                id: knowledgePage.id,
                label: knowledgePage.title,
                version: knowledgePage.version,
                body: knowledgePage.currentBody,
              })
              .from(knowledgePage)
              .where(
                and(
                  eq(knowledgePage.id, id),
                  eq(knowledgePage.projectId, projectID),
                  eq(knowledgePage.state, "active"),
                ),
              );
    const row = rows[0];
    if (!row) throw new CommandError("not-found", "Project source is unavailable");
    if (expectedVersion !== undefined && row.version !== expectedVersion)
      throw new CommandError("conflict", "Project source changed. Read its current first page");
    const parent = alias(knowledgePage, "parent");
    const parentID = db
      .select({ id: parent.parentId })
      .from(parent)
      .where(and(eq(parent.id, id), eq(parent.projectId, projectID)));
    const relations =
      source === "ticket"
        ? await db
            .select({
              source: sql<string>`'epic'::text`,
              id: epic.id,
              label: epic.title,
              relationship: sql<string>`'parent-epic'::text`,
            })
            .from(epic)
            .innerJoin(ticket, eq(ticket.epicId, epic.id))
            .where(and(eq(ticket.id, id), eq(ticket.projectId, projectID)))
            .unionAll(
              db
                .select({
                  source: sql<string>`'ticket'::text`,
                  id: ticket.id,
                  label: ticket.title,
                  relationship: sql<string>`CASE WHEN ${ticketDependency.ticketId}=${id} THEN 'prerequisite' ELSE 'dependent' END`,
                })
                .from(ticketDependency)
                .innerJoin(
                  ticket,
                  sql<boolean>`${ticket.id}=CASE WHEN ${ticketDependency.ticketId}=${id} THEN ${ticketDependency.prerequisiteId} ELSE ${ticketDependency.ticketId} END`,
                )
                .where(
                  and(
                    eq(ticketDependency.projectId, projectID),
                    or(eq(ticketDependency.ticketId, id), eq(ticketDependency.prerequisiteId, id)),
                    isNull(ticket.trashedAt),
                    ne(ticket.state, "cancelled"),
                    isNull(ticket.convertedToEpicId),
                  ),
                ),
            )
            .limit(40)
        : source === "epic"
          ? await db
              .select({
                source: sql<string>`'ticket'::text`,
                id: ticket.id,
                label: ticket.title,
                relationship: sql<string>`'member-ticket'::text`,
              })
              .from(ticket)
              .where(and(ticketScope, eq(ticket.epicId, id)))
              .orderBy(asc(ticket.createdAt))
              .limit(40)
          : await db
              .select({
                source: sql<string>`'knowledge'::text`,
                id: knowledgePage.id,
                label: knowledgePage.title,
                relationship: sql<string>`CASE WHEN ${knowledgePage.parentId}=${id} THEN 'child-page' ELSE 'parent-page' END`,
              })
              .from(knowledgePage)
              .where(
                and(
                  eq(knowledgePage.projectId, projectID),
                  eq(knowledgePage.state, "active"),
                  or(eq(knowledgePage.parentId, id), eq(knowledgePage.id, parentID)),
                ),
              )
              .limit(40);
    const body = row.body;
    return researchDocument.parse({
      ...row,
      source,
      excerpt: body.slice(0, 1200),
      body: body.slice(offset, offset + 16000),
      attachments: attachmentIDs(body),
      truncated: body.length > offset + 16000,
      nextOffset: body.length > offset + 16000 ? offset + 16000 : null,
      relationships: relations,
    });
  });
}
