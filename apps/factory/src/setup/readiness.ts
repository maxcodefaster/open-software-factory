import { createHmac } from "node:crypto";
import { and, asc, eq, exists, sql as expression, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  knowledgeGeneration,
  project,
  projectImagePreparation,
  projectRepositoryIntent,
  projectSetupReadiness,
  runtimeAttempt,
} from "../../../../packages/db/src/schema";
import { type SetupTask, setupTask } from "../../../../packages/project-domain/src/setup";
import { createAccessController, projectAuthorityIn } from "../access/controller";
import type { createEnvironmentController } from "../environments/controller";

export function createSetupReadiness(input: {
  database: ReturnType<typeof createDatabase>;
  environments: ReturnType<typeof createEnvironmentController>;
  signingKey: string;
  protection(projectID: string): Promise<void>;
  hook(projectID: string): Promise<void>;
  wiki(projectID: string, userID: string, automatic: boolean): Promise<string>;
  prepare(projectID: string): Promise<{ development: string; preview: string }>;
  preview(projectID: string, userID: string): Promise<string>;
  requiredVariables?(projectID: string): Promise<readonly string[]>;
}) {
  const sql = input.database.client;
  const db = input.database.db;
  const access = createAccessController(input.database);
  const running = new Map<string, Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;

  async function status(projectID: string, userID: string) {
    await access.requireProject(userID, projectID);
    // Observe the admitted operation, never an unrelated newer generation.
    await db
      .update(projectSetupReadiness)
      .set({
        state: expression`CASE ${knowledgeGeneration.state} WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'running' END`,
        failure: expression`CASE WHEN ${knowledgeGeneration.state}='failed' THEN 'Wiki generation needs retry.' ELSE NULL END`,
      })
      .from(knowledgeGeneration)
      .where(
        and(
          eq(projectSetupReadiness.projectId, projectID),
          eq(projectSetupReadiness.task, "wiki"),
          eq(projectSetupReadiness.state, "running"),
          eq(knowledgeGeneration.projectId, projectSetupReadiness.projectId),
          eq(knowledgeGeneration.id, projectSetupReadiness.operationId),
        ),
      );
    await db
      .update(projectSetupReadiness)
      .set({
        state: expression`CASE ${runtimeAttempt.state} WHEN 'ready' THEN 'ready' WHEN 'failed' THEN 'failed' WHEN 'cleanup-failed' THEN 'failed' WHEN 'stopped' THEN 'failed' ELSE 'running' END`,
        failure: expression`CASE WHEN ${runtimeAttempt.state} IN ('failed','cleanup-failed','stopped') THEN 'Main-Preview startup needs retry.' ELSE NULL END`,
      })
      .from(runtimeAttempt)
      .where(
        and(
          eq(projectSetupReadiness.projectId, projectID),
          eq(projectSetupReadiness.task, "main-preview"),
          eq(projectSetupReadiness.state, "running"),
          eq(runtimeAttempt.projectId, projectSetupReadiness.projectId),
          eq(runtimeAttempt.id, projectSetupReadiness.operationId),
        ),
      );
    await db
      .update(projectSetupReadiness)
      .set({
        state: expression`CASE ${projectImagePreparation.state} WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' WHEN 'unsupported' THEN 'ready' ELSE 'running' END`,
        failure: expression`CASE ${projectImagePreparation.state} WHEN 'failed' THEN 'Image preparation needs attention. Normal startup remains available.' WHEN 'unsupported' THEN 'This configuration uses normal startup instead of a prebuilt image.' ELSE NULL END`,
      })
      .from(projectImagePreparation)
      .where(
        and(
          eq(projectSetupReadiness.projectId, projectID),
          inArray(projectSetupReadiness.task, ["development", "preview-image"]),
          eq(projectSetupReadiness.state, "running"),
          eq(projectImagePreparation.projectId, projectSetupReadiness.projectId),
          eq(projectImagePreparation.id, projectSetupReadiness.operationId),
        ),
      );
    return db
      .select({
        task: expression<SetupTask>`${projectSetupReadiness.task}`,
        state: projectSetupReadiness.state,
        commandID: projectSetupReadiness.commandId,
        operationID: projectSetupReadiness.operationId,
        failure: projectSetupReadiness.failure,
      })
      .from(projectSetupReadiness)
      .where(eq(projectSetupReadiness.projectId, projectID))
      .orderBy(asc(projectSetupReadiness.task));
  }

  async function observeWikiRetry(projectID: string, userID: string, generationID: string) {
    await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      const previous = alias(knowledgeGeneration, "previous");
      await projectAuthorityIn(transaction, userID, projectID);
      // Only the authenticated retry's returned operation can replace a failed
      // setup observation. Ordinary reads and newer background work cannot.
      await tx
        .update(projectSetupReadiness)
        .set({
          operationId: knowledgeGeneration.id,
          state: expression`CASE ${knowledgeGeneration.state} WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'running' END`,
          failure: expression`CASE WHEN ${knowledgeGeneration.state}='failed' THEN 'Wiki generation needs retry.' ELSE NULL END`,
          updatedAt: expression`now()`,
        })
        .from(knowledgeGeneration)
        .where(
          and(
            eq(projectSetupReadiness.projectId, projectID),
            eq(projectSetupReadiness.task, "wiki"),
            eq(knowledgeGeneration.id, generationID),
            eq(knowledgeGeneration.projectId, projectSetupReadiness.projectId),
            or(
              eq(projectSetupReadiness.state, "failed"),
              and(
                eq(projectSetupReadiness.state, "running"),
                exists(
                  tx
                    .select({ id: previous.id })
                    .from(previous)
                    .where(
                      and(
                        eq(previous.id, projectSetupReadiness.operationId),
                        eq(previous.projectId, projectSetupReadiness.projectId),
                        eq(previous.state, "failed"),
                      ),
                    ),
                ),
              ),
            ),
          ),
        );
    });
  }

  async function seed(projectID: string, userID: string) {
    await access.requireProject(userID, projectID, true);
    for (const name of setupTask.options)
      await db
        .insert(projectSetupReadiness)
        .values({ projectId: projectID, task: name, commandId: crypto.randomUUID() })
        .onConflictDoNothing({
          target: [projectSetupReadiness.projectId, projectSetupReadiness.task],
        });
  }

  async function task(
    projectID: string,
    userID: string,
    name: SetupTask,
    operation: (commandID: string) => Promise<string | undefined>,
    failure = "This step needs attention. Other work stays available.",
  ) {
    await access.requireProject(userID, projectID, true);
    const [claim] = await db
      .update(projectSetupReadiness)
      .set({ state: "running", failure: null, operationId: null, updatedAt: expression`now()` })
      .where(
        and(
          eq(projectSetupReadiness.projectId, projectID),
          eq(projectSetupReadiness.task, name),
          eq(projectSetupReadiness.state, "pending"),
        ),
      )
      .returning({ commandID: projectSetupReadiness.commandId });
    if (!claim) return;
    try {
      const operationID = await operation(claim.commandID);
      await db
        .update(projectSetupReadiness)
        .set({
          state: operationID ? "running" : "ready",
          operationId: operationID ?? null,
          failure: null,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(projectSetupReadiness.projectId, projectID),
            eq(projectSetupReadiness.task, name),
            eq(projectSetupReadiness.commandId, claim.commandID),
            eq(projectSetupReadiness.state, "running"),
          ),
        );
    } catch {
      await db
        .update(projectSetupReadiness)
        .set({ state: "failed", failure, updatedAt: expression`now()` })
        .where(
          and(
            eq(projectSetupReadiness.projectId, projectID),
            eq(projectSetupReadiness.task, name),
            eq(projectSetupReadiness.commandId, claim.commandID),
            eq(projectSetupReadiness.state, "running"),
          ),
        );
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

  async function run(
    projectID: string,
    userID: string,
    starter: boolean,
    recovering: boolean,
    retryWiki: boolean,
  ) {
    // Coordination must not consume the pool used by the tasks it protects.
    const connection = input.database.coordination();
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
          await db
            .update(projectSetupReadiness)
            .set({ state: "failed", failure: "Setup was interrupted. Check and retry this step." })
            .where(
              and(
                eq(projectSetupReadiness.projectId, projectID),
                eq(projectSetupReadiness.state, "running"),
                isNull(projectSetupReadiness.operationId),
              ),
            );
        if (starter) await task(projectID, userID, "configuration", async () => undefined);
        await Promise.all([
          task(projectID, userID, "hook", async () => {
            await input.hook(projectID);
            return undefined;
          }),
          task(projectID, userID, "wiki", () => input.wiki(projectID, userID, !retryWiki)),
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
      await connection.end({ timeout: 1 });
    }
  }

  function start(
    projectID: string,
    userID: string,
    starter: boolean,
    recovering = false,
    retryWiki = false,
  ) {
    if (stopping) return Promise.reject(new Error("Project preparation is shutting down"));
    const active = running.get(projectID);
    if (active) return active;
    const work = run(projectID, userID, starter, recovering, retryWiki).finally(() =>
      running.delete(projectID),
    );
    running.set(projectID, work);
    return work;
  }
  async function retry(projectID: string, userID: string, name: SetupTask, starter: boolean) {
    if (stopping) throw new Error("Project preparation is shutting down");
    await access.requireProject(userID, projectID, true);
    await status(projectID, userID);
    await db
      .update(projectSetupReadiness)
      .set({ state: "pending", failure: null, operationId: null })
      .where(
        and(
          eq(projectSetupReadiness.projectId, projectID),
          eq(projectSetupReadiness.task, name),
          eq(projectSetupReadiness.state, "failed"),
        ),
      );
    await start(projectID, userID, starter, false, name === "wiki");
  }
  async function recover() {
    if (stopping) return;
    const projects = await db
      .select({
        id: project.id,
        userID: expression<string>`COALESCE(${projectRepositoryIntent.userId},${project.createdBy})`,
        starter: expression<boolean>`COALESCE(${projectRepositoryIntent.kind}='starter',false)`,
      })
      .from(project)
      .leftJoin(projectRepositoryIntent, eq(projectRepositoryIntent.projectId, project.id))
      .where(
        or(
          eq(projectRepositoryIntent.state, "committed"),
          and(
            isNull(projectRepositoryIntent.projectId),
            exists(
              db
                .select({ projectID: projectSetupReadiness.projectId })
                .from(projectSetupReadiness)
                .where(eq(projectSetupReadiness.projectId, project.id)),
            ),
          ),
        ),
      );
    for (const project of projects)
      void start(project.id, project.userID, project.starter, true).catch(() => {});
  }
  function close() {
    stopping = true;
    closing ??= Promise.allSettled([...running.values()]).then(() => {});
    return closing;
  }
  return { status, start, retry, recover, observeWikiRetry, close };
}
