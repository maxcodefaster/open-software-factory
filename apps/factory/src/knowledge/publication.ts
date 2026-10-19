import type { createDatabase } from "../../../../packages/db/src/client";
import type {
  WikiGenerationOutput,
  WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import { projectAuthorityIn } from "../access/controller";
import { mergeGeneratedDocument } from "../../../../packages/knowledge-domain/src/document-merge";
import { WikiHumanEditConflict } from "./generation-failure";

export class WikiPublicationConflict extends Error {}

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
    await transaction`SELECT id FROM factory.project WHERE id=${input.projectID} FOR UPDATE`;
    const [intent] =
      await transaction`SELECT id FROM factory.knowledge_generation WHERE id=${input.generationID} AND attempt_id=${input.attemptID} AND state='running' FOR UPDATE`;
    if (!intent) throw new WikiPublicationConflict("Wiki execution no longer owns publication");
    const locked = await transaction<
      Array<{
        id: string;
        version: number;
        revisionId: string | null;
        state: string;
        body: string;
        generatedBody: string;
      }>
    >`
      SELECT id,version::integer AS version,current_revision_id AS "revisionId",state,
        current_body AS body,generated_body AS "generatedBody"
      FROM factory.knowledge_page WHERE project_id=${input.projectID} ORDER BY id FOR UPDATE
    `;
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
      await transaction`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,citations,created_by,sort_order)
        VALUES(${identity(page.slug)},${input.projectID},${page.slug},${page.title},${page.body},${page.body},${input.commitSha},${JSON.stringify(page.sources.map((path) => ({ path, commitSha: input.commitSha })))}::jsonb,${input.userID},${input.pages.length + input.output.pages.indexOf(page)})`;
    }
    let count = 0;
    for (const generated of input.output.pages) {
      const page = input.pages.find((page) => page.id === generated.id);
      const previous = locked.find((page) => page.id === generated.id);
      const merged = previous
        ? mergeGeneratedDocument(previous.generatedBody, previous.body, generated.body)
        : { body: generated.body, generatedBody: generated.body, conflict: false };
      if (merged.conflict) throw new WikiHumanEditConflict();
      if (page && page.title === generated.title && page.body === merged.body) continue;
      const pageID = page?.id ?? identity(generated.slug),
        revisionID = crypto.randomUUID();
      const citations = JSON.stringify(
        generated.sources.map((path) => ({ path, commitSha: input.commitSha })),
      );
      const [next] = await transaction<
        Array<{ ordinal: number }>
      >`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM factory.knowledge_revision WHERE page_id=${pageID}`;
      await transaction`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,citations,generation_id,created_by)
        VALUES(${revisionID},${pageID},${Number(next?.ordinal ?? 1)},'generated',${generated.title},${merged.body},${merged.generatedBody},${input.commitSha},${citations}::jsonb,${input.generationID},${input.userID})`;
      await transaction`UPDATE factory.knowledge_page SET title=${generated.title},version=version+${page ? 1 : 0},current_revision_id=${revisionID},current_body=${merged.body},generated_body=${merged.generatedBody},source_commit_sha=${input.commitSha},citations=${citations}::jsonb,updated_at=now() WHERE id=${pageID}`;
      if (!page) {
        await transaction`UPDATE factory.knowledge_page SET parent_id=${generated.parentSlug ? identity(generated.parentSlug) : null} WHERE id=${pageID}`;
        await transaction`INSERT INTO factory.knowledge_page_alias(project_id,slug,page_id) VALUES(${input.projectID},${generated.slug},${pageID})`;
      }
      count++;
    }
    await transaction`UPDATE factory.knowledge_generation SET page_count=COALESCE(page_count,0)+${count},conflict_count=0,updated_at=now(),
      state=CASE WHEN ${input.complete} THEN 'succeeded'::factory.knowledge_generation_state ELSE state END,
      completed_at=CASE WHEN ${input.complete} THEN now() ELSE completed_at END
      WHERE id=${input.generationID} AND attempt_id=${input.attemptID} AND state='running'`;
    return Array.from(
      await transaction<WikiPageSnapshot[]>`
      SELECT id,slug,title,current_body AS body,version::integer AS version,
        current_revision_id AS "revisionId",parent_id AS "parentId",state,citations
      FROM factory.knowledge_page WHERE project_id=${input.projectID} ORDER BY sort_order,id
    `,
    );
  });
}
