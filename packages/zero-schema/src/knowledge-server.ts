import type { DrizzleTransaction } from "@rocicorp/zero/server/adapters/drizzle";
import { eq, sql } from "drizzle-orm";
import type { createDatabase } from "../../db/src/client";
import { knowledgePage } from "../../db/src/schema";
import {
  type knowledgePageIconInput,
  type moveKnowledgePageInput,
  movePageOrder,
} from "../../knowledge-domain/src/page-tree";

type Transaction = DrizzleTransaction<ReturnType<typeof createDatabase>["db"]>;
async function authority(db: Transaction, userId: string, projectId: string) {
  const rows = await db.execute<{ allowed: boolean }>(sql`
    WITH account AS (SELECT user_id FROM factory.account_access WHERE user_id=${userId}::uuid
      AND disabled_at IS NULL AND directory_disabled_at IS NULL FOR SHARE),
      membership AS (SELECT user_id FROM factory.project_membership WHERE project_id=${projectId}::uuid AND user_id=${userId}::uuid FOR SHARE)
    SELECT (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userId}::uuid)
      OR EXISTS(SELECT 1 FROM membership)) AND EXISTS(SELECT 1 FROM account) AS allowed`);
  if (!rows[0]?.allowed) throw new Error("Project not found");
}
export async function moveKnowledgePage(
  db: Transaction,
  userId: string,
  args: typeof moveKnowledgePageInput._output,
) {
  await authority(db, userId, args.projectId);
  await db.execute(sql`SELECT id FROM factory.project WHERE id=${args.projectId}::uuid FOR UPDATE`);
  const pages = await db.query.knowledgePage.findMany({
    where: (row, { and, eq }) => and(eq(row.projectId, args.projectId), eq(row.state, "active")),
  });
  const current = pages.find((page) => page.id === args.pageId);
  if (!current || current.metadataVersion !== args.expectedMetadataVersion)
    throw new Error("Wiki page order changed. Try again.");
  const order = movePageOrder(pages, args.pageId, args.parentId, args.beforeId);
  for (const [sortOrder, id] of order.entries()) {
    const page = pages.find((page) => page.id === id);
    if (page && (page.sortOrder !== sortOrder || page.parentId !== args.parentId))
      await db
        .update(knowledgePage)
        .set({ parentId: args.parentId, sortOrder, metadataVersion: page.metadataVersion + 1 })
        .where(eq(knowledgePage.id, id));
  }
}
export async function setKnowledgePageIcon(
  db: Transaction,
  userId: string,
  args: typeof knowledgePageIconInput._output,
) {
  await authority(db, userId, args.projectId);
  const rows = await db.execute<{ id: string; icon: string; metadataVersion: number }>(
    sql`SELECT id,icon,metadata_version::float8 AS "metadataVersion" FROM factory.knowledge_page WHERE id=${args.pageId}::uuid AND project_id=${args.projectId}::uuid AND state='active' FOR UPDATE`,
  );
  const page = rows[0];
  if (!page || page.metadataVersion !== args.expectedMetadataVersion)
    throw new Error("Wiki page changed. Try again.");
  if (page.icon !== args.icon)
    await db
      .update(knowledgePage)
      .set({ icon: args.icon, metadataVersion: page.metadataVersion + 1 })
      .where(eq(knowledgePage.id, page.id));
}
