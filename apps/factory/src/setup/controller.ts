import { and, eq, sql as expression, inArray, or } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { operation, project } from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import {
  type ProjectSetupView,
  projectImportURL,
  projectSetupCreate,
  projectSetupSave,
} from "#project-domain/setup";
import { createAccessController } from "../access/api";
import { CommandError } from "../command-error";
import {
  computeRepositoryFingerprint,
  initialDraftPayload,
  REPOSITORY_INTENT_KIND,
  repositoryIntentKey,
  SETUP_DRAFT_KIND,
  setupConflictError,
  setupDraftActiveKey,
  setupUnavailableError,
} from "./draft-state";
import {
  type Database,
  listPendingCredentialCleanupIntents,
  listRecoverableIntents,
  loadRepositoryIntent,
  loadSetupDraft,
} from "./draft-store";
import { createRepositoryRegistration } from "./repository-registration";
import type { ImportSecrets } from "./secrets";

export {
  assertRepositoryIntentMutable,
  type RepositoryIntentMutation,
  type RepositoryIntentSnapshot,
} from "./draft-state";

export function createProjectSetupController(options: {
  database: Database;
  forge: ReturnType<typeof createForgejoClient>;
  forgeOwner: string;
  forgeOrigin: string;
  secrets: ImportSecrets;
  signingKey: string;
  importOrigins: readonly string[];
  onCreated(projectID: string, userID: string): Promise<void>;
}) {
  const sql = options.database.client;
  const db = options.database.db;
  const access = createAccessController(options.database);
  const registration = createRepositoryRegistration(options);

  async function view(userID: string): Promise<ProjectSetupView | null> {
    await access.requireSystemManager(userID);
    return loadSetupDraft(db, userID);
  }

  async function begin(userID: string) {
    await access.requireSystemManager(userID);
    await db
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: SETUP_DRAFT_KIND,
        scopeType: "user",
        scopeId: userID,
        activeKey: setupDraftActiveKey(userID),
        state: "draft",
        payload: initialDraftPayload,
        createdBy: userID,
      })
      .onConflictDoNothing({ target: operation.activeKey });
    return view(userID);
  }

  async function save(userID: string, input: unknown) {
    await access.requireSystemManager(userID);
    const value = projectSetupSave.parse(input);
    const rows = await db
      .update(operation)
      .set({
        payload: expression`${operation.payload} || jsonb_build_object('name', ${value.name}::text, 'slug', ${value.slug}::text, 'kind', ${value.kind}::text, 'sourceURL', ${value.sourceURL}::text, 'version', (${operation.payload}->>'version')::bigint + 1)`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.id, value.id),
          eq(operation.kind, SETUP_DRAFT_KIND),
          eq(operation.scopeType, "user"),
          eq(operation.scopeId, userID),
          eq(operation.activeKey, setupDraftActiveKey(userID)),
          expression`(${operation.payload}->>'version')::bigint = ${value.version}`,
          eq(operation.state, "draft"),
        ),
      )
      .returning({ id: operation.id });
    if (!rows.length) throw setupConflictError();
    return view(userID);
  }

  async function startAnother(userID: string, setupID: string) {
    await access.requireSystemManager(userID);
    // Keep every external intent immutable. A new draft is a new operation,
    // never a retry with changed credentials or a replacement of retained Git.
    await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      const rows = await tx
        .update(operation)
        .set({
          activeKey: null,
          completedAt: expression`now()`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.kind, SETUP_DRAFT_KIND),
            eq(operation.scopeType, "user"),
            eq(operation.scopeId, userID),
            eq(operation.id, setupID),
            eq(operation.activeKey, setupDraftActiveKey(userID)),
            inArray(operation.state, ["checking", "failed"]),
          ),
        )
        .returning({ id: operation.id });
      if (!rows.length) throw setupConflictError();
      await tx.insert(operation).values({
        id: crypto.randomUUID(),
        kind: SETUP_DRAFT_KIND,
        scopeType: "user",
        scopeId: userID,
        activeKey: setupDraftActiveKey(userID),
        state: "draft",
        payload: initialDraftPayload,
        createdBy: userID,
      });
    });
    return view(userID);
  }

  async function create(userID: string, input: unknown) {
    await access.requireSystemManager(userID);
    const value = projectSetupCreate.parse(input);
    const admitted = await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      const draft = await loadSetupDraft(tx, userID, true);
      if (!draft || draft.id !== value.id) throw setupConflictError();
      if (draft.commandID) {
        if (draft.commandID !== value.commandID) throw setupConflictError();
        return false;
      }
      if (draft.version !== value.version || draft.state !== "draft" || !draft.name || !draft.slug)
        throw setupConflictError();
      let sourceURL = "";
      if (draft.kind === "import") {
        try {
          sourceURL = projectImportURL(draft.sourceURL, options.importOrigins);
        } catch (cause) {
          throw new CommandError(
            "invalid",
            cause instanceof Error && cause.message.startsWith("Use ")
              ? cause.message
              : "Enter a valid HTTPS Git URL.",
          );
        }
      }
      if (value.importToken && draft.kind !== "import") throw setupConflictError();
      if (value.importToken && !options.secrets.configured) throw setupUnavailableError();
      const projectID = crypto.randomUUID();
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`project-setup-identity:${projectID}`},0))`;
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`project-setup-slug:${draft.slug}`},0))`;
      const fingerprint = computeRepositoryFingerprint(options.signingKey, {
        setupID: value.id,
        name: draft.name,
        slug: draft.slug,
        kind: draft.kind,
        sourceURL,
        token: value.importToken ?? "",
      });
      const key = value.importToken ? `imports/${value.id}/${value.commandID}` : null;
      // Check before recording/dispatching Git creation. A retained Project or
      // another admitted setup is never converted or adopted as the fresh one.
      const [existing] = await tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectID))
        .unionAll(
          tx
            .select({ id: operation.id })
            .from(operation)
            .where(
              and(
                eq(operation.kind, REPOSITORY_INTENT_KIND),
                eq(operation.scopeType, "project"),
                or(
                  eq(operation.idempotencyKey, repositoryIntentKey(projectID)),
                  expression`${operation.payload}->>'setupId' = ${value.id}`,
                  expression`${operation.payload}->>'slug' = ${draft.slug}`,
                  ...(key ? [expression`${operation.payload}->>'credentialKey' = ${key}`] : []),
                ),
              ),
            ),
        );
      if (existing) throw setupConflictError();
      await tx.insert(operation).values({
        id: value.commandID,
        kind: REPOSITORY_INTENT_KIND,
        scopeType: "project",
        scopeId: projectID,
        idempotencyKey: repositoryIntentKey(projectID),
        state: key ? "credential-intended" : "create-intended",
        payload: {
          setupId: value.id,
          name: draft.name,
          slug: draft.slug,
          kind: draft.kind,
          sourceUrl: sourceURL,
          credentialKey: key,
          fingerprint,
        },
        createdBy: userID,
      });
      await tx
        .update(operation)
        .set({
          state: "creating",
          payload: expression`${operation.payload} || jsonb_build_object('commandID', ${value.commandID}::text)`,
          error: null,
          updatedAt: expression`now()`,
        })
        .where(eq(operation.id, value.id));
      return true;
    });
    const row = await loadRepositoryIntent(db, value.commandID);
    if (!row || row.userID !== userID) throw setupConflictError();
    await registration.ensureImportCredential(row, value.importToken);
    await registration.execute(row, admitted || row.state === "credential-intended");
    return view(userID);
  }

  async function check(userID: string, setupID: string) {
    const draft = await view(userID);
    if (!draft || draft.id !== setupID) throw setupConflictError();
    if (draft.commandID) {
      const row = await loadRepositoryIntent(db, draft.commandID);
      if (row) await registration.execute(row, false);
    }
    return view(userID);
  }

  async function retry(userID: string, setupID: string) {
    const draft = await view(userID);
    if (!draft || draft.id !== setupID || draft.state !== "failed" || !draft.commandID)
      throw setupConflictError();
    const row = await loadRepositoryIntent(db, draft.commandID);
    if (row?.state !== "failed") throw setupConflictError();
    await registration.execute(row, true);
    return view(userID);
  }

  async function recover() {
    // An explicit new draft must not strand an older unconfirmed operation.
    // Observation can settle it, but never authorizes another external create.
    for (const row of await listRecoverableIntents(db)) {
      const saved = await loadRepositoryIntent(db, row.commandID);
      if (saved) await registration.execute(saved, false);
    }
    for (const row of await listPendingCredentialCleanupIntents(db)) {
      const saved = await loadRepositoryIntent(db, row.commandID);
      if (saved) await registration.removeCredential(saved);
    }
  }

  return { view, begin, startAnother, save, create, check, retry, recover };
}
