import { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

// One versioned write boundary for the editor, restoration and an explicitly
// accepted learning edit. The surrounding command owns its atomic receipt.
export async function editKnowledgeIn(
  sql: AgentTurnTransaction,
  pageID: string,
  input: typeof knowledgeEditInput._output,
  userID: string,
  restoring = false,
  revisionID: string = crypto.randomUUID(),
) {
  knowledgeEditInput.parse(input);
  // Public commands already normalize authored input. A targeted learning edit
  // supplies the saved title verbatim and must not normalize unrelated text.
  const value = input;
  const [scope] = await sql<{ projectId: string }[]>`
    SELECT project_id AS "projectId" FROM factory.knowledge_page WHERE id=${pageID} AND state='active'`;
  if (!scope) throw new CommandError("not-found", "Wiki page not found");
  await projectAuthorityIn(sql, userID, scope.projectId);
  const [page] = await sql<
    {
      title: string;
      body: string;
      revisionId: string | null;
      version: number;
      generatedBody: string;
      commitSha: string;
      citations: Array<{ path: string; commitSha: string }>;
    }[]
  >`
    SELECT title,current_body AS body,current_revision_id AS "revisionId",version::int AS version,
      generated_body AS "generatedBody",source_commit_sha AS "commitSha",citations
    FROM factory.knowledge_page WHERE id=${pageID} AND state='active' FOR UPDATE`;
  if (!page) throw new CommandError("not-found", "Wiki page not found");
  if (!restoring && page.title === value.title && page.body === value.body)
    return {
      id: pageID,
      version: page.version,
      title: page.title,
      body: page.body,
      revisionId: page.revisionId,
    };
  if (page.version !== value.expectedVersion)
    throw new CommandError("conflict", "Knowledge Page changed. Reload it before saving.");
  const [next] = await sql<{ ordinal: number }[]>`
    SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM factory.knowledge_revision WHERE page_id=${pageID}`;
  await sql`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,citations,created_by)
    VALUES(${revisionID},${pageID},${Number(next?.ordinal ?? 1)},'human',${value.title},${value.body},
      ${page.generatedBody},${page.commitSha},${JSON.stringify(page.citations)}::jsonb,${userID})`;
  await sql`UPDATE factory.knowledge_page SET title=${value.title},current_body=${value.body},
    current_revision_id=${revisionID},version=version+1,updated_at=now() WHERE id=${pageID} AND version=${value.expectedVersion}`;
  return {
    id: pageID,
    version: page.version + 1,
    title: value.title,
    body: value.body,
    revisionId: revisionID,
  };
}
