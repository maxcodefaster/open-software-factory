import { createHmac } from "node:crypto";
import { and, eq, sql as expression, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  administrator,
  project,
  projectMembership,
  projectRepositoryIntent,
  projectSetupDraft,
} from "../../../../packages/db/src/schema";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { ForgeAmbiguousWriteError } from "../../../../packages/forge/src/forge";
import {
  type ProjectSetupView,
  projectImportURL,
  projectSetupCreate,
  projectSetupSave,
  projectSetupView,
} from "../../../../packages/project-domain/src/setup";
import { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import { createProjectIn } from "../projects/creation";
import type { ImportSecrets } from "./secrets";
import { starterFiles } from "./starter";

type Database = ReturnType<typeof createDatabase>;

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
  const conflict = () =>
    new CommandError("conflict", "Project setup changed. Reload before continuing.");
  const unavailable = () =>
    new CommandError(
      "unavailable",
      "Repository setup is still being checked. Your setup is retained.",
    );

  async function view(userID: string): Promise<ProjectSetupView | null> {
    await access.requireSystemManager(userID);
    const [row] = await db
      .select({
        id: projectSetupDraft.id,
        version: projectSetupDraft.version,
        name: projectSetupDraft.name,
        slug: projectSetupDraft.slug,
        kind: projectSetupDraft.kind,
        sourceURL: projectSetupDraft.sourceUrl,
        state: projectSetupDraft.state,
        projectID: projectSetupDraft.projectId,
        commandID: projectSetupDraft.commandId,
        failure: projectSetupDraft.failure,
      })
      .from(projectSetupDraft)
      .where(eq(projectSetupDraft.userId, userID));
    return row ? projectSetupView.parse(row) : null;
  }

  async function begin(userID: string) {
    await access.requireSystemManager(userID);
    const id = crypto.randomUUID();
    await db
      .insert(projectSetupDraft)
      .values({ id, userId: userID })
      .onConflictDoUpdate({
        target: projectSetupDraft.userId,
        set: {
          id: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN ${id}::uuid ELSE ${projectSetupDraft.id} END`,
          version: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN 1 ELSE ${projectSetupDraft.version} END`,
          name: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN '' ELSE ${projectSetupDraft.name} END`,
          slug: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN '' ELSE ${projectSetupDraft.slug} END`,
          kind: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN 'starter' ELSE ${projectSetupDraft.kind} END`,
          sourceUrl: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN '' ELSE ${projectSetupDraft.sourceUrl} END`,
          projectId: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN NULL ELSE ${projectSetupDraft.projectId} END`,
          commandId: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN NULL ELSE ${projectSetupDraft.commandId} END`,
          failure: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN NULL ELSE ${projectSetupDraft.failure} END`,
          state: expression`CASE WHEN ${projectSetupDraft.state}='created' THEN 'draft' ELSE ${projectSetupDraft.state} END`,
        },
      });
    return view(userID);
  }

  async function save(userID: string, input: unknown) {
    await access.requireSystemManager(userID);
    const value = projectSetupSave.parse(input);
    const rows = await db
      .update(projectSetupDraft)
      .set({
        name: value.name,
        slug: value.slug,
        kind: value.kind,
        sourceUrl: value.sourceURL,
        version: expression`${projectSetupDraft.version}+1`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(projectSetupDraft.id, value.id),
          eq(projectSetupDraft.userId, userID),
          eq(projectSetupDraft.version, value.version),
          eq(projectSetupDraft.state, "draft"),
        ),
      )
      .returning({ id: projectSetupDraft.id });
    if (!rows.length) throw conflict();
    return view(userID);
  }

  async function startAnother(userID: string, setupID: string) {
    await access.requireSystemManager(userID);
    // Keep every external intent immutable. A new draft is a new operation,
    // never a retry with changed credentials or a replacement of retained Git.
    const rows = await db
      .update(projectSetupDraft)
      .set({
        id: crypto.randomUUID(),
        version: 1,
        name: "",
        slug: "",
        kind: "starter",
        sourceUrl: "",
        state: "draft",
        projectId: null,
        commandId: null,
        failure: null,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(projectSetupDraft.userId, userID),
          eq(projectSetupDraft.id, setupID),
          inArray(projectSetupDraft.state, ["checking", "failed"]),
        ),
      )
      .returning({ id: projectSetupDraft.id });
    if (!rows.length) throw conflict();
    return view(userID);
  }

  async function intent(commandID: string) {
    const [row] = await db
      .select({
        commandID: projectRepositoryIntent.commandId,
        setupID: projectRepositoryIntent.setupId,
        userID: projectRepositoryIntent.userId,
        projectID: projectRepositoryIntent.projectId,
        name: projectRepositoryIntent.name,
        slug: projectRepositoryIntent.slug,
        kind: projectRepositoryIntent.kind,
        sourceURL: projectRepositoryIntent.sourceUrl,
        credentialKey: projectRepositoryIntent.credentialKey,
        fingerprint: projectRepositoryIntent.fingerprint,
        state: projectRepositoryIntent.state,
      })
      .from(projectRepositoryIntent)
      .where(eq(projectRepositoryIntent.commandId, commandID));
    return row;
  }
  type Intent = NonNullable<Awaited<ReturnType<typeof intent>>>;

  async function removeCredential(row: Intent) {
    if (!row.credentialKey) return;
    const [active] = await db
      .select({ commandID: projectRepositoryIntent.commandId })
      .from(projectRepositoryIntent)
      .where(
        and(
          eq(projectRepositoryIntent.commandId, row.commandID),
          isNull(projectRepositoryIntent.credentialRemovedAt),
        ),
      );
    if (!active) return;
    await options.secrets.remove(row.credentialKey);
    await db
      .update(projectRepositoryIntent)
      .set({
        credentialRemovedAt: expression`COALESCE(${projectRepositoryIntent.credentialRemovedAt},now())`,
      })
      .where(eq(projectRepositoryIntent.commandId, row.commandID));
  }

  async function finish(row: Intent, branch: string) {
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
        .select({ state: projectRepositoryIntent.state })
        .from(projectRepositoryIntent)
        .where(eq(projectRepositoryIntent.commandId, row.commandID))
        .for("update");
      if (locked?.state === "committed") return;
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
        devcontainerPath: ".devcontainer/devcontainer.json",
        createdBy: row.userID,
      });
      await tx.insert(projectMembership).values({
        projectId: row.projectID,
        userId: row.userID,
        role: "developer",
        manageProject: true,
        updatedBy: row.userID,
      });
      await tx
        .update(projectRepositoryIntent)
        .set({
          state: "committed",
          defaultBranch: branch,
          failure: null,
          completedAt: expression`now()`,
        })
        .where(eq(projectRepositoryIntent.commandId, row.commandID));
      await tx
        .update(projectSetupDraft)
        .set({
          state: "created",
          projectId: row.projectID,
          failure: null,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(projectSetupDraft.id, row.setupID),
            eq(projectSetupDraft.userId, row.userID),
            eq(projectSetupDraft.commandId, row.commandID),
          ),
        );
    });
    await removeCredential(row);
    await options.onCreated(row.projectID, row.userID);
  }

  async function execute(row: Intent, authorizeCreate: boolean) {
    // Cross-process serialization covers the external call, not just SQL intent.
    const connection = options.database.coordination();
    try {
      const [lock] = await connection<
        { held: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext(${`project-setup:${row.setupID}`})) AS held`;
      if (!lock?.held) return;
      try {
        await access.requireSystemManager(row.userID);
        const current = await intent(row.commandID);
        if (!current) throw conflict();
        if (current.state === "committed") {
          await removeCredential(current);
          return;
        }
        const repository = { owner: options.forgeOwner, name: row.slug };
        let observed = await options.forge.setupRepository(repository, row.setupID);
        if (!observed) {
          if (!authorizeCreate) {
            await db
              .update(projectRepositoryIntent)
              .set({ state: "uncertain" })
              .where(eq(projectRepositoryIntent.commandId, row.commandID));
            await db
              .update(projectSetupDraft)
              .set({
                state: "checking",
                failure:
                  "Repository creation is still unconfirmed. Factory keeps checking without repeating creation or import.",
              })
              .where(eq(projectSetupDraft.id, row.setupID));
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
              throw unavailable();
            token = stored.token;
          }
          await db
            .update(projectRepositoryIntent)
            .set({ state: "create-intended" })
            .where(eq(projectRepositoryIntent.commandId, row.commandID));
          observed = await options.forge.createSetupRepository({
            repository,
            setupID: row.setupID,
            ...(row.kind === "import" ? { sourceURL: row.sourceURL } : {}),
            ...(token ? { importToken: token } : {}),
          });
        }
        if (row.kind === "starter") {
          const files = await starterFiles();
          const head = await options.forge.getBranch(repository, observed.defaultBranch || "main");
          if (!head) {
            await db
              .update(projectRepositoryIntent)
              .set({ state: "repository-ready" })
              .where(eq(projectRepositoryIntent.commandId, row.commandID));
            await options.forge.createSetupFiles({
              repository,
              branch: "main",
              files,
              setupID: row.setupID,
            });
          } else {
            // Lost initialization response is recoverable only from the whole
            // exact template, never a README marker or a guessed empty tree.
            const inventory = await options.forge.listFiles(repository, head.headSha);
            if (inventory.length !== files.length) throw conflict();
            for (const file of files)
              if (
                (await options.forge.getFile(repository, file.path, head.headSha)) !== file.content
              )
                throw conflict();
          }
          observed = { defaultBranch: "main", empty: false };
        }
        const head = await options.forge.getBranch(repository, observed.defaultBranch);
        if (!head || observed.empty) throw unavailable();
        await finish(row, observed.defaultBranch);
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtext(${`project-setup:${row.setupID}`}))`;
      }
    } catch (error) {
      const ambiguous =
        error instanceof ForgeAmbiguousWriteError ||
        (error instanceof CommandError && error.code === "unavailable");
      await db
        .update(projectRepositoryIntent)
        .set({
          state: ambiguous ? "uncertain" : "failed",
          failure: ambiguous
            ? "Repository setup is unconfirmed. Factory is checking without repeating creation or import."
            : "Repository setup could not finish. Check the repository access and try again.",
        })
        .where(
          and(
            eq(projectRepositoryIntent.commandId, row.commandID),
            ne(projectRepositoryIntent.state, "committed"),
          ),
        );
      await db
        .update(projectSetupDraft)
        .set({
          state: ambiguous ? "checking" : "failed",
          failure: ambiguous
            ? "Repository setup is unconfirmed. Factory is checking without repeating creation or import."
            : "Repository setup could not finish. Check repository access.",
        })
        .where(and(eq(projectSetupDraft.id, row.setupID), ne(projectSetupDraft.state, "created")));
    } finally {
      await connection.end({ timeout: 1 });
    }
  }

  async function create(userID: string, input: unknown) {
    await access.requireSystemManager(userID);
    const value = projectSetupCreate.parse(input);
    const admitted = await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      const [draft] = await tx
        .select()
        .from(projectSetupDraft)
        .where(eq(projectSetupDraft.userId, userID))
        .for("update");
      if (!draft || draft.id !== value.id) throw conflict();
      if (draft.commandId) {
        if (draft.commandId !== value.commandID) throw conflict();
        return false;
      }
      if (draft.version !== value.version || draft.state !== "draft" || !draft.name || !draft.slug)
        throw conflict();
      let sourceURL = "";
      if (draft.kind === "import")
        try {
          sourceURL = projectImportURL(draft.sourceUrl, options.importOrigins);
        } catch (cause) {
          throw new CommandError(
            "invalid",
            cause instanceof Error && cause.message.startsWith("Use ")
              ? cause.message
              : "Enter a valid HTTPS Git URL.",
          );
        }
      if (value.importToken && draft.kind !== "import") throw conflict();
      if (value.importToken && !options.secrets.configured) throw unavailable();
      const projectID = crypto.randomUUID();
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`project-setup-identity:${projectID}`},0))`;
      // Check before recording/dispatching Git creation. A retained Project or
      // another admitted setup is never converted or adopted as the fresh one.
      const [existing] = await tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectID))
        .unionAll(
          tx
            .select({ id: projectRepositoryIntent.projectId })
            .from(projectRepositoryIntent)
            .where(eq(projectRepositoryIntent.projectId, projectID)),
        );
      if (existing) throw conflict();
      const fingerprint = createHmac("sha256", options.signingKey)
        .update(
          JSON.stringify({
            setupID: value.id,
            name: draft.name,
            slug: draft.slug,
            kind: draft.kind,
            sourceURL,
            token: value.importToken ?? "",
          }),
        )
        .digest("hex");
      const key = value.importToken ? `imports/${value.id}/${value.commandID}` : null;
      await tx.insert(projectRepositoryIntent).values({
        commandId: value.commandID,
        setupId: value.id,
        userId: userID,
        projectId: projectID,
        name: draft.name,
        slug: draft.slug,
        kind: draft.kind as Intent["kind"],
        sourceUrl: sourceURL,
        credentialKey: key,
        fingerprint,
        state: key ? "credential-intended" : "create-intended",
      });
      await tx
        .update(projectSetupDraft)
        .set({ state: "creating", commandId: value.commandID, failure: null })
        .where(eq(projectSetupDraft.id, value.id));
      return true;
    });
    const row = await intent(value.commandID);
    if (!row || row.userID !== userID) throw conflict();
    if (value.importToken) {
      const fingerprint = createHmac("sha256", options.signingKey)
        .update(
          JSON.stringify({
            setupID: row.setupID,
            name: row.name,
            slug: row.slug,
            kind: row.kind,
            sourceURL: row.sourceURL,
            token: value.importToken,
          }),
        )
        .digest("hex");
      if (fingerprint !== row.fingerprint) throw conflict();
    }
    if (row.state === "credential-intended") {
      const fingerprint = createHmac("sha256", options.signingKey)
        .update(
          JSON.stringify({
            setupID: row.setupID,
            name: row.name,
            slug: row.slug,
            kind: row.kind,
            sourceURL: row.sourceURL,
            token: value.importToken ?? "",
          }),
        )
        .digest("hex");
      const existing = row.credentialKey
        ? await options.secrets.read(row.credentialKey)
        : undefined;
      if (!existing) {
        if (fingerprint !== row.fingerprint || !value.importToken || !row.credentialKey)
          throw conflict();
        await options.secrets.create(row.credentialKey, {
          commandID: row.commandID,
          fingerprint: row.fingerprint,
          token: value.importToken,
        });
      } else if (existing.commandID !== row.commandID || existing.fingerprint !== row.fingerprint)
        throw conflict();
    }
    await execute(row, admitted || row.state === "credential-intended");
    return view(userID);
  }

  async function check(userID: string, setupID: string) {
    const draft = await view(userID);
    if (!draft || draft.id !== setupID) throw conflict();
    if (draft.commandID) {
      const row = await intent(draft.commandID);
      if (row) await execute(row, false);
    }
    return view(userID);
  }

  async function retry(userID: string, setupID: string) {
    const draft = await view(userID);
    if (!draft || draft.id !== setupID || draft.state !== "failed" || !draft.commandID)
      throw conflict();
    const row = await intent(draft.commandID);
    if (row?.state !== "failed") throw conflict();
    await execute(row, true);
    return view(userID);
  }

  async function recover() {
    // An explicit new draft must not strand an older unconfirmed operation.
    // Observation can settle it, but never authorizes another external create.
    const rows = await db
      .select({ commandID: projectRepositoryIntent.commandId })
      .from(projectRepositoryIntent)
      .where(
        inArray(projectRepositoryIntent.state, [
          "credential-intended",
          "create-intended",
          "repository-ready",
          "uncertain",
        ]),
      );
    for (const row of rows) {
      const saved = await intent(row.commandID);
      if (saved) await execute(saved, false);
    }
    const completed = await db
      .select({ commandID: projectRepositoryIntent.commandId })
      .from(projectRepositoryIntent)
      .where(
        and(
          eq(projectRepositoryIntent.state, "committed"),
          isNotNull(projectRepositoryIntent.credentialKey),
          isNull(projectRepositoryIntent.credentialRemovedAt),
        ),
      );
    for (const row of completed) {
      const saved = await intent(row.commandID);
      if (saved) await removeCredential(saved);
    }
  }
  return { view, begin, startAnother, save, create, check, retry, recover };
}
