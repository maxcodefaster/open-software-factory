import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type LibraryCoverKey, libraryCoverState } from "#conversation-domain/library-covers";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { mcpLibrary, skillLibrary } from "#db/schema";
import { CommandError } from "../command-error";

type LibraryKind = "skill" | "mcp";
const tables = { skill: skillLibrary, mcp: mcpLibrary };

export async function libraryCoversIn(
  sql: DatabaseTransaction,
  kind: LibraryKind,
  libraryIds: string[],
) {
  if (!libraryIds.length) return new Map();
  const table = tables[kind];
  const rows = await drizzleTransaction(sql)
    .select({ libraryId: table.id, key: table.coverKey, version: table.coverVersion })
    .from(table)
    .where(and(inArray(table.id, libraryIds), isNotNull(table.coverKey)));
  return new Map(rows.map((row) => [row.libraryId, libraryCoverState.parse(row)]));
}

export async function initializeLibraryCoverIn(
  sql: DatabaseTransaction,
  kind: LibraryKind,
  libraryId: string,
  key: LibraryCoverKey,
  userId: string,
) {
  const table = tables[kind];
  await drizzleTransaction(sql)
    .update(table)
    .set({ coverKey: key, coverVersion: 1, coverUpdatedBy: userId })
    .where(and(eq(table.id, libraryId), isNull(table.coverKey)));
}

// Callers authorize the owning library and hold its existing write lock.
// Cover changes deliberately never touch content revisions, choices or connections.
export async function saveLibraryCoverIn(
  sql: DatabaseTransaction,
  kind: LibraryKind,
  input: { libraryId: string; key: LibraryCoverKey; expectedVersion: number },
  userId: string,
) {
  const table = tables[kind];
  const db = drizzleTransaction(sql);
  const [current] = await db
    .select({ key: table.coverKey, version: table.coverVersion, updatedBy: table.coverUpdatedBy })
    .from(table)
    .where(eq(table.id, input.libraryId))
    .for("update");
  if ((current?.version ?? 0) !== input.expectedVersion) {
    if (
      current?.version === input.expectedVersion + 1 &&
      current.key === input.key &&
      current.updatedBy === userId
    )
      return { saved: true };
    throw new CommandError("conflict", "This cover changed elsewhere. Reload before saving.");
  }
  if (current?.key === input.key) return { saved: true };
  await db
    .update(table)
    .set({
      coverKey: input.key,
      coverVersion: input.expectedVersion + 1,
      coverUpdatedBy: userId,
    })
    .where(eq(table.id, input.libraryId));
  return { saved: true };
}
