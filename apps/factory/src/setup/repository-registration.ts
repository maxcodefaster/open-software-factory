import { and, eq, sql as expression } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { administrator, operation, projectMembership } from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import { ForgeAmbiguousWriteError } from "#forge/forge";
import { createAccessController } from "../access/api";
import { CommandError } from "../command-error";
import { createProjectIn } from "../projects/creation";
import {
  assertRepositoryIntentMutable,
  computeRepositoryFingerprint,
  REPOSITORY_INTENT_KIND,
  type RepositoryIntentResult,
  type RepositoryIntentSnapshot,
  type RepositoryIntentState,
  SETUP_DRAFT_KIND,
  setupConflictError,
  setupDraftActiveKey,
  setupUnavailableError,
} from "./draft-state";
import {
  type Database,
  loadRepositoryIntent,
  updateActiveDraftState,
  updateRepositoryIntentState,
} from "./draft-store";
import type { ImportSecrets } from "./secrets";
import { withSetupCoordinationLock } from "./setup-lock";
import { starterFiles } from "./starter";

export function createRepositoryRegistration(options: {
  database: Database;
  forge: ReturnType<typeof createForgejoClient>;
  forgeOwner: string;
  forgeOrigin: string;
  secrets: ImportSecrets;
  signingKey: string;
  onCreated(projectID: string, userID: string): Promise<void>;
}) {
  const sql = options.database.client;
  const db = options.database.db;
  const access = createAccessController(options.database);

  async function removeCredential(row: RepositoryIntentSnapshot) {
    if (!row.credentialKey) return;
    const [active] = await db
      .select({ id: operation.id })
      .from(operation)
      .where(
        and(
          eq(operation.id, row.commandID),
          eq(operation.kind, REPOSITORY_INTENT_KIND),
          expression`(${operation.result}->>'credentialRemovedAt') IS NULL`,
        ),
      );
    if (!active) return;
    await options.secrets.remove(row.credentialKey);
    await db
      .update(operation)
      .set({
        result: expression`COALESCE(${operation.result}, '{}'::jsonb) || jsonb_build_object('credentialRemovedAt', to_jsonb(now()))`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.id, row.commandID),
          eq(operation.kind, REPOSITORY_INTENT_KIND),
          expression`(${operation.result}->>'credentialRemovedAt') IS NULL`,
        ),
      );
  }

  async function ensureImportCredential(
    row: RepositoryIntentSnapshot,
    importToken: string | undefined,
  ) {
    const fingerprint = computeRepositoryFingerprint(options.signingKey, {
      setupID: row.setupID,
      name: row.name,
      slug: row.slug,
      kind: row.kind,
      sourceURL: row.sourceURL,
      token: importToken ?? "",
    });
    if (importToken && fingerprint !== row.fingerprint) throw setupConflictError();
    if (row.state !== "credential-intended") return;
    const existing = row.credentialKey ? await options.secrets.read(row.credentialKey) : undefined;
    if (!existing) {
      if (fingerprint !== row.fingerprint || !importToken || !row.credentialKey)
        throw setupConflictError();
      await options.secrets.create(row.credentialKey, {
        commandID: row.commandID,
        fingerprint: row.fingerprint,
        token: importToken,
      });
    } else if (existing.commandID !== row.commandID || existing.fingerprint !== row.fingerprint) {
      throw setupConflictError();
    }
  }

  async function finish(row: RepositoryIntentSnapshot, branch: string) {
    await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
      const [manager] = await tx
        .select({ userID: administrator.userId })
        .from(administrator)
        .where(eq(administrator.userId, row.userID))
        .for("share");
      if (!manager) throw new CommandError("forbidden", "System Manager access required");
      const [locked] = await tx
        .select({
          state: operation.state,
          result: operation.result,
          createdAt: operation.createdAt,
          completedAt: operation.completedAt,
        })
        .from(operation)
        .where(and(eq(operation.id, row.commandID), eq(operation.kind, REPOSITORY_INTENT_KIND)))
        .for("update");
      if (locked?.state === "committed") return;
      if (locked) {
        const result = locked.result as RepositoryIntentResult | null;
        assertRepositoryIntentMutable(
          {
            ...row,
            state: locked.state as RepositoryIntentState,
            defaultBranch: result?.defaultBranch ?? null,
            credentialRemovedAt: result?.credentialRemovedAt ?? null,
            createdAt: locked.createdAt,
            completedAt: locked.completedAt,
          },
          { state: "committed", defaultBranch: branch },
        );
      }
      const url = new URL(
        `${encodeURIComponent(options.forgeOwner)}/${encodeURIComponent(row.slug)}`,
        `${options.forgeOrigin}/`,
      ).toString();
      await createProjectIn(transaction, {
        id: row.projectID,
        slug: row.slug,
        name: row.name,
        repositoryUrl: url,
        defaultBranch: branch,
        actorTemplatePath: ".factory/actor-template.json",
        createdBy: row.userID,
      });
      await tx.insert(projectMembership).values({
        projectId: row.projectID,
        userId: row.userID,
        role: "developer",
        manageProject: true,
        updatedBy: row.userID,
      });
      await updateRepositoryIntentState(tx, row.commandID, {
        state: "committed",
        defaultBranch: branch,
        error: null,
        completed: true,
      });
      await tx
        .update(operation)
        .set({
          state: "created",
          activeKey: null,
          result: { projectID: row.projectID },
          error: null,
          updatedAt: expression`now()`,
          completedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.id, row.setupID),
            eq(operation.kind, SETUP_DRAFT_KIND),
            eq(operation.scopeType, "user"),
            eq(operation.scopeId, row.userID),
            eq(operation.activeKey, setupDraftActiveKey(row.userID)),
            expression`${operation.payload}->>'commandID' = ${row.commandID}`,
          ),
        );
    });
    await removeCredential(row);
    await options.onCreated(row.projectID, row.userID);
  }

  async function ensureStarterFiles(
    repository: { owner: string; name: string },
    defaultBranch: string,
    row: RepositoryIntentSnapshot,
    current: RepositoryIntentSnapshot,
  ) {
    const files = await starterFiles();
    const head = await options.forge.getBranch(repository, defaultBranch || "main");
    if (!head) {
      assertRepositoryIntentMutable(current, { state: "repository-ready" });
      await updateRepositoryIntentState(db, row.commandID, { state: "repository-ready" });
      await options.forge.createSetupFiles({
        repository,
        branch: "main",
        files,
        setupID: row.setupID,
      });
      return;
    }
    // Lost initialization response is recoverable only from the whole
    // exact template, never a README marker or a guessed empty tree.
    const inventory = await options.forge.listFiles(repository, head.headSha);
    if (inventory.length !== files.length) throw setupConflictError();
    for (const file of files) {
      if ((await options.forge.getFile(repository, file.path, head.headSha)) !== file.content)
        throw setupConflictError();
    }
  }

  async function execute(row: RepositoryIntentSnapshot, authorizeCreate: boolean) {
    // Cross-process serialization covers the external call, not just SQL intent.
    try {
      await withSetupCoordinationLock(
        options.database,
        `project-setup:${row.setupID}`,
        async () => {
          await access.requireSystemManager(row.userID);
          const current = await loadRepositoryIntent(db, row.commandID);
          if (!current) throw setupConflictError();
          if (current.state === "committed") {
            await removeCredential(current);
            return;
          }
          const repository = { owner: options.forgeOwner, name: row.slug };
          let observed = await options.forge.setupRepository(repository, row.setupID);
          if (!observed) {
            if (!authorizeCreate) {
              assertRepositoryIntentMutable(current, { state: "uncertain" });
              await updateRepositoryIntentState(db, row.commandID, { state: "uncertain" });
              await updateActiveDraftState(db, row.setupID, row.userID, {
                state: "checking",
                error:
                  "Repository creation is still unconfirmed. Factory keeps checking without repeating creation or import.",
              });
              return;
            }
            let token: string | undefined;
            if (row.credentialKey) {
              const stored = await options.secrets.read(row.credentialKey);
              if (
                !stored ||
                stored.commandID !== row.commandID ||
                stored.fingerprint !== row.fingerprint
              )
                throw setupUnavailableError();
              token = stored.token;
            }
            assertRepositoryIntentMutable(current, { state: "create-intended" });
            await updateRepositoryIntentState(db, row.commandID, { state: "create-intended" });
            observed = await options.forge.createSetupRepository({
              repository,
              setupID: row.setupID,
              ...(row.kind === "import" ? { sourceURL: row.sourceURL } : {}),
              ...(token ? { importToken: token } : {}),
            });
          }
          if (row.kind === "starter") {
            await ensureStarterFiles(repository, observed.defaultBranch, row, current);
            observed = { defaultBranch: "main", empty: false };
          }
          const head = await options.forge.getBranch(repository, observed.defaultBranch);
          if (!head || observed.empty) throw setupUnavailableError();
          await finish(row, observed.defaultBranch);
        },
      );
    } catch (error) {
      const ambiguous =
        error instanceof ForgeAmbiguousWriteError ||
        (error instanceof CommandError && error.code === "unavailable");
      await updateRepositoryIntentState(db, row.commandID, {
        state: ambiguous ? "uncertain" : "failed",
        error: ambiguous
          ? "Repository setup is unconfirmed. Factory is checking without repeating creation or import."
          : "Repository setup could not finish. Check the repository access and try again.",
        completed: !ambiguous,
      });
      await updateActiveDraftState(db, row.setupID, row.userID, {
        state: ambiguous ? "checking" : "failed",
        error: ambiguous
          ? "Repository setup is unconfirmed. Factory is checking without repeating creation or import."
          : "Repository setup could not finish. Check repository access.",
        excludeCreated: true,
      });
    }
  }

  return { removeCredential, ensureImportCredential, execute };
}
