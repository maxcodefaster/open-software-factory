import { createHmac } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  type SetupTask,
  type SetupTaskView,
  setupTask,
} from "../../../../packages/project-domain/src/setup";
import { createAccessController } from "../access/controller";
import type { createEnvironmentController } from "../environments/controller";

export function createSetupReadiness(input: {
  database: ReturnType<typeof createDatabase>;
  environments: ReturnType<typeof createEnvironmentController>;
  signingKey: string;
  protection(projectID: string): Promise<void>;
  hook(projectID: string): Promise<void>;
  wiki(projectID: string, userID: string): Promise<string>;
  prepare(projectID: string): Promise<{ development: string; preview: string }>;
  preview(projectID: string, userID: string): Promise<string>;
  requiredVariables?(projectID: string): Promise<readonly string[]>;
}) {
  const sql = input.database.client;
  const access = createAccessController(input.database);
  const running = new Map<string, Promise<void>>();

  async function status(projectID: string, userID: string) {
    await access.requireProject(userID, projectID);
    // Observe the admitted operation, never an unrelated newer generation.
    await sql`UPDATE factory.project_setup_readiness task SET state=CASE generation.state WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'running' END,
      failure=CASE WHEN generation.state='failed' THEN 'Wiki generation needs retry.' ELSE NULL END
      FROM factory.knowledge_generation generation
      WHERE task.project_id=${projectID} AND task.task='wiki' AND task.state='running'
        AND generation.project_id=task.project_id AND generation.id=task.operation_id`;
    await sql`UPDATE factory.project_setup_readiness task SET state=CASE attempt.state WHEN 'ready' THEN 'ready' WHEN 'failed' THEN 'failed' WHEN 'cleanup-failed' THEN 'failed' WHEN 'stopped' THEN 'failed' ELSE 'running' END,
      failure=CASE WHEN attempt.state IN ('failed','cleanup-failed','stopped') THEN 'Main-Preview startup needs retry.' ELSE NULL END
      FROM factory.runtime_attempt attempt
      WHERE task.project_id=${projectID} AND task.task='main-preview' AND task.state='running'
        AND attempt.project_id=task.project_id AND attempt.id=task.operation_id`;
    await sql`UPDATE factory.project_setup_readiness task SET state=CASE preparation.state WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' WHEN 'unsupported' THEN 'ready' ELSE 'running' END,
      failure=CASE preparation.state WHEN 'failed' THEN 'Image preparation needs attention. Normal startup remains available.' WHEN 'unsupported' THEN 'This configuration uses normal startup instead of a prebuilt image.' ELSE NULL END
      FROM factory.project_image_preparation preparation
      WHERE task.project_id=${projectID} AND task.task IN ('development','preview-image') AND task.state='running'
        AND preparation.project_id=task.project_id AND preparation.id=task.operation_id`;
    return sql<
      SetupTaskView[]
    >`SELECT task,state,command_id AS "commandID",operation_id AS "operationID",failure
      FROM factory.project_setup_readiness WHERE project_id=${projectID} ORDER BY task`;
  }

  async function seed(projectID: string, userID: string) {
    await access.requireProject(userID, projectID, true);
    for (const name of setupTask.options)
      await sql`INSERT INTO factory.project_setup_readiness(project_id,task,command_id)
        VALUES(${projectID},${name},${crypto.randomUUID()}) ON CONFLICT(project_id,task) DO NOTHING`;
  }

  async function task(
    projectID: string,
    userID: string,
    name: SetupTask,
    operation: (commandID: string) => Promise<string | undefined>,
    failure = "This step needs attention. Other work stays available.",
  ) {
    await access.requireProject(userID, projectID, true);
    const [claim] = await sql<{ commandID: string }[]>`UPDATE factory.project_setup_readiness
      SET state='running',failure=NULL,operation_id=NULL,updated_at=now()
      WHERE project_id=${projectID} AND task=${name} AND state='pending' RETURNING command_id AS "commandID"`;
    if (!claim) return;
    try {
      const operationID = await operation(claim.commandID);
      await sql`UPDATE factory.project_setup_readiness SET state=${operationID ? "running" : "ready"},
        operation_id=${operationID ?? null},failure=NULL,updated_at=now()
        WHERE project_id=${projectID} AND task=${name} AND command_id=${claim.commandID} AND state='running'`;
    } catch {
      await sql`UPDATE factory.project_setup_readiness SET state='failed',
        failure=${failure},updated_at=now()
        WHERE project_id=${projectID} AND task=${name} AND command_id=${claim.commandID} AND state='running'`;
    }
  }

  async function importedSettings(
    projectID: string,
    userID: string,
    name: SetupTask,
    environment: "development" | "main-preview",
  ) {
    await task(
      projectID,
      userID,
      name,
      async () => {
        const required = (await input.requiredVariables?.(projectID)) ?? [];
        const settings = await input.environments.get(projectID, userID, environment);
        if (
          settings.pending ||
          required.some(
            (name) =>
              !settings.variables.some((variable) => variable.name === name && variable.runtime),
          )
        )
          throw new Error("Required environment settings are missing");
        return undefined;
      },
      "Check required environment values in Settings, then retry this step.",
    );
  }

  async function secrets(
    projectID: string,
    userID: string,
    name: SetupTask,
    environment: "development" | "main-preview",
  ) {
    await task(projectID, userID, name, async (commandID) => {
      const current = await input.environments.get(projectID, userID, environment);
      if (current.version > 0 && current.pendingCommandID !== commandID) return;
      const value = (field: string) =>
        createHmac("sha256", input.signingKey)
          .update(`starter:${projectID}:${environment}:${commandID}:${field}`)
          .digest("hex");
      const password = value("postgres");
      await input.environments.save(projectID, userID, environment, {
        commandID,
        version: 0,
        registries: [],
        variables: [
          {
            name: "POSTGRES_PASSWORD",
            value: password,
            runtime: true,
            build: false,
            verification: true,
          },
          {
            name: "DATABASE_URL",
            value: `postgresql://app:${password}@postgres:5432/app`,
            runtime: true,
            build: false,
            verification: true,
          },
          {
            name: "BETTER_AUTH_SECRET",
            value: value("auth"),
            runtime: true,
            build: false,
            verification: true,
          },
        ],
      });
      return undefined;
    });
  }

  async function run(projectID: string, userID: string, starter: boolean, recovering: boolean) {
    const connection = await sql.reserve();
    try {
      const [lock] = await connection<
        { held: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext(${`project-readiness:${projectID}`})) AS held`;
      if (!lock?.held) return;
      try {
        await seed(projectID, userID);
        // Owning this lock proves there is no live coordinator in another process.
        // Missing acknowledgements never authorize another paid generation.
        if (recovering)
          await sql`UPDATE factory.project_setup_readiness SET state='failed',
          failure='Setup was interrupted. Check and retry this step.'
          WHERE project_id=${projectID} AND state='running' AND operation_id IS NULL`;
        if (starter) await task(projectID, userID, "configuration", async () => undefined);
        await Promise.all([
          task(projectID, userID, "hook", async () => {
            await input.hook(projectID);
            return undefined;
          }),
          task(projectID, userID, "wiki", () => input.wiki(projectID, userID)),
        ]);
        // Imported code never starts before its configuration is confirmed.
        const configured = (await status(projectID, userID)).some(
          (row) => row.task === "configuration" && row.state === "ready",
        );
        if (!configured) return;
        await Promise.all([
          ...(starter
            ? [
                secrets(projectID, userID, "development-secrets", "development"),
                secrets(projectID, userID, "preview-secrets", "main-preview"),
              ]
            : [
                importedSettings(projectID, userID, "development-secrets", "development"),
                importedSettings(projectID, userID, "preview-secrets", "main-preview"),
              ]),
          task(projectID, userID, "protection", async () => {
            await input.protection(projectID);
            return undefined;
          }),
        ]);
        const ready = await status(projectID, userID);
        const isReady = (name: SetupTask) =>
          ready.some((row) => row.task === name && row.state === "ready");
        if (isReady("development-secrets") && isReady("preview-secrets")) {
          let images: Awaited<ReturnType<typeof input.prepare>> | undefined;
          const prepare = async () => (images ??= await input.prepare(projectID));
          await task(projectID, userID, "development", async () => (await prepare()).development);
          await task(projectID, userID, "preview-image", async () => (await prepare()).preview);
        }
        if (isReady("preview-secrets"))
          await task(projectID, userID, "main-preview", () => input.preview(projectID, userID));
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtext(${`project-readiness:${projectID}`}))`;
      }
    } finally {
      connection.release();
    }
  }

  function start(projectID: string, userID: string, starter: boolean, recovering = false) {
    const active = running.get(projectID);
    if (active) return active;
    const work = run(projectID, userID, starter, recovering).finally(() =>
      running.delete(projectID),
    );
    running.set(projectID, work);
    return work;
  }
  async function retry(projectID: string, userID: string, name: SetupTask, starter: boolean) {
    await access.requireProject(userID, projectID, true);
    await status(projectID, userID);
    await sql`UPDATE factory.project_setup_readiness SET state='pending',failure=NULL,operation_id=NULL
      WHERE project_id=${projectID} AND task=${name} AND state='failed'`;
    await start(projectID, userID, starter);
  }
  async function recover() {
    const projects = await sql<{ id: string; userID: string; starter: boolean }[]>`SELECT
      intent.project_id AS id,intent.user_id AS "userID",intent.kind='starter' AS starter
      FROM factory.project_repository_intent intent WHERE intent.state='committed'`;
    for (const project of projects)
      void start(project.id, project.userID, project.starter, true).catch(() => {});
  }
  return { status, start, retry, recover };
}
