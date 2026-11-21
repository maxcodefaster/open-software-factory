import { createHmac } from "node:crypto";
import { and, asc, desc, eq, sql as expression } from "drizzle-orm";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  environmentWrite as environmentWriteTable,
  projectEnvironment,
  projectImagePreparation,
} from "../../../../packages/db/src/schema";
import {
  type EnvironmentBundle,
  type EnvironmentManifest,
  type EnvironmentSettingsView,
  type EnvironmentWriteInput,
  environmentManifest,
  environmentMetadata,
  environmentWrite,
  type ProjectEnvironment,
  replaceEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { type EnvironmentSecrets, emptyEnvironment, type StoredEnvironment } from "./openbao";

type Database = ReturnType<typeof createDatabase>;
type SettingsRow = Pick<
  typeof projectEnvironment.$inferSelect,
  "version" | "manifest" | "secretKey"
>;
type WriteRow = Pick<
  typeof environmentWriteTable.$inferSelect,
  "environment" | "baseVersion" | "fingerprint" | "secretKey" | "state" | "createdBy"
> & {
  commandID: string;
  projectID: string;
  manifest: EnvironmentManifest;
};

export function createEnvironmentController(
  database: Database,
  secrets: EnvironmentSecrets,
  signingKey: string,
) {
  const conflict = () =>
    new CommandError(
      "conflict",
      "Environment settings changed or a save is pending. Reload or retry the pending save.",
    );
  async function lock(
    sql: DatabaseTransaction,
    projectID: string,
    environment: ProjectEnvironment,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${projectID}:${environment}`}))`;
  }
  async function current(
    sql: DatabaseTransaction,
    projectID: string,
    environment: ProjectEnvironment,
  ): Promise<SettingsRow> {
    const [row] = await drizzleTransaction(sql)
      .select({
        version: projectEnvironment.version,
        manifest: projectEnvironment.manifest,
        secretKey: projectEnvironment.secretKey,
      })
      .from(projectEnvironment)
      .where(
        and(
          eq(projectEnvironment.projectId, projectID),
          eq(projectEnvironment.environment, environment),
        ),
      );
    return row ?? { version: 0, manifest: { variables: [], registries: [] }, secretKey: null };
  }
  async function writeRow(sql: DatabaseTransaction, commandID: string) {
    const [row] = await drizzleTransaction(sql)
      .select({
        commandID: environmentWriteTable.commandId,
        projectID: environmentWriteTable.projectId,
        environment: environmentWriteTable.environment,
        baseVersion: environmentWriteTable.baseVersion,
        fingerprint: environmentWriteTable.fingerprint,
        manifest: environmentWriteTable.manifest,
        secretKey: environmentWriteTable.secretKey,
        state: environmentWriteTable.state,
        createdBy: environmentWriteTable.createdBy,
      })
      .from(environmentWriteTable)
      .where(eq(environmentWriteTable.commandId, commandID));
    return row ? { ...row, manifest: environmentManifest.parse(row.manifest) } : undefined;
  }
  async function settle(row: WriteRow, stored: StoredEnvironment) {
    if (
      stored.commandID !== row.commandID ||
      stored.fingerprint !== row.fingerprint ||
      JSON.stringify(environmentMetadata(stored.bundle)) !==
        JSON.stringify(environmentManifest.parse(row.manifest))
    )
      throw new CommandError(
        "unavailable",
        "The stored environment does not match its save intent.",
      );
    return database.client.begin(async (sql) => {
      await lock(sql, row.projectID, row.environment);
      const intent = await writeRow(sql, row.commandID);
      if (!intent) throw conflict();
      if (intent.state === "committed") return true;
      if (intent.state === "discarded") throw conflict();
      try {
        await projectAuthorityIn(sql, intent.createdBy, intent.projectID, true);
      } catch (cause) {
        if (!(cause instanceof CommandError) || !["forbidden", "not-found"].includes(cause.code))
          throw cause;
        // Keep the encrypted external result, but never publish it after authority loss.
        await drizzleTransaction(sql)
          .update(environmentWriteTable)
          .set({ state: "discarded" })
          .where(eq(environmentWriteTable.commandId, intent.commandID));
        return false;
      }
      const active = await current(sql, row.projectID, row.environment);
      if (active.version !== row.baseVersion) throw conflict();
      const db = drizzleTransaction(sql);
      await db
        .insert(projectEnvironment)
        .values({
          projectId: row.projectID,
          environment: row.environment,
          version: row.baseVersion + 1,
          manifest: row.manifest,
          secretKey: row.secretKey,
        })
        .onConflictDoUpdate({
          target: [projectEnvironment.projectId, projectEnvironment.environment],
          set: {
            version: row.baseVersion + 1,
            manifest: row.manifest,
            secretKey: row.secretKey,
            updatedAt: expression`now()`,
          },
        });
      await db
        .update(environmentWriteTable)
        .set({ state: "committed", committedAt: expression`now()` })
        .where(eq(environmentWriteTable.commandId, row.commandID));
      return true;
    });
  }
  async function get(
    projectID: string,
    userID: string,
    environment: ProjectEnvironment,
  ): Promise<EnvironmentSettingsView> {
    return database.client.begin(async (sql) => {
      const canManage = await projectAuthorityIn(sql, userID, projectID);
      if (!canManage) await projectDevelopmentAuthorityIn(sql, userID, projectID);
      const row = await current(sql, projectID, environment);
      const db = drizzleTransaction(sql);
      const [pending] = await db
        .select({ commandID: environmentWriteTable.commandId })
        .from(environmentWriteTable)
        .where(
          and(
            eq(environmentWriteTable.projectId, projectID),
            eq(environmentWriteTable.environment, environment),
            eq(environmentWriteTable.state, "write-intended"),
          ),
        );
      const [preparation] = await db
        .select({ state: projectImagePreparation.state })
        .from(projectImagePreparation)
        .where(
          and(
            eq(projectImagePreparation.projectId, projectID),
            eq(projectImagePreparation.environment, environment),
            eq(projectImagePreparation.environmentVersion, row.version),
          ),
        )
        .orderBy(desc(projectImagePreparation.createdAt))
        .limit(1);
      return {
        ...environmentManifest.parse(row.manifest),
        environment,
        version: row.version,
        canManage,
        storeConfigured: secrets.configured,
        pending: Boolean(pending),
        pendingCommandID: pending?.commandID ?? null,
        preparation: preparation?.state ?? null,
      };
    });
  }
  async function save(
    projectID: string,
    userID: string,
    environment: ProjectEnvironment,
    value: EnvironmentWriteInput,
  ) {
    const input = environmentWrite.parse(value);
    // HMAC protects low-entropy values against offline guessing from persisted intent metadata.
    const fingerprint = createHmac("sha256", signingKey)
      .update(JSON.stringify(input))
      .digest("hex");
    const admission = await database.client.begin(async (sql) => {
      await lock(sql, projectID, environment);
      await projectAuthorityIn(sql, userID, projectID, true);
      if (!secrets.configured)
        throw new CommandError(
          "unavailable",
          "OpenBao is not configured. Ask a System Manager to connect the secret store.",
        );
      const existing = await writeRow(sql, input.commandID);
      if (existing) {
        if (
          existing.projectID !== projectID ||
          existing.environment !== environment ||
          existing.fingerprint !== fingerprint ||
          existing.state === "discarded" ||
          existing.createdBy !== userID
        )
          throw conflict();
        return { row: existing, bundle: undefined };
      }
      const active = await current(sql, projectID, environment);
      if (active.version !== input.version) throw conflict();
      const [pending] = await drizzleTransaction(sql)
        .select({ commandID: environmentWriteTable.commandId })
        .from(environmentWriteTable)
        .where(
          and(
            eq(environmentWriteTable.projectId, projectID),
            eq(environmentWriteTable.environment, environment),
            eq(environmentWriteTable.state, "write-intended"),
          ),
        );
      if (pending) throw conflict();
      const previous = active.secretKey ? await secrets.read(active.secretKey) : undefined;
      if (active.secretKey && !previous)
        throw new CommandError("unavailable", "The current environment values are unavailable.");
      let bundle: EnvironmentBundle;
      try {
        bundle = replaceEnvironment(input, previous?.bundle ?? emptyEnvironment);
      } catch {
        throw new CommandError(
          "conflict",
          "A new variable needs a value. Existing values remain masked.",
        );
      }
      const row: WriteRow = {
        commandID: input.commandID,
        projectID,
        environment,
        baseVersion: input.version,
        fingerprint,
        manifest: environmentMetadata(bundle),
        secretKey: `projects/${projectID}/${environment}/${input.commandID}`,
        state: "write-intended",
        createdBy: userID,
      };
      await drizzleTransaction(sql).insert(environmentWriteTable).values({
        commandId: row.commandID,
        projectId: projectID,
        environment,
        baseVersion: row.baseVersion,
        fingerprint,
        manifest: row.manifest,
        secretKey: row.secretKey,
        createdBy: userID,
      });
      return { row, bundle };
    });
    if (admission.row.state === "committed") return get(projectID, userID, environment);
    let stored = await secrets.read(admission.row.secretKey);
    if (!stored) {
      let bundle = admission.bundle;
      if (!bundle) {
        bundle = await database.client.begin(async (sql) => {
          await lock(sql, projectID, environment);
          await projectAuthorityIn(sql, userID, projectID, true);
          const active = await current(sql, projectID, environment);
          if (active.version !== admission.row.baseVersion) throw conflict();
          const previous = active.secretKey ? await secrets.read(active.secretKey) : undefined;
          if (active.secretKey && !previous)
            throw new CommandError(
              "unavailable",
              "The current environment values are unavailable.",
            );
          return replaceEnvironment(input, previous?.bundle ?? emptyEnvironment);
        });
      }
      stored = { commandID: input.commandID, fingerprint, bundle };
      try {
        await secrets.create(admission.row.secretKey, stored);
      } catch {
        const confirmed = await secrets.read(admission.row.secretKey);
        if (!confirmed)
          throw new CommandError(
            "unavailable",
            "Environment save is unconfirmed. Retry the same save; existing settings remain active.",
          );
        stored = confirmed;
      }
    }
    if (!(await settle(admission.row, stored)))
      throw new CommandError(
        "forbidden",
        "Project management access changed before the environment save completed.",
      );
    return get(projectID, userID, environment);
  }
  return {
    get,
    save,
    async discard(
      projectID: string,
      userID: string,
      environment: ProjectEnvironment,
      commandID: string,
    ) {
      await database.client.begin(async (sql) => {
        await lock(sql, projectID, environment);
        await projectAuthorityIn(sql, userID, projectID, true);
        const row = await writeRow(sql, commandID);
        if (
          !row ||
          row.projectID !== projectID ||
          row.environment !== environment ||
          row.state === "committed"
        )
          throw conflict();
        // Fence late external acknowledgements. Current settings and stored values are not deleted.
        await drizzleTransaction(sql)
          .update(environmentWriteTable)
          .set({ state: "discarded" })
          .where(eq(environmentWriteTable.commandId, commandID));
      });
      return get(projectID, userID, environment);
    },
    async recover() {
      if (!secrets.configured) return;
      const rows = await database.db
        .select({ commandID: environmentWriteTable.commandId })
        .from(environmentWriteTable)
        .where(eq(environmentWriteTable.state, "write-intended"))
        .orderBy(asc(environmentWriteTable.createdAt))
        .limit(32);
      for (const { commandID } of rows) {
        const row = await database.client.begin((sql) => writeRow(sql, commandID));
        if (row?.state !== "write-intended") continue;
        const stored = await secrets.read(row.secretKey);
        if (stored) await settle(row, stored);
      }
    },
  };
}
