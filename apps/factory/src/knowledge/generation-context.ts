import {
  and,
  asc,
  desc,
  eq,
  exists,
  sql as expression,
  isNotNull,
  lte,
  ne,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { factorySigningSecret } from "#auth/signing-secret";
import { drizzleTransaction } from "#db/client";
import { knowledgePage, knowledgeRevision, operation } from "#db/schema";
import {
  createModelConnections,
  type createModelSettingsController,
  createOpenBaoModelSecrets,
} from "../models/api";
import { installationPlanningConnection } from "../models/resolver";
import { type KnowledgeDatabase, projectGenerationWhere } from "./repository-source";

export type ModelSettingsController = ReturnType<typeof createModelSettingsController>;

export function attemptWhere(
  generationID: string,
  attemptId: string,
  ...extra: Array<SQL | undefined>
) {
  return and(
    eq(operation.id, generationID),
    eq(operation.kind, "knowledge.generation"),
    eq(expression<string>`${operation.payload}->>'attemptId'`, attemptId),
    ...extra,
  );
}

export async function completedPublications(
  database: KnowledgeDatabase,
  generationID: string,
  attemptID: string,
  projectID: string,
  commitSha: string,
) {
  const db = database.db;
  const candidate = alias(operation, "candidate");
  const previous = db
    .select({
      state: candidate.state,
      pageCount: expression<number | null>`(${candidate.payload}->>'pageCount')::int`.as(
        "page_count",
      ),
      sourceCommitSha: expression<string>`${candidate.payload}->>'sourceCommitSha'`.as(
        "source_commit_sha",
      ),
    })
    .from(candidate)
    .where(
      and(
        eq(candidate.kind, "knowledge.generation"),
        eq(candidate.scopeType, "project"),
        eq(candidate.scopeId, operation.scopeId),
        ne(candidate.id, operation.id),
        lte(candidate.createdAt, operation.createdAt),
      ),
    )
    .orderBy(desc(candidate.createdAt), desc(candidate.id))
    .limit(1)
    .as("previous");
  const [progress] = await db
    .select({
      pageCount: expression<number>`coalesce((${operation.payload}->>'pageCount')::int,0)`,
      previousState: previous.state,
      previousCount: previous.pageCount,
      previousCommit: previous.sourceCommitSha,
    })
    .from(operation)
    .leftJoinLateral(previous, expression`true`)
    .where(
      attemptWhere(
        generationID,
        attemptID,
        projectGenerationWhere(projectID),
        eq(operation.state, "running"),
        eq(expression<string>`${operation.payload}->>'sourceCommitSha'`, commitSha),
      ),
    );
  if (!progress) throw new Error("Wiki execution no longer owns analysis");
  if (
    !progress.pageCount &&
    !(
      progress.previousState === "failed" &&
      progress.previousCommit === commitSha &&
      Number(progress.previousCount) > 0
    )
  )
    return [];
  const checked = await db
    .select({ id: knowledgePage.id })
    .from(knowledgePage)
    .where(
      and(
        eq(knowledgePage.projectId, projectID),
        eq(knowledgePage.state, "active"),
        eq(knowledgePage.sourceCommitSha, commitSha),
        exists(
          db
            .select({ id: knowledgeRevision.id })
            .from(knowledgeRevision)
            .where(
              and(
                eq(knowledgeRevision.pageId, knowledgePage.id),
                eq(knowledgeRevision.kind, "generated"),
                isNotNull(knowledgeRevision.generationId),
                eq(knowledgeRevision.sourceCommitSha, commitSha),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(knowledgePage.id));
  return checked.map((page) => page.id);
}

export async function resolveGenerationConnection(
  database: KnowledgeDatabase,
  models: ModelSettingsController,
  generationID: string,
  attemptId: string,
  generation: { projectID: string; userID: string; modelId: string | null },
) {
  const modelConnections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    factorySigningSecret(),
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [],
  );
  const settings = await models.getInherited(generation.projectID, generation.userID);
  const modelId = generation.modelId ?? settings.projectEffective.planning.modelId;
  if (!settings.projectEffective.planning.models.includes(modelId))
    throw new Error("Wiki model is no longer approved");
  const reference = await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const [current] = await db
      .select({
        connectionID: expression<string | null>`${operation.payload}->>'modelConnectionId'`,
        version: expression<
          number | null
        >`(${operation.payload}->>'modelConnectionVersion')::bigint::float8`,
      })
      .from(operation)
      .where(attemptWhere(generationID, attemptId))
      .for("update");
    if (!current) throw new Error("Wiki execution changed");
    const pinned =
      current.connectionID && current.version
        ? { connectionID: current.connectionID, version: current.version }
        : await modelConnections.reference("planning", sql);
    await db
      .update(operation)
      .set({
        payload: expression`${operation.payload} || ${JSON.stringify({
          modelId,
          modelConnectionId: pinned?.connectionID ?? null,
          modelConnectionVersion: pinned?.version ?? null,
        })}::jsonb`,
        updatedAt: expression`now()`,
      })
      .where(attemptWhere(generationID, attemptId));
    return pinned;
  });
  const connection = reference
    ? await modelConnections.resolve(reference.connectionID, reference.version)
    : installationPlanningConnection();
  return { modelId, connection };
}
