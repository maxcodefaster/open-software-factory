import { eq, inArray } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import { mcpLibraryCover, skillLibraryCover } from "../../../../packages/db/src/schema";
import {
  type LibraryCoverKey,
  libraryCoverState,
} from "../../../../packages/conversation-domain/src/library-covers";
import { CommandError } from "../command-error";

type LibraryKind = "skill" | "mcp";
const tables = { skill: skillLibraryCover, mcp: mcpLibraryCover };

export async function libraryCoversIn(
  sql: DatabaseTransaction,
  kind: LibraryKind,
  libraryIds: string[],
) {
  const table = tables[kind];
  const rows = await drizzleTransaction(sql)
    .select({ libraryId: table.libraryId, key: table.coverKey, version: table.version })
    .from(table)
    .where(inArray(table.libraryId, libraryIds));
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
    .insert(table)
    .values({ libraryId, coverKey: key, version: 1, updatedBy: userId })
    .onConflictDoNothing({ target: table.libraryId });
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
    .select({ key: table.coverKey, version: table.version, updatedBy: table.updatedBy })
    .from(table)
    .where(eq(table.libraryId, input.libraryId))
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
  const values = {
    libraryId: input.libraryId,
    coverKey: input.key,
    version: input.expectedVersion + 1,
    updatedBy: userId,
  };
  await db
    .insert(table)
    .values(values)
    .onConflictDoUpdate({
      target: table.libraryId,
      set: { coverKey: values.coverKey, version: values.version, updatedBy: values.updatedBy },
    });
  return { saved: true };
}
