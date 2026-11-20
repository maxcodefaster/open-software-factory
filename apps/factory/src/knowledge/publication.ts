import { and, asc, eq, sql as expression } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  knowledgeGeneration,
  knowledgePage,
  knowledgePageAlias,
  knowledgeRevision,
  project,
} from "../../../../packages/db/src/schema";
import { mergeGeneratedDocument } from "../../../../packages/knowledge-domain/src/document-merge";
import type {
  WikiGenerationOutput,
  WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import { projectAuthorityIn } from "../access/controller";
import { WikiHumanEditConflict } from "./generation-failure";

export class WikiPublicationConflict extends Error {}

export type WikiPublicationSnapshot = WikiPageSnapshot & { generatedBody: string };

export async function wikiPublicationSnapshotsIn(
  db: Pick<ReturnType<typeof createDatabase>["db"], "select">,
  projectID: string,
): Promise<WikiPublicationSnapshot[]> {
  return db
    .select({
      id: knowledgePage.id,
      slug: knowledgePage.slug,
      title: knowledgePage.title,
      body: knowledgePage.currentBody,
      generatedBody: knowledgePage.generatedBody,
      version: knowledgePage.version,
      revisionId: knowledgePage.currentRevisionId,
      parentId: knowledgePage.parentId,
      state: knowledgePage.state,
      citations: knowledgePage.citations,
    })
    .from(knowledgePage)
    .where(eq(knowledgePage.projectId, projectID))
    .orderBy(asc(knowledgePage.sortOrder), asc(knowledgePage.id));
}

function mergePublicationPage(
  previous: Pick<WikiPublicationSnapshot, "body" | "generatedBody"> | undefined,
  body: string,
) {
  const merged = previous
    ? mergeGeneratedDocument(previous.generatedBody, previous.body, body)
    : { body, generatedBody: body, conflict: false };
  if (merged.conflict) throw new WikiHumanEditConflict();
  return merged;
}

export function prepareWikiPublication(
  pages: readonly WikiPublicationSnapshot[],
  output: WikiGenerationOutput,
): WikiGenerationOutput {
  return {
    pages: output.pages.map((page) => ({
      ...page,
      body: mergePublicationPage(
        pages.find((current) => current.id === page.id),
        page.body,
      ).body,
    })),
  };
}

export async function publishWikiPackage(
  database: ReturnType<typeof createDatabase>,
  input: {
    generationID: string;
    attemptID: string;
    projectID: string;
    userID: string;
    commitSha: string;
    pages: WikiPageSnapshot[];
    output: WikiGenerationOutput;
    complete: boolean;
  },
) {
  return database.client.begin(async (transaction) => {
    await projectAuthorityIn(transaction, input.userID, input.projectID);
    const db = drizzleTransaction(transaction);
    await db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, input.projectID))
      .for("update");
    const [intent] = await db
      .select({ id: knowledgeGeneration.id })
      .from(knowledgeGeneration)
      .where(
        and(
          eq(knowledgeGeneration.id, input.generationID),
          eq(knowledgeGeneration.attemptId, input.attemptID),
          eq(knowledgeGeneration.state, "running"),
        ),
      )
      .for("update");
    if (!intent) throw new WikiPublicationConflict("Wiki execution no longer owns publication");
    const locked = await db
      .select({
        id: knowledgePage.id,
        version: knowledgePage.version,
        revisionId: knowledgePage.currentRevisionId,
        state: knowledgePage.state,
        body: knowledgePage.currentBody,
        generatedBody: knowledgePage.generatedBody,
      })
      .from(knowledgePage)
      .where(eq(knowledgePage.projectId, input.projectID))
      .orderBy(asc(knowledgePage.id))
      .for("update");
    if (
      locked.length !== input.pages.length ||
      locked.some(
        (page) =>
          !input.pages.some(
            (before) =>
              before.id === page.id &&
              before.version === page.version &&
              before.revisionId === page.revisionId &&
              before.state === page.state,
          ),
      )
    )
      return false;
    const pageIds = new Map(input.pages.map((page) => [page.slug, page.id]));
    for (const page of input.output.pages)
      if (!page.id) pageIds.set(page.slug, crypto.randomUUID());
    const identity = (slug: string) => {
      const id = pageIds.get(slug);
      if (!id) throw new Error("Wiki page identity is missing");
      return id;
    };
    for (const page of input.output.pages.filter((page) => !page.id)) {
      await db.insert(knowledgePage).values({
        id: identity(page.slug),
        projectId: input.projectID,
        slug: page.slug,
        title: page.title,
        currentBody: page.body,
        generatedBody: page.body,
        sourceCommitSha: input.commitSha,
        citations: page.sources.map((path) => ({ path, commitSha: input.commitSha })),
        createdBy: input.userID,
        sortOrder: input.pages.length + input.output.pages.indexOf(page),
      });
    }
    let count = 0;
    for (const generated of input.output.pages) {
      const page = input.pages.find((page) => page.id === generated.id);
      const previous = locked.find((page) => page.id === generated.id);
      const merged = mergePublicationPage(previous, generated.body);
      if (page && page.title === generated.title && page.body === merged.body) continue;
      const pageID = page?.id ?? identity(generated.slug),
        revisionID = crypto.randomUUID();
      const citations = generated.sources.map((path) => ({ path, commitSha: input.commitSha }));
      await db.insert(knowledgeRevision).select(
        db
          .select({
            id: expression<string>`${revisionID}::uuid`.as("id"),
            pageId: expression<string>`${pageID}::uuid`.as("page_id"),
            ordinal: expression<number>`coalesce(max(${knowledgeRevision.ordinal}),0)+1`.as(
              "ordinal",
            ),
            kind: expression<"generated">`'generated'::factory.knowledge_revision_kind`.as("kind"),
            title: expression<string>`${generated.title}`.as("title"),
            body: expression<string>`${merged.body}`.as("body"),
            generatedBody: expression<string>`${merged.generatedBody}`.as("generated_body"),
            sourceCommitSha: expression<string>`${input.commitSha}`.as("source_commit_sha"),
            citations: expression<unknown>`${JSON.stringify(citations)}::jsonb`.as("citations"),
            generationId: expression<string>`${input.generationID}::uuid`.as("generation_id"),
            createdBy: expression<string>`${input.userID}::uuid`.as("created_by"),
            createdAt: expression<Date>`now()`.as("created_at"),
          })
          .from(knowledgeRevision)
          .where(eq(knowledgeRevision.pageId, pageID)),
      );
      await db
        .update(knowledgePage)
        .set({
          title: generated.title,
          version: expression`${knowledgePage.version}+${page ? 1 : 0}`,
          currentRevisionId: revisionID,
          currentBody: merged.body,
          generatedBody: merged.generatedBody,
          sourceCommitSha: input.commitSha,
          citations,
          updatedAt: expression`now()`,
        })
        .where(eq(knowledgePage.id, pageID));
      if (!page) {
        await db
          .update(knowledgePage)
          .set({ parentId: generated.parentSlug ? identity(generated.parentSlug) : null })
          .where(eq(knowledgePage.id, pageID));
        await db.insert(knowledgePageAlias).values({
          projectId: input.projectID,
          slug: generated.slug,
          pageId: pageID,
        });
      }
      count++;
    }
    await db
      .update(knowledgeGeneration)
      .set({
        pageCount: expression`coalesce(${knowledgeGeneration.pageCount},0)+${count}`,
        conflictCount: 0,
        updatedAt: expression`now()`,
        progress: input.complete
          ? expression`CASE WHEN ${knowledgeGeneration.progress} IS NOT NULL
              THEN ${knowledgeGeneration.progress}||jsonb_build_object(
                'phase','done','topicsDone',${knowledgeGeneration.progress}->'topicsTotal','currentTopic',NULL)
              ELSE ${knowledgeGeneration.progress} END`
          : knowledgeGeneration.progress,
        state: input.complete ? "succeeded" : knowledgeGeneration.state,
        completedAt: input.complete ? expression`now()` : knowledgeGeneration.completedAt,
      })
      .where(
        and(
          eq(knowledgeGeneration.id, input.generationID),
          eq(knowledgeGeneration.attemptId, input.attemptID),
          eq(knowledgeGeneration.state, "running"),
        ),
      );
    return wikiPublicationSnapshotsIn(db, input.projectID);
  });
}
