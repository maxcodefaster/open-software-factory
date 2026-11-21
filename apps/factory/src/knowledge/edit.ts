import { and, desc, eq, sql as expression } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import { knowledgePage, knowledgeRevision } from "../../../../packages/db/src/schema";
import { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

// One versioned write boundary for the editor, restoration and an explicitly
// accepted learning edit. The surrounding command owns its atomic receipt.
export async function editKnowledgeIn(
  sql: DatabaseTransaction,
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
  const db = drizzleTransaction(sql);
  const [scope] = await db
    .select({ projectId: knowledgePage.projectId })
    .from(knowledgePage)
    .where(and(eq(knowledgePage.id, pageID), eq(knowledgePage.state, "active")));
  if (!scope) throw new CommandError("not-found", "Wiki page not found");
  await projectAuthorityIn(sql, userID, scope.projectId);
  const [page] = await db
    .select({
      title: knowledgePage.title,
      body: knowledgePage.currentBody,
      revisionId: knowledgePage.currentRevisionId,
      version: knowledgePage.version,
      generatedBody: knowledgePage.generatedBody,
      commitSha: knowledgePage.sourceCommitSha,
      citations: knowledgePage.citations,
    })
    .from(knowledgePage)
    .where(and(eq(knowledgePage.id, pageID), eq(knowledgePage.state, "active")))
    .for("update");
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
    throw new CommandError("conflict", "Wiki Page changed. Reload it before saving.");
  const [previous] = await db
    .select({ ordinal: knowledgeRevision.ordinal })
    .from(knowledgeRevision)
    .where(eq(knowledgeRevision.pageId, pageID))
    .orderBy(desc(knowledgeRevision.ordinal))
    .limit(1);
  await db.insert(knowledgeRevision).values({
    id: revisionID,
    pageId: pageID,
    ordinal: (previous?.ordinal ?? 0) + 1,
    kind: "human",
    title: value.title,
    body: value.body,
    generatedBody: page.generatedBody,
    sourceCommitSha: page.commitSha,
    citations: page.citations,
    createdBy: userID,
  });
  await db
    .update(knowledgePage)
    .set({
      title: value.title,
      currentBody: value.body,
      currentRevisionId: revisionID,
      version: expression`${knowledgePage.version}+1`,
      updatedAt: expression`now()`,
    })
    .where(and(eq(knowledgePage.id, pageID), eq(knowledgePage.version, value.expectedVersion)));
  return {
    id: pageID,
    version: page.version + 1,
    title: value.title,
    body: value.body,
    revisionId: revisionID,
  };
}
