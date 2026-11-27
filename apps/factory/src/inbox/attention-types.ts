import { type AnyColumn, desc, eq, sql } from "drizzle-orm";
import type { createDatabase, drizzleTransaction } from "#db/client";
import { operation, requirementRevision } from "#db/schema";
import type { AttentionCapability } from "#ticket-domain/attention";
import { plainFailureMessage } from "../command-error";
import type { InboxItem } from "./contracts";

export type InboxDatabase = ReturnType<typeof createDatabase>;
export type InboxTransactionDB = ReturnType<typeof drizzleTransaction>;

export type ProjectScope = {
  id: string;
  name: string;
  develop: boolean;
  manage: boolean;
};

export type InboxTicket = {
  id: string;
  projectId: string;
  title: string;
  responsibleId: string | null;
  following: boolean;
  state: string;
};

export type AttentionSource = {
  id: string;
  eventId: string;
  projectId: string;
  ticketId: string | null;
  title: string;
  preview: string;
  createdAt: Date | string;
  target: InboxItem["target"];
  targetId?: string | null;
  contextId?: string | null;
  capability: AttentionCapability;
  addressedTo?: string | null;
  authorID?: string | null;
};

export type InboxQueryContext = {
  db: InboxTransactionDB;
  userID: string;
  projectIDs: string[];
  followedIDs: string[];
  scopes: Map<string, ProjectScope>;
  tickets: Map<string, InboxTicket>;
};

const ZOD_FAILURE_REPLACEMENT =
  "Factory encountered an unexpected validation response from the runtime or cluster. Check the installation status before retrying.";

function sanitizeZodFailure(message: string): string {
  const trimmed = message.trim();
  const start = trimmed.indexOf("[{");
  if (start === -1 || !trimmed.endsWith("]")) return message;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start));
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (issue) =>
          issue &&
          typeof issue === "object" &&
          "code" in issue &&
          "path" in issue &&
          "message" in issue,
      )
    ) {
      const prefix = trimmed.slice(0, start).trim();
      return prefix ? `${prefix} ${ZOD_FAILURE_REPLACEMENT}` : ZOD_FAILURE_REPLACEMENT;
    }
  } catch {
    // Not a serialized ZodError array; preserve original message.
  }
  return message;
}

// Stored failure text can still carry provider codes or bookkeeping words from before it was reworded.
export const plainPreview = (source: AttentionSource): AttentionSource => ({
  ...source,
  preview: plainFailureMessage(sanitizeZodFailure(source.preview)),
});

export async function upsertOperation(
  db: InboxTransactionDB,
  input: Pick<
    typeof operation.$inferInsert,
    "kind" | "scopeType" | "scopeId" | "idempotencyKey" | "state" | "payload"
  >,
) {
  await db
    .insert(operation)
    .values({
      id: crypto.randomUUID(),
      kind: input.kind,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      idempotencyKey: input.idempotencyKey,
      activeKey: null,
      state: input.state,
      payload: input.payload,
    })
    .onConflictDoUpdate({
      target: operation.idempotencyKey,
      set: {
        state: input.state,
        payload: input.payload,
        updatedAt: sql`now()`,
      },
    });
}

export function latestRequirementRevisionId(db: InboxTransactionDB, ticketIdCol: AnyColumn) {
  return db
    .select({ id: requirementRevision.id })
    .from(requirementRevision)
    .where(eq(requirementRevision.ticketId, ticketIdCol))
    .orderBy(desc(requirementRevision.ordinal))
    .limit(1);
}
