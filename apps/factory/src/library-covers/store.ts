import {
  libraryCoverState,
  type LibraryCover,
  type LibraryCoverKey,
} from "../../../../packages/conversation-domain/src/library-covers";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";

type LibraryKind = "skill" | "mcp";
const tables = { skill: "factory.skill_library_cover", mcp: "factory.mcp_library_cover" };

export async function libraryCoversIn(
  sql: AgentTurnTransaction,
  kind: LibraryKind,
  libraryIds: string[],
) {
  const rows = await sql<Array<{ libraryId: string; key: string; version: number }>>`
    SELECT library_id AS "libraryId", cover_key AS key, version::float8 AS version
    FROM ${sql(tables[kind])} WHERE library_id = ANY(${libraryIds}::uuid[])`;
  return new Map(rows.map((row) => [row.libraryId, libraryCoverState.parse(row)]));
}

export async function initializeLibraryCoverIn(
  sql: AgentTurnTransaction,
  kind: LibraryKind,
  libraryId: string,
  key: LibraryCoverKey,
  userId: string,
) {
  await sql`INSERT INTO ${sql(tables[kind])}(library_id, cover_key, version, updated_by)
    VALUES (${libraryId}, ${key}, 1, ${userId}) ON CONFLICT (library_id) DO NOTHING`;
}

// Callers authorize the owning library and hold its existing write lock.
// Cover changes deliberately never touch content revisions, choices or connections.
export async function saveLibraryCoverIn(
  sql: AgentTurnTransaction,
  kind: LibraryKind,
  input: { libraryId: string; key: LibraryCoverKey; expectedVersion: number },
  userId: string,
) {
  const [current] = await sql<Array<LibraryCover & { updatedBy: string }>>`
    SELECT cover_key AS key, version::float8 AS version, updated_by AS "updatedBy"
    FROM ${sql(tables[kind])} WHERE library_id = ${input.libraryId} FOR UPDATE`;
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
  await sql`INSERT INTO ${sql(tables[kind])}(library_id, cover_key, version, updated_by)
    VALUES (${input.libraryId}, ${input.key}, ${input.expectedVersion + 1}, ${userId})
    ON CONFLICT (library_id) DO UPDATE SET cover_key = EXCLUDED.cover_key,
      version = EXCLUDED.version, updated_by = EXCLUDED.updated_by`;
  return { saved: true };
}
