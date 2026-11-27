import { and, desc, eq, sql as expression, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { createDatabase, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { type ProjectSetupView, projectSetupView } from "#project-domain/setup";
import {
  RECOVERABLE_INTENT_STATES,
  REPOSITORY_INTENT_KIND,
  type RepositoryIntentPayload,
  type RepositoryIntentResult,
  type RepositoryIntentSnapshot,
  type RepositoryIntentState,
  SETUP_DRAFT_KIND,
  type SetupDraftState,
  setupDraftActiveKey,
} from "./draft-state";

export type Database = ReturnType<typeof createDatabase>;
export type SetupDb = Database["db"] | ReturnType<typeof drizzleTransaction>;

export function parseDraftRow(row: typeof operation.$inferSelect): ProjectSetupView {
  const payload = row.payload;
  const result = row.result;
  return projectSetupView.parse({
    id: row.id,
    version: payload["version"],
    name: payload["name"],
    slug: payload["slug"],
    kind: payload["kind"],
    sourceURL: payload["sourceURL"],
    state: row.state,
    projectID: typeof result?.["projectID"] === "string" ? result["projectID"] : null,
    commandID: typeof payload["commandID"] === "string" ? payload["commandID"] : null,
    failure: row.error,
  });
}

export async function loadSetupDraft(
  db: SetupDb,
  userID: string,
  lock = false,
): Promise<ProjectSetupView | null> {
  const base = db
    .select()
    .from(operation)
    .where(
      and(
        eq(operation.kind, SETUP_DRAFT_KIND),
        eq(operation.scopeType, "user"),
        eq(operation.scopeId, userID),
        or(isNotNull(operation.activeKey), eq(operation.state, "created")),
      ),
    )
    .orderBy(
      desc(expression`(${operation.activeKey} IS NOT NULL)`),
      expression`${operation.completedAt} DESC NULLS LAST`,
      desc(operation.createdAt),
    )
    .limit(1);
  const [row] = lock ? await base.for("update") : await base;
  return row ? parseDraftRow(row) : null;
}

export async function loadRepositoryIntent(
  db: SetupDb,
  commandID: string,
): Promise<RepositoryIntentSnapshot | undefined> {
  const [row] = await db
    .select({
      commandID: operation.id,
      userID: operation.createdBy,
      projectID: operation.scopeId,
      state: operation.state,
      payload: operation.payload,
      result: operation.result,
      createdAt: operation.createdAt,
      completedAt: operation.completedAt,
    })
    .from(operation)
    .where(
      and(
        eq(operation.id, commandID),
        eq(operation.kind, REPOSITORY_INTENT_KIND),
        eq(operation.scopeType, "project"),
      ),
    );
  if (!row?.userID) return undefined;
  const payload = row.payload as RepositoryIntentPayload;
  const result = row.result as RepositoryIntentResult | null;
  return {
    commandID: row.commandID,
    setupID: payload.setupId,
    userID: row.userID,
    projectID: row.projectID,
    name: payload.name,
    slug: payload.slug,
    kind: payload.kind,
    sourceURL: payload.sourceUrl,
    credentialKey: payload.credentialKey ?? null,
    fingerprint: payload.fingerprint,
    state: row.state as RepositoryIntentState,
    defaultBranch: result?.defaultBranch ?? null,
    credentialRemovedAt: result?.credentialRemovedAt ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export async function updateRepositoryIntentState(
  db: SetupDb,
  commandID: string,
  patch: {
    state: RepositoryIntentState;
    error?: string | null;
    completed?: boolean;
    defaultBranch?: string;
  },
): Promise<void> {
  await db
    .update(operation)
    .set({
      state: patch.state,
      ...(patch.defaultBranch !== undefined
        ? {
            result: expression`COALESCE(${operation.result}, '{}'::jsonb) || jsonb_build_object('defaultBranch', ${patch.defaultBranch}::text)`,
          }
        : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: expression`now()`,
      ...(patch.completed !== undefined
        ? { completedAt: patch.completed ? expression`now()` : null }
        : {}),
    })
    .where(
      and(
        eq(operation.id, commandID),
        eq(operation.kind, REPOSITORY_INTENT_KIND),
        ne(operation.state, "committed"),
      ),
    );
}

export async function updateActiveDraftState(
  db: SetupDb,
  setupID: string,
  userID: string,
  patch: {
    state: SetupDraftState;
    error: string | null;
    excludeCreated?: boolean;
  },
): Promise<void> {
  await db
    .update(operation)
    .set({
      state: patch.state,
      error: patch.error,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.id, setupID),
        eq(operation.kind, SETUP_DRAFT_KIND),
        eq(operation.activeKey, setupDraftActiveKey(userID)),
        patch.excludeCreated ? ne(operation.state, "created") : undefined,
      ),
    );
}

export async function listRecoverableIntents(db: SetupDb): Promise<{ commandID: string }[]> {
  return db
    .select({ commandID: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.kind, REPOSITORY_INTENT_KIND),
        eq(operation.scopeType, "project"),
        inArray(operation.state, [...RECOVERABLE_INTENT_STATES]),
      ),
    );
}

export async function listPendingCredentialCleanupIntents(
  db: SetupDb,
): Promise<{ commandID: string }[]> {
  return db
    .select({ commandID: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.kind, REPOSITORY_INTENT_KIND),
        eq(operation.scopeType, "project"),
        eq(operation.state, "committed"),
        expression`(${operation.payload}->>'credentialKey') IS NOT NULL`,
        expression`(${operation.result}->>'credentialRemovedAt') IS NULL`,
      ),
    );
}
