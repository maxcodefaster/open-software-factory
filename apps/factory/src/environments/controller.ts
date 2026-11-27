import { createHmac } from "node:crypto";
import { and, asc, eq, sql as expression } from "drizzle-orm";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation as operationTable } from "#db/schema";
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
} from "#project-domain/environment";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { type EnvironmentSecrets, emptyEnvironment, type StoredEnvironment } from "./openbao";

const ENVIRONMENT_KIND = "environments.environment";
const ENVIRONMENT_SCOPE_TYPE = "project";
const environmentIdempotencyKey = (projectID: string, environment: ProjectEnvironment) =>
  `${ENVIRONMENT_KIND}:${projectID}:${environment}`;
const ENVIRONMENT_WRITE_KIND = "environments.write";
const ENVIRONMENT_WRITE_SCOPE_TYPE = "project_environment";
const environmentWriteScopeId = (projectID: string, environment: ProjectEnvironment) =>
  `${projectID}:${environment}`;
const environmentWriteActiveKey = (projectID: string, environment: ProjectEnvironment) =>
  `${ENVIRONMENT_WRITE_KIND}:${projectID}:${environment}`;
const environmentWriteIdempotencyKey = (secretKey: string) =>
  `${ENVIRONMENT_WRITE_KIND}:${secretKey}`;

type Database = ReturnType<typeof createDatabase>;
type SettingsRow = {
  version: number;
  manifest: EnvironmentManifest;
  secretKey: string | null;
};
type WritePayload = {
  projectID: string;
  environment: ProjectEnvironment;
  baseVersion: number;
  fingerprint: string;
  manifest: EnvironmentManifest;
  secretKey: string;
};
type WriteRow = WritePayload & {
  commandID: string;
  state: "write-intended" | "committed" | "discarded";
  createdBy: string;
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
      .select({ payload: operationTable.payload })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, ENVIRONMENT_KIND),
          eq(operationTable.scopeType, ENVIRONMENT_SCOPE_TYPE),
          eq(operationTable.scopeId, projectID),
          eq(operationTable.idempotencyKey, environmentIdempotencyKey(projectID, environment)),
        ),
      );
    if (!row) return { version: 0, manifest: { variables: [] }, secretKey: null };
    return {
      version: Number(row.payload["version"] ?? 0),
      manifest: environmentManifest.parse(row.payload["manifest"] ?? { variables: [] }),
      secretKey: typeof row.payload["secretKey"] === "string" ? row.payload["secretKey"] : null,
    };
  }
  async function writeRow(
    sql: DatabaseTransaction,
    commandID: string,
  ): Promise<WriteRow | undefined> {
    const [row] = await drizzleTransaction(sql)
      .select({
        commandID: operationTable.id,
        state: operationTable.state,
        createdBy: operationTable.createdBy,
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(
        and(eq(operationTable.id, commandID), eq(operationTable.kind, ENVIRONMENT_WRITE_KIND)),
      );
    if (!row?.createdBy) return undefined;
    const payload = row.payload as WritePayload;
    return {
      commandID: row.commandID,
      projectID: payload.projectID,
      environment: payload.environment,
      baseVersion: Number(payload.baseVersion),
      fingerprint: payload.fingerprint,
      manifest: environmentManifest.parse(payload.manifest),
      secretKey: payload.secretKey,
      state: row.state as WriteRow["state"],
      createdBy: row.createdBy,
    };
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
          .update(operationTable)
          .set({
            state: "discarded",
            activeKey: null,
            updatedAt: expression`now()`,
            completedAt: expression`now()`,
          })
          .where(
            and(
              eq(operationTable.id, intent.commandID),
              eq(operationTable.kind, ENVIRONMENT_WRITE_KIND),
            ),
          );
        return false;
      }
      const active = await current(sql, row.projectID, row.environment);
      if (active.version !== row.baseVersion) throw conflict();
      const db = drizzleTransaction(sql);
      const nextPayload = {
        projectId: row.projectID,
        environment: row.environment,
        version: row.baseVersion + 1,
        manifest: row.manifest,
        secretKey: row.secretKey,
      };
      await db
        .insert(operationTable)
        .values({
          id: crypto.randomUUID(),
          kind: ENVIRONMENT_KIND,
          scopeType: ENVIRONMENT_SCOPE_TYPE,
          scopeId: row.projectID,
          idempotencyKey: environmentIdempotencyKey(row.projectID, row.environment),
          activeKey: null,
          state: "saved",
          payload: nextPayload,
          createdBy: intent.createdBy,
        })
        .onConflictDoUpdate({
          target: operationTable.idempotencyKey,
          set: {
            state: "saved",
            payload: nextPayload,
            updatedAt: expression`now()`,
          },
        });
      await db
        .update(operationTable)
        .set({
          state: "committed",
          activeKey: null,
          updatedAt: expression`now()`,
          completedAt: expression`now()`,
        })
        .where(
          and(
            eq(operationTable.id, row.commandID),
            eq(operationTable.kind, ENVIRONMENT_WRITE_KIND),
          ),
        );
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
        .select({ commandID: operationTable.id })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, ENVIRONMENT_WRITE_KIND),
            eq(operationTable.scopeType, ENVIRONMENT_WRITE_SCOPE_TYPE),
            eq(operationTable.scopeId, environmentWriteScopeId(projectID, environment)),
            eq(operationTable.state, "write-intended"),
          ),
        );
      return {
        ...environmentManifest.parse(row.manifest),
        environment,
        version: row.version,
        canManage,
        storeConfigured: secrets.configured,
        pending: Boolean(pending),
        pendingCommandID: pending?.commandID ?? null,
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
        .select({ commandID: operationTable.id })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, ENVIRONMENT_WRITE_KIND),
            eq(operationTable.scopeType, ENVIRONMENT_WRITE_SCOPE_TYPE),
            eq(operationTable.scopeId, environmentWriteScopeId(projectID, environment)),
            eq(operationTable.state, "write-intended"),
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
      await drizzleTransaction(sql)
        .insert(operationTable)
        .values({
          id: row.commandID,
          kind: ENVIRONMENT_WRITE_KIND,
          scopeType: ENVIRONMENT_WRITE_SCOPE_TYPE,
          scopeId: environmentWriteScopeId(projectID, environment),
          idempotencyKey: environmentWriteIdempotencyKey(row.secretKey),
          activeKey: environmentWriteActiveKey(projectID, environment),
          state: "write-intended",
          payload: {
            projectID,
            environment,
            baseVersion: row.baseVersion,
            fingerprint,
            manifest: row.manifest,
            secretKey: row.secretKey,
          },
          result: null,
          error: null,
          createdBy: userID,
          completedAt: null,
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
          .update(operationTable)
          .set({
            state: "discarded",
            activeKey: null,
            updatedAt: expression`now()`,
            completedAt: expression`now()`,
          })
          .where(
            and(eq(operationTable.id, commandID), eq(operationTable.kind, ENVIRONMENT_WRITE_KIND)),
          );
      });
      return get(projectID, userID, environment);
    },
    async recover() {
      if (!secrets.configured) return;
      const rows = await database.db
        .select({ commandID: operationTable.id })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, ENVIRONMENT_WRITE_KIND),
            eq(operationTable.state, "write-intended"),
          ),
        )
        .orderBy(asc(operationTable.createdAt))
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
