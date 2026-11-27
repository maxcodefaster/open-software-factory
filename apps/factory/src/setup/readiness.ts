import { createHmac } from "node:crypto";
import { and, asc, eq, exists, sql as expression, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { operation, project, runtimeAttempt } from "#db/schema";
import { type SetupTask, setupTask } from "#project-domain/setup";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import type { createEnvironmentController } from "../environments/api";

const readinessKey = (projectID: string, task: SetupTask) =>
  `projects.setup_readiness:${projectID}:${task}`;

export function createSetupReadiness(input: {
  database: ReturnType<typeof createDatabase>;
  environments: ReturnType<typeof createEnvironmentController>;
  signingKey: string;
  protection(projectID: string): Promise<void>;
  hook(projectID: string): Promise<void>;
  wiki(projectID: string, userID: string, automatic: boolean): Promise<string>;
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
    const generation = alias(operation, "generation");
    await db
      .update(operation)
      .set({
        state: expression`CASE ${generation.state} WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'running' END`,
        error: expression`CASE WHEN ${generation.state}='failed' THEN 'Wiki generation needs retry.' ELSE NULL END`,
        completedAt: expression`CASE WHEN ${generation.state} IN ('succeeded','failed') THEN COALESCE(${operation.completedAt}, now()) ELSE NULL END`,
        updatedAt: expression`now()`,
      })
      .from(generation)
      .where(
        and(
          eq(operation.kind, "projects.setup_readiness"),
          eq(operation.scopeType, "project"),
          eq(operation.scopeId, projectID),
          eq(operation.idempotencyKey, readinessKey(projectID, "wiki")),
          eq(operation.state, "running"),
          eq(generation.kind, "knowledge.generation"),
          eq(generation.scopeType, "project"),
          eq(generation.scopeId, projectID),
          expression`${generation.id}::text = ${operation.result}->>'operationId'`,
        ),
      );
    await db
      .update(operation)
      .set({
        state: expression`CASE ${runtimeAttempt.state} WHEN 'ready' THEN 'ready' WHEN 'failed' THEN 'failed' WHEN 'cleanup-failed' THEN 'failed' WHEN 'stopped' THEN 'failed' ELSE 'running' END`,
        error: expression`CASE WHEN ${runtimeAttempt.state} IN ('failed','cleanup-failed','stopped') THEN 'Main-Preview startup needs retry.' ELSE NULL END`,
        completedAt: expression`CASE WHEN ${runtimeAttempt.state} IN ('ready','failed','cleanup-failed','stopped') THEN COALESCE(${operation.completedAt}, now()) ELSE NULL END`,
        updatedAt: expression`now()`,
      })
      .from(runtimeAttempt)
      .where(
        and(
          eq(operation.kind, "projects.setup_readiness"),
          eq(operation.scopeType, "project"),
          eq(operation.scopeId, projectID),
          eq(operation.idempotencyKey, readinessKey(projectID, "main-preview")),
          eq(operation.state, "running"),
          eq(runtimeAttempt.projectId, projectID),
          expression`${runtimeAttempt.id}::text = ${operation.result}->>'operationId'`,
        ),
      );
    return db
      .select({
        task: expression<SetupTask>`${operation.payload}->>'task'`,
        state: expression<"pending" | "running" | "ready" | "failed">`${operation.state}`,
        commandID: expression<string>`${operation.payload}->>'commandId'`,
        operationID: expression<string | null>`${operation.result}->>'operationId'`,
        failure: operation.error,
      })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "projects.setup_readiness"),
          eq(operation.scopeType, "project"),
          eq(operation.scopeId, projectID),
        ),
      )
      .orderBy(asc(expression`${operation.payload}->>'task'`));
  }

  async function observeWikiRetry(projectID: string, userID: string, generationID: string) {
    await sql.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      const generation = alias(operation, "generation");
      const previous = alias(operation, "previous");
      await projectAuthorityIn(transaction, userID, projectID);
      // Only the authenticated retry's returned operation can replace a failed
      // setup observation. Ordinary reads and newer background work cannot.
      await tx
        .update(operation)
        .set({
          result: expression`jsonb_build_object('operationId', ${generation.id}::text)`,
          state: expression`CASE ${generation.state} WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'running' END`,
          error: expression`CASE WHEN ${generation.state}='failed' THEN 'Wiki generation needs retry.' ELSE NULL END`,
          completedAt: expression`CASE WHEN ${generation.state} IN ('succeeded','failed') THEN now() ELSE NULL END`,
          updatedAt: expression`now()`,
        })
        .from(generation)
        .where(
          and(
            eq(operation.kind, "projects.setup_readiness"),
            eq(operation.scopeType, "project"),
            eq(operation.scopeId, projectID),
            eq(operation.idempotencyKey, readinessKey(projectID, "wiki")),
            eq(generation.kind, "knowledge.generation"),
            eq(generation.scopeType, "project"),
            eq(generation.scopeId, projectID),
            eq(generation.id, generationID),
            or(
              eq(operation.state, "failed"),
              and(
                eq(operation.state, "running"),
                exists(
                  tx
                    .select({ id: previous.id })
                    .from(previous)
                    .where(
                      and(
                        eq(previous.kind, "knowledge.generation"),
                        eq(previous.scopeType, "project"),
                        eq(previous.scopeId, projectID),
                        expression`${previous.id}::text = ${operation.result}->>'operationId'`,
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
    for (const name of setupTask.options) {
      await db
        .insert(operation)
        .values({
          id: crypto.randomUUID(),
          kind: "projects.setup_readiness",
          scopeType: "project",
          scopeId: projectID,
          idempotencyKey: readinessKey(projectID, name),
          state: "pending",
          payload: { task: name, commandId: crypto.randomUUID() },
          createdBy: userID,
        })
        .onConflictDoNothing({
          target: operation.idempotencyKey,
        });
    }
  }

  async function task(
    projectID: string,
    userID: string,
    name: SetupTask,
    work: (commandID: string) => Promise<string | undefined>,
    failure = "This step needs attention. Other work stays available.",
  ) {
    await access.requireProject(userID, projectID, true);
    const [claim] = await db
      .update(operation)
      .set({
        state: "running",
        error: null,
        result: null,
        completedAt: null,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.kind, "projects.setup_readiness"),
          eq(operation.scopeType, "project"),
          eq(operation.scopeId, projectID),
          eq(operation.idempotencyKey, readinessKey(projectID, name)),
          eq(operation.state, "pending"),
        ),
      )
      .returning({ commandID: expression<string>`${operation.payload}->>'commandId'` });
    if (!claim) return;
    try {
      const operationID = await work(claim.commandID);
      await db
        .update(operation)
        .set({
          state: operationID ? "running" : "ready",
          result: operationID ? { operationId: operationID } : null,
          error: null,
          completedAt: operationID ? null : expression`now()`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.kind, "projects.setup_readiness"),
            eq(operation.scopeType, "project"),
            eq(operation.scopeId, projectID),
            eq(operation.idempotencyKey, readinessKey(projectID, name)),
            expression`${operation.payload}->>'commandId' = ${claim.commandID}`,
            eq(operation.state, "running"),
          ),
        );
    } catch {
      await db
        .update(operation)
        .set({
          state: "failed",
          error: failure,
          completedAt: expression`now()`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.kind, "projects.setup_readiness"),
            eq(operation.scopeType, "project"),
            eq(operation.scopeId, projectID),
            eq(operation.idempotencyKey, readinessKey(projectID, name)),
            expression`${operation.payload}->>'commandId' = ${claim.commandID}`,
            eq(operation.state, "running"),
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
        variables: [
          {
            name: "POSTGRES_PASSWORD",
            value: password,
            runtime: true,
            verification: true,
          },
          {
            name: "DATABASE_URL",
            value: `postgresql://app:${password}@127.0.0.1:5432/app`,
            runtime: true,
            verification: true,
          },
          {
            name: "BETTER_AUTH_SECRET",
            value: value("auth"),
            runtime: true,
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
            .update(operation)
            .set({
              state: "failed",
              error: "Setup was interrupted. Check and retry this step.",
              completedAt: expression`now()`,
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(operation.kind, "projects.setup_readiness"),
                eq(operation.scopeType, "project"),
                eq(operation.scopeId, projectID),
                eq(operation.state, "running"),
                expression`${operation.result}->>'operationId' IS NULL`,
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
      .update(operation)
      .set({
        state: "pending",
        error: null,
        result: null,
        completedAt: null,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operation.kind, "projects.setup_readiness"),
          eq(operation.scopeType, "project"),
          eq(operation.scopeId, projectID),
          eq(operation.idempotencyKey, readinessKey(projectID, name)),
          eq(operation.state, "failed"),
        ),
      );
    await start(projectID, userID, starter, false, name === "wiki");
  }
  async function recover() {
    if (stopping) return;
    const repoIntent = alias(operation, "repo_intent");
    const readiness = alias(operation, "setup_readiness");
    const projects = await db
      .select({
        id: project.id,
        userID: expression<string>`COALESCE(${repoIntent.createdBy},${project.createdBy})`,
        starter: expression<boolean>`COALESCE((${repoIntent.payload}->>'kind')='starter',false)`,
      })
      .from(project)
      .leftJoin(
        repoIntent,
        and(
          eq(repoIntent.kind, "projects.repository_intent"),
          eq(repoIntent.scopeType, "project"),
          eq(
            repoIntent.idempotencyKey,
            expression<string>`'projects.repository_intent:' || ${project.id}::text`,
          ),
        ),
      )
      .where(
        or(
          eq(repoIntent.state, "committed"),
          and(
            isNull(repoIntent.id),
            exists(
              db
                .select({ id: readiness.id })
                .from(readiness)
                .where(
                  and(
                    eq(readiness.kind, "projects.setup_readiness"),
                    eq(readiness.scopeType, "project"),
                    expression`${readiness.scopeId} = ${project.id}::text`,
                  ),
                ),
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
