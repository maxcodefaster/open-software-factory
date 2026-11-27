import { and, asc, desc, eq, sql as expression, ne } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { authUser, knowledgePage, knowledgeRevision, project as projectTable } from "#db/schema";
import type { knowledgeEditInput } from "#knowledge-domain/knowledge";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { createDocumentSearchCache } from "./document-search-cache";
import { editKnowledgeIn } from "./edit";
import {
  isMarkdownDocument,
  type KnowledgeDatabase,
  type KnowledgeRepository,
  repositoryTitle,
} from "./repository-source";
import { searchSnippet } from "./search-snippet";

export type KnowledgeEdit = typeof knowledgeEditInput._output;

export function createKnowledgePages(database: KnowledgeDatabase, repository: KnowledgeRepository) {
  const documentSearchCache = createDocumentSearchCache();

  async function edit(pageID: string, input: KnowledgeEdit, userID: string, restoring = false) {
    return database.client.begin((sql) => editKnowledgeIn(sql, pageID, input, userID, restoring));
  }

  async function searchDocuments(projectID: string, terms: string[]) {
    const current = await repository.inventory(projectID);
    const files = current.files.filter(isMarkdownDocument);
    if (
      files.length > 2_000 ||
      files.reduce((total, file) => total + file.size, 0) > 16 * 1024 * 1024
    )
      throw new CommandError(
        "unavailable",
        "Repository documents exceed the full-text search size limit.",
      );
    const corpus = await documentSearchCache.get(
      `${current.project.repositoryURL}:${current.commitSha}`,
      async () => {
        const read: Array<{ path: string; sha: string; title: string; body: string }> = [];
        // Coalesce full-text indexing, bound concurrent reads and reuse unchanged blobs across commits.
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, files.length) }, async () => {
            while (cursor < files.length) {
              const file = files[cursor++];
              if (!file) break;
              const { body } = await repository.documentContent(current, file.path);
              const title = repositoryTitle(file.path);
              read.push({ path: file.path, sha: file.sha, title, body });
            }
          }),
        );
        return read.sort((left, right) => left.path.localeCompare(right.path));
      },
    );
    const documents: Array<{
      id: string;
      kind: "document";
      title: string;
      path: string;
      snippet: string;
      rank: number;
    }> = [];
    for (const { path, title, body } of corpus) {
      const heading = `${path} ${title}`.toLocaleLowerCase();
      const full = `${heading} ${body.toLocaleLowerCase()}`;
      if (!terms.every((term) => full.includes(term))) continue;
      documents.push({
        id: `document:${path}`,
        kind: "document",
        title,
        path,
        snippet: searchSnippet(body, terms),
        rank: terms.every((term) => heading.includes(term)) ? 2 : 0.5,
      });
    }
    return documents;
  }

  return {
    edit,
    async archive(pageID: string, expectedVersion: number, userID: string) {
      return database.client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        const [scope] = await db
          .select({ projectId: knowledgePage.projectId })
          .from(knowledgePage)
          .where(and(eq(knowledgePage.id, pageID), eq(knowledgePage.state, "active")));
        if (!scope) throw new CommandError("not-found", "Wiki page not found");
        await projectAuthorityIn(transaction, userID, scope.projectId);
        await db
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(eq(projectTable.id, scope.projectId))
          .for("update");
        const activeAtVersion = and(
          eq(knowledgePage.id, pageID),
          eq(knowledgePage.version, expectedVersion),
          eq(knowledgePage.state, "active"),
        );
        const [page] = await db
          .select({ parentId: knowledgePage.parentId })
          .from(knowledgePage)
          .where(activeAtVersion)
          .for("update");
        if (!page)
          throw new CommandError("conflict", "Wiki page changed. Refresh before archiving.");
        await db
          .update(knowledgePage)
          .set({
            parentId: page.parentId,
            metadataVersion: expression`${knowledgePage.metadataVersion}+1`,
          })
          .where(and(eq(knowledgePage.parentId, pageID), eq(knowledgePage.state, "active")));
        const rows = await db
          .update(knowledgePage)
          .set({
            state: "archived",
            version: expression`${knowledgePage.version}+1`,
            updatedAt: expression`now()`,
          })
          .where(activeAtVersion)
          .returning({ id: knowledgePage.id });
        if (!rows[0])
          throw new CommandError("conflict", "Wiki page changed. Refresh before archiving.");
        return rows[0];
      });
    },
    async restore(pageID: string, revisionID: string, expectedVersion: number, userID: string) {
      const [revision] = await database.db
        .select({ title: knowledgeRevision.title, body: knowledgeRevision.body })
        .from(knowledgeRevision)
        .where(
          and(
            eq(knowledgeRevision.id, revisionID),
            eq(knowledgeRevision.pageId, pageID),
            ne(knowledgeRevision.kind, "proposed"),
          ),
        );
      if (!revision) throw new CommandError("not-found", "Revision not found");
      return edit(
        pageID,
        { expectedVersion, title: revision.title, body: revision.body },
        userID,
        true,
      );
    },
    async sources(pageID: string, userID: string) {
      const [page] = await database.db
        .select({ projectId: knowledgePage.projectId, citations: knowledgePage.citations })
        .from(knowledgePage)
        .where(eq(knowledgePage.id, pageID));
      if (!page) throw new CommandError("not-found", "Wiki page not found");
      await createAccessController(database).requireDevelopment(userID, page.projectId);
      return { citations: page.citations };
    },
    async history(pageID: string, userID: string) {
      const [page] = await database.db
        .select({ projectId: knowledgePage.projectId })
        .from(knowledgePage)
        .where(eq(knowledgePage.id, pageID));
      if (!page) throw new CommandError("not-found", "Wiki page not found");
      const develop = await createAccessController(database).canDevelop(userID, page.projectId);
      return database.db
        .select({
          id: knowledgeRevision.id,
          ordinal: knowledgeRevision.ordinal,
          kind: knowledgeRevision.kind,
          title: knowledgeRevision.title,
          body: knowledgeRevision.body,
          ...(develop ? { sourceCommitSha: knowledgeRevision.sourceCommitSha } : {}),
          createdAt: expression<string>`${knowledgeRevision.createdAt}::text`,
          author: authUser.name,
        })
        .from(knowledgeRevision)
        .leftJoin(authUser, eq(authUser.id, knowledgeRevision.createdBy))
        .where(eq(knowledgeRevision.pageId, pageID))
        .orderBy(desc(knowledgeRevision.ordinal));
    },
    async search(projectID: string, query: string, userID: string) {
      const develop = await createAccessController(database).canDevelop(userID, projectID);
      const text = query.trim();
      if (!text) return [];
      const vector = expression`to_tsvector('simple',${knowledgePage.title}||' '||${knowledgePage.currentBody})`;
      const rank = expression<number>`ts_rank(${vector},plainto_tsquery('simple',${text}))`.as(
        "rank",
      );
      const pages = await database.db
        .select({
          id: knowledgePage.id,
          slug: knowledgePage.slug,
          title: knowledgePage.title,
          currentBody: knowledgePage.currentBody,
          rank,
        })
        .from(knowledgePage)
        .where(
          and(
            eq(knowledgePage.projectId, projectID),
            eq(knowledgePage.state, "active"),
            expression`${vector} @@ plainto_tsquery('simple',${text})`,
          ),
        )
        .orderBy(desc(rank), asc(knowledgePage.title), asc(knowledgePage.id))
        .limit(30);
      const terms = text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const results = pages.map((page) => ({
        id: page.id,
        kind: "page" as const,
        title: page.title,
        path: page.slug,
        snippet: searchSnippet(page.currentBody, terms),
        rank: Number(page.rank),
      }));
      if (!develop) return results;
      const documents = await searchDocuments(projectID, terms);
      // Wiki pages come first. Their ts_rank scale is far below the document scores,
      // so a shared rank sort would push every Wiki match behind the repository files.
      return [...results, ...documents]
        .sort(
          (left, right) =>
            Number(right.kind === "page") - Number(left.kind === "page") ||
            right.rank - left.rank ||
            left.title.localeCompare(right.title) ||
            left.id.localeCompare(right.id),
        )
        .slice(0, 50);
    },
  };
}
