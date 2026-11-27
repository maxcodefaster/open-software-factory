import { and, asc, desc, eq, exists, sql as expression, inArray, isNull } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import {
  administrator,
  operation,
  projectMembership,
  project as projectTable,
  usageOperation,
} from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { createModelSettingsController } from "../models/api";
import { createUsageJournal } from "../usage/journal-api";
import { generateWiki } from "./generation-agent";
import type { WikiGenerationInput } from "./generation-contracts";
import { executeWikiGeneration } from "./generation-execution";
import { createKnowledgePages } from "./page-operations";
import {
  createKnowledgeRepository,
  type KnowledgeDatabase,
  projectGenerationWhere,
  type RepositoryReader,
} from "./repository-source";

export function createKnowledgeController(
  database: KnowledgeDatabase,
  repositoryReader?: RepositoryReader,
  generationAgent: (input: WikiGenerationInput) => ReturnType<typeof generateWiki> = generateWiki,
) {
  const {
    FACTORY_FORGEJO_API_URL,
    FACTORY_FORGEJO_PUBLIC_URL,
    FACTORY_FORGEJO_TOKEN,
    FACTORY_FORGEJO_OWNER,
  } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge = createForgejoClient({
    apiURL: FACTORY_FORGEJO_API_URL,
    token: FACTORY_FORGEJO_TOKEN,
  });
  const repository = createKnowledgeRepository(database, repositoryReader ?? forge, {
    apiURL: FACTORY_FORGEJO_API_URL,
    publicURL: FACTORY_FORGEJO_PUBLIC_URL,
    owner: FACTORY_FORGEJO_OWNER,
  });
  const pages = createKnowledgePages(database, repository);
  const models = createModelSettingsController(database);
  const running = new Set<string>();
  const executions = new Set<Promise<void>>();
  const lifetime = new AbortController();

  async function executeGeneration(generationID: string) {
    if (running.has(generationID) || running.size >= 2) return;
    running.add(generationID);
    try {
      await executeWikiGeneration(
        { database, repository, models, generationAgent, signal: lifetime.signal },
        generationID,
      );
    } finally {
      running.delete(generationID);
      const pendingRows = await database.db
        .select({ id: operation.id })
        .from(operation)
        .where(and(eq(operation.kind, "knowledge.generation"), eq(operation.state, "pending")))
        .orderBy(asc(operation.createdAt), asc(operation.id))
        .limit(2);
      for (const pending of pendingRows) void runGeneration(pending.id);
    }
  }

  function runGeneration(generationID: string) {
    if (lifetime.signal.aborted) return Promise.resolve();
    const execution = executeGeneration(generationID);
    executions.add(execution);
    void execution
      .finally(() => executions.delete(execution))
      .catch(reportFailure("Wiki generation"));
    return execution;
  }

  const controller = {
    codePaths: repository.codePaths,
    code: repository.code,
    documents: repository.documents,
    document: repository.document,
    edit: pages.edit,
    archive: pages.archive,
    restore: pages.restore,
    sources: pages.sources,
    history: pages.history,
    search: pages.search,
    async settle() {
      while (executions.size) await Promise.allSettled([...executions]);
    },
    async close() {
      lifetime.abort(new Error("Factory is shutting down; Wiki work was cancelled."));
      while (executions.size) await Promise.allSettled([...executions]);
    },
    async recover() {
      const abandoned = await database.db
        .select({ id: usageOperation.id })
        .from(usageOperation)
        .innerJoin(
          operation,
          and(
            eq(operation.kind, "knowledge.generation"),
            eq(
              expression<string>`split_part(${usageOperation.id},':',2)`,
              expression`${operation.id}::text`,
            ),
          ),
        )
        .where(
          and(
            eq(usageOperation.purpose, "wiki"),
            isNull(usageOperation.settledAt),
            eq(operation.state, "running"),
          ),
        );
      for (const abandonedOp of abandoned)
        await createUsageJournal(database).abandon(abandonedOp.id);
      await database.db
        .update(operation)
        .set({
          state: "pending",
          payload: expression`${operation.payload} || jsonb_build_object('attemptId', NULL)`,
          updatedAt: expression`now()`,
        })
        .where(and(eq(operation.kind, "knowledge.generation"), eq(operation.state, "running")));
      const generations = await database.db
        .select({ id: operation.id })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "knowledge.generation"),
            inArray(operation.state, ["pending", "running"]),
          ),
        );
      for (const generation of generations) void runGeneration(generation.id);
    },
    async generate(projectID: string, userID: string, automatic = false) {
      lifetime.signal.throwIfAborted();
      const settings = await models.getInherited(projectID, userID);
      if (!settings.projectEffective.planning.available)
        throw new CommandError("unavailable", "Project Wiki model is not approved.");
      const current = await repository.inventory(projectID);
      const id = await database.client.begin(async (sql) => {
        await projectAuthorityIn(sql, userID, projectID);
        const db = drizzleTransaction(sql);
        await db
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(eq(projectTable.id, projectID))
          .for("update");
        const [existing] = await db
          .select({ id: operation.id })
          .from(operation)
          .where(
            and(
              projectGenerationWhere(projectID),
              inArray(operation.state, ["pending", "running"]),
            ),
          );
        if (existing) return undefined;
        if (automatic) {
          const [handled] = await db
            .select({ id: operation.id })
            .from(operation)
            .where(
              and(
                projectGenerationWhere(projectID),
                eq(expression<string>`${operation.payload}->>'sourceCommitSha'`, current.commitSha),
              ),
            )
            .limit(1);
          // Reconciliation observes an attempted source revision. It must not
          // keep commissioning paid generations after a definite failure.
          // A new source commit or an explicit human Retry can start new work.
          if (handled) return undefined;
        }
        const id = crypto.randomUUID();
        await db.insert(operation).values({
          id,
          kind: "knowledge.generation",
          scopeType: "project",
          scopeId: projectID,
          idempotencyKey: `knowledge.generation:${id}`,
          activeKey: `knowledge.generation:${projectID}`,
          state: "pending",
          error: null,
          createdBy: userID,
          payload: {
            id,
            projectId: projectID,
            sourceCommitSha: current.commitSha,
            pageCount: null,
            conflictCount: null,
            failure: null,
            createdBy: userID,
            modelId: settings.projectEffective.planning.modelId,
            attemptId: null,
            modelConnectionId: null,
            modelConnectionVersion: null,
            progress: null,
          },
        });
        return id;
      });
      if (id) void runGeneration(id);
      return this.generation(projectID);
    },
    async reconcile(projectID?: string) {
      const db = database.db;
      const member = db
        .select({ userId: projectMembership.userId })
        .from(projectMembership)
        .where(eq(projectMembership.projectId, projectTable.id))
        .orderBy(asc(projectMembership.userId))
        .limit(1);
      const admin = db
        .select({ userId: administrator.userId })
        .from(administrator)
        .orderBy(asc(administrator.userId))
        .limit(1);
      const projects = await db
        .select({
          id: projectTable.id,
          userId: expression<string | null>`coalesce((${member}),(${admin}))`,
        })
        .from(projectTable)
        .where(
          and(
            projectID === undefined || projectID === null
              ? undefined
              : eq(projectTable.id, projectID),
            exists(
              db
                .select({ id: operation.id })
                .from(operation)
                .where(
                  and(
                    eq(operation.kind, "knowledge.generation"),
                    eq(operation.scopeType, "project"),
                    eq(operation.scopeId, expression<string>`${projectTable.id}::text`),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(projectTable.id));
      for (const project of projects) {
        if (!project.userId) continue;
        try {
          await this.generate(project.id, project.userId, true);
        } catch {
          /* A repository/access failure is retried on the next bounded reconciliation. */
        }
      }
    },
    async generation(projectID: string) {
      const rows = await database.db
        .select({
          id: operation.id,
          state: operation.state,
          pageCount: expression<number | null>`(${operation.payload}->>'pageCount')::int`,
          conflictCount: expression<number | null>`(${operation.payload}->>'conflictCount')::int`,
          failure: expression<
            string | null
          >`coalesce(${operation.error}, ${operation.payload}->>'failure')`,
          createdAt: expression<string>`${operation.createdAt}::text`,
          completedAt: expression<string | null>`${operation.completedAt}::text`,
          progress: expression<unknown>`NULLIF(${operation.payload}->'progress', 'null'::jsonb)`,
        })
        .from(operation)
        .where(projectGenerationWhere(projectID))
        .orderBy(desc(operation.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
  };
  return controller;
}
