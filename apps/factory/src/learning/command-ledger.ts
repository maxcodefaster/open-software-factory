import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, ne, type SQL, sql as typedSQL } from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
import { type learningTarget, legacyWikiCallPattern } from "#conversation-domain/learning";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  auditEvent,
  learningCase as caseRecord,
  learningReview,
  learningProposal as proposalRecord,
} from "#db/schema";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { createLearningTargets } from "./targets";

export type LearningDatabase = ReturnType<typeof createDatabase>;
export type LearningTargets = ReturnType<typeof createLearningTargets>;
export type LearningRights = {
  manager: boolean;
  developer: boolean;
  ownUsage: boolean;
};

export async function resolveLearningRights(
  database: LearningDatabase,
  userId: string,
  projectId: string | null,
  personal: boolean,
): Promise<LearningRights> {
  const access = createAccessController(database);
  if (!projectId) {
    await access.requireSystemManager(userId);
    return { manager: true, developer: true, ownUsage: false };
  }
  const manager = await database.client.begin((sql) => projectAuthorityIn(sql, userId, projectId));
  return {
    manager,
    developer: await access.canDevelop(userId, projectId),
    ownUsage: personal || !manager,
  };
}

export function ownerPredicate(column: AnyPgColumn, ownerId: string | null) {
  return ownerId ? eq(column, ownerId) : isNull(column);
}

export function reviewVisibility(
  projectId: string | null,
  ownerId: string | null,
  permitted: LearningRights,
) {
  return and(
    projectId ? eq(learningReview.projectId, projectId) : undefined,
    ownerPredicate(learningReview.ownerId, ownerId),
    permitted.developer ? undefined : eq(learningReview.developerOnly, false),
    permitted.manager
      ? undefined
      : typedSQL`NOT(${learningReview.input} @> '[{"activity":"setup"}]'::jsonb)`,
  );
}

export function caseVisibility(
  projectId: string | null,
  ownerId: string | null,
  permitted: LearningRights,
) {
  return and(
    projectId ? eq(caseRecord.projectId, projectId) : undefined,
    ownerPredicate(caseRecord.ownerId, ownerId),
    permitted.developer ? undefined : eq(caseRecord.developerOnly, false),
    permitted.manager ? undefined : ne(caseRecord.activity, "setup"),
    typedSQL`NOT(${caseRecord.activity}='wiki' AND ${caseRecord.id} ~ ${legacyWikiCallPattern})`,
  );
}

export function policyScopeKey(projectId: string, ownerId: string | null) {
  return `${projectId}:${ownerId ?? "project"}`;
}

export function policyIdempotencyKey(projectId: string, ownerId: string | null) {
  return `learning.policy:${policyScopeKey(projectId, ownerId)}`;
}

export async function advisoryLock(db: ReturnType<typeof drizzleTransaction>, key: string) {
  await db.execute(typedSQL`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function replayLearningCommand(
  sql: DatabaseTransaction,
  id: string,
  actorId: string,
  input: unknown,
) {
  const db = drizzleTransaction(sql);
  await advisoryLock(db, `learning-command:${id}`);
  const [existing] = await db
    .select({
      actorId: auditEvent.actorId,
      payload: auditEvent.payload,
    })
    .from(auditEvent)
    .where(eq(auditEvent.dedupeKey, `learning.command:${id}`));
  if (
    existing &&
    (existing.actorId !== actorId || !isDeepStrictEqual(existing.payload["input"], input))
  )
    throw new CommandError("conflict", "Learning command identity was reused");
  return existing
    ? {
        actorId: existing.actorId,
        input: existing.payload["input"],
        result: existing.payload["result"],
      }
    : undefined;
}

export async function recordLearningCommand(
  db: ReturnType<typeof drizzleTransaction>,
  id: string,
  projectId: string,
  actorId: string,
  input: unknown,
  result: unknown,
) {
  await db.insert(auditEvent).values({
    id,
    kind: "learning.command",
    scopeType: "learning",
    scopeId: projectId,
    dedupeKey: `learning.command:${id}`,
    actorId,
    payload: { input, result },
  });
}

const lockedProposal = alias(proposalRecord, "proposal");

export async function lockProposalWithReview(
  db: ReturnType<typeof drizzleTransaction>,
  where: (proposal: typeof lockedProposal) => SQL | undefined,
) {
  const [row] = await db
    .select({
      proposalId: lockedProposal.id,
      content: lockedProposal.content,
      state: lockedProposal.state,
      application: lockedProposal.application,
      projectId: learningReview.projectId,
      ownerId: learningReview.ownerId,
      developerOnly: learningReview.developerOnly,
      cases: learningReview.input,
      managerOnly: typedSQL<boolean>`${learningReview.input} @> '[{"activity":"setup"}]'::jsonb`,
    })
    .from(lockedProposal)
    .innerJoin(learningReview, eq(learningReview.id, lockedProposal.reviewId))
    .where(where(lockedProposal))
    .for("update", { of: lockedProposal });
  return row;
}

export async function tryAuthorizeTarget(
  database: LearningDatabase,
  targets: LearningTargets,
  target: typeof learningTarget._output,
  userId: string,
  projectId: string,
): Promise<
  | { ok: true; scope: "personal" | "project" | "system"; label: string }
  | { ok: false; reason: string }
> {
  try {
    const result = await database.client.begin((sql) =>
      targets.authorize(sql, target, userId, projectId),
    );
    return { ok: true, scope: result.scope, label: result.label };
  } catch (cause) {
    if (!(cause instanceof CommandError)) throw cause;
    return { ok: false, reason: cause.message };
  }
}
