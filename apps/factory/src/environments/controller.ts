import { createHmac } from "node:crypto";
import {
  environmentManifest,
  environmentMetadata,
  environmentWrite,
  replaceEnvironment,
  type EnvironmentManifest,
  type EnvironmentSettingsView,
  type EnvironmentWrite,
  type EnvironmentBundle,
  type ProjectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { emptyEnvironment, type EnvironmentSecrets, type StoredEnvironment } from "./openbao";

type Database = ReturnType<typeof createDatabase>;
type SettingsRow = { version: number; manifest: EnvironmentManifest; secretKey: string | null };
type WriteRow = {
  commandID: string;
  projectID: string;
  environment: ProjectEnvironment;
  baseVersion: number;
  fingerprint: string;
  manifest: EnvironmentManifest;
  secretKey: string;
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
    sql: AgentTurnTransaction,
    projectID: string,
    environment: ProjectEnvironment,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${projectID}:${environment}`}))`;
  }
  async function current(
    sql: AgentTurnTransaction,
    projectID: string,
    environment: ProjectEnvironment,
  ): Promise<SettingsRow> {
    const [row] = await sql<SettingsRow[]>`SELECT version::float8 AS version, manifest,
      secret_key AS "secretKey" FROM factory.project_environment
      WHERE project_id=${projectID} AND environment=${environment}`;
    return row ?? { version: 0, manifest: { variables: [], registries: [] }, secretKey: null };
  }
  async function writeRow(sql: AgentTurnTransaction, commandID: string) {
    const [row] = await sql<WriteRow[]>`SELECT command_id AS "commandID", project_id AS "projectID",
      environment, base_version::float8 AS "baseVersion", fingerprint, manifest,
      secret_key AS "secretKey", state, created_by AS "createdBy"
      FROM factory.environment_write WHERE command_id=${commandID}`;
    return row;
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
    await database.client.begin(async (sql) => {
      await lock(sql, row.projectID, row.environment);
      const intent = await writeRow(sql, row.commandID);
      if (!intent || intent.state === "committed") return;
      if (intent.state === "discarded") throw conflict();
      const active = await current(sql, row.projectID, row.environment);
      if (active.version !== row.baseVersion) throw conflict();
      await sql`INSERT INTO factory.project_environment(project_id, environment, version, manifest, secret_key)
        VALUES (${row.projectID}, ${row.environment}, ${row.baseVersion + 1}, ${JSON.stringify(row.manifest)}::jsonb, ${row.secretKey})
        ON CONFLICT (project_id, environment) DO UPDATE SET version=EXCLUDED.version,
          manifest=EXCLUDED.manifest, secret_key=EXCLUDED.secret_key, updated_at=now()`;
      await sql`UPDATE factory.environment_write SET state='committed', committed_at=now()
        WHERE command_id=${row.commandID}`;
    });
  }
  async function get(
    projectID: string,
    userID: string,
    environment: ProjectEnvironment,
  ): Promise<EnvironmentSettingsView> {
    return database.client.begin(async (sql) => {
      await projectDevelopmentAuthorityIn(sql, userID, projectID);
      const canManage = await projectAuthorityIn(sql, userID, projectID);
      const row = await current(sql, projectID, environment);
      const [pending] = await sql<
        Array<{ commandID: string }>
      >`SELECT command_id AS "commandID" FROM factory.environment_write
        WHERE project_id=${projectID} AND environment=${environment} AND state='write-intended'`;
      const [preparation] = await sql<
        Array<{ state: "pending" | "running" | "succeeded" | "unsupported" | "failed" }>
      >`SELECT state FROM factory.project_image_preparation WHERE project_id=${projectID} AND environment=${environment} AND environment_version=${row.version} ORDER BY created_at DESC LIMIT 1`;
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
    value: EnvironmentWrite,
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
      const [pending] = await sql`SELECT command_id FROM factory.environment_write
        WHERE project_id=${projectID} AND environment=${environment} AND state='write-intended'`;
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
      await sql`INSERT INTO factory.environment_write(command_id, project_id, environment, base_version,
        fingerprint, manifest, secret_key, created_by) VALUES (${row.commandID}, ${projectID}, ${environment},
        ${row.baseVersion}, ${fingerprint}, ${JSON.stringify(row.manifest)}::jsonb, ${row.secretKey}, ${userID})`;
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
    await database.client.begin((sql) => projectAuthorityIn(sql, userID, projectID, true));
    await settle(admission.row, stored);
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
        await sql`UPDATE factory.environment_write SET state='discarded' WHERE command_id=${commandID}`;
      });
      return get(projectID, userID, environment);
    },
    async recover() {
      if (!secrets.configured) return;
      const rows = await database.client<
        Array<{ commandID: string }>
      >`SELECT command_id AS "commandID"
        FROM factory.environment_write WHERE state='write-intended' ORDER BY created_at LIMIT 32`;
      for (const { commandID } of rows) {
        const row = await database.client.begin((sql) => writeRow(sql, commandID));
        if (row?.state !== "write-intended") continue;
        const stored = await secrets.read(row.secretKey);
        if (stored) await settle(row, stored);
      }
    },
  };
}
