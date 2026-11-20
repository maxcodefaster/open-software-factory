import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  notExists,
  notInArray,
  notLike,
  or,
  sql as typedSQL,
} from "drizzle-orm";
import {
  type LearningCase,
  type LearningTarget,
  learningCase,
  sampleLearningCase,
} from "../../../../packages/conversation-domain/src/learning";
import { verificationReviewReasons } from "../../../../packages/conversation-domain/src/verification";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  agentTurnSkill,
  candidateReview,
  changeAgentTurnIntent,
  changeCommitOperation,
  conversationEntry,
  knowledgeGeneration,
  knowledgePage,
  knowledgeRevision,
  learningPolicy,
  learningSourceArtifact,
  monitoringHook,
  monitoringIncident,
  monitoringPolicy,
  projectSetupInspection,
  requirementRevision,
  reviewFeedback,
  reviewFeedbackCommand,
  reviewFeedbackMessage,
  runtimeAttempt,
  learningCase as savedCase,
  sessionArchive,
  skillLibrary,
  skillLibraryRevision,
  skillRevision,
  technicalDesignRevision,
  usageOperation,
  verification,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { nativeToolEvidenceMaximumBytes, readNativeToolEvidence } from "./native-tool-evidence";

type Database = ReturnType<typeof createDatabase>;
type Operation = {
  id: string;
  projectId: string;
  userId: string;
  purpose: string;
  outcome: LearningCase["outcome"];
  settledAt: Date;
  cursorAt: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nativeArchiveGraceMS = 5 * 60_000;

export type LearningSourceCursor = { at: string; id: string };
export async function collectLearningCases(
  database: Database,
  cursor: LearningSourceCursor | null = null,
  objects: PrivateObjects = createPrivateObjects(),
) {
  // The journal is an index into retained product evidence, not a transcript lake.
  // Never wake a Sandbox or fetch native logs to perform retrospective review.
  // A Wiki generation makes dozens of model calls but is one piece of work with one
  // retained outcome. Review it once, after it settles. Its calls settle first, so a
  // cursor over them would pass the generation before it could be reviewed.
  const db = drizzleTransaction(database.client);
  const wikiID = typedSQL<string>`'wiki:'||${knowledgeGeneration.id}::text`;
  const due = db
    .select({
      id: usageOperation.id,
      projectId: usageOperation.projectId,
      userId: usageOperation.userId,
      purpose: usageOperation.purpose,
      outcome: usageOperation.outcome,
      settledAt: usageOperation.settledAt,
      cursorAt: typedSQL<string>`${usageOperation.settledAt}::text`.as("cursorAt"),
      wiki: typedSQL<boolean>`false`.as("wiki"),
    })
    .from(usageOperation)
    .where(
      and(
        isNotNull(usageOperation.settledAt),
        isNotNull(usageOperation.projectId),
        isNotNull(usageOperation.userId),
        notInArray(usageOperation.purpose, ["probe", "learning"]),
        notLike(usageOperation.id, "wiki:%"),
        notExists(
          db
            .select({ key: learningPolicy.scopeKey })
            .from(learningPolicy)
            .where(
              and(
                eq(learningPolicy.projectId, usageOperation.projectId),
                isNull(learningPolicy.ownerId),
                eq(learningPolicy.enabled, false),
              ),
            ),
        ),
        cursor
          ? typedSQL`(${usageOperation.settledAt},${usageOperation.id}) >
      (${cursor.at}::timestamptz,${cursor.id})`
          : undefined,
        notExists(
          db
            .select({ id: savedCase.id })
            .from(savedCase)
            .where(eq(savedCase.id, usageOperation.id)),
        ),
      ),
    )
    .orderBy(asc(usageOperation.settledAt), asc(usageOperation.id))
    .limit(100)
    .unionAll(
      db
        .select({
          id: wikiID.as("id"),
          projectId: knowledgeGeneration.projectId,
          userId: knowledgeGeneration.createdBy,
          purpose: typedSQL<"wiki">`'wiki'`.as("purpose"),
          outcome: typedSQL<Operation["outcome"]>`'completed'`.as("outcome"),
          settledAt: knowledgeGeneration.completedAt,
          cursorAt: typedSQL<string>`${knowledgeGeneration.completedAt}::text`.as("cursorAt"),
          wiki: typedSQL<boolean>`true`.as("wiki"),
        })
        .from(knowledgeGeneration)
        .where(
          and(
            gt(knowledgeGeneration.completedAt, typedSQL`now()-interval '3 days'`),
            notExists(
              db
                .select({ key: learningPolicy.scopeKey })
                .from(learningPolicy)
                .where(
                  and(
                    eq(learningPolicy.projectId, knowledgeGeneration.projectId),
                    isNull(learningPolicy.ownerId),
                    eq(learningPolicy.enabled, false),
                  ),
                ),
            ),
            notExists(
              db
                .select({ id: savedCase.id })
                .from(savedCase)
                .where(or(eq(savedCase.id, wikiID), like(savedCase.id, typedSQL`${wikiID}||':%'`))),
            ),
            exists(
              db
                .select({ id: usageOperation.id })
                .from(usageOperation)
                .where(
                  and(
                    eq(usageOperation.purpose, "wiki"),
                    eq(usageOperation.projectId, knowledgeGeneration.projectId),
                    isNotNull(usageOperation.settledAt),
                    like(usageOperation.id, typedSQL`${wikiID}||':%'`),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(knowledgeGeneration.completedAt), asc(knowledgeGeneration.id))
        .limit(20),
    )
    .as("due");
  const operations = await db.select().from(due).orderBy(asc(due.settledAt), asc(due.id));
  for (const operation of operations) {
    if (!operation.projectId || !operation.userId || !operation.settledAt || !operation.outcome)
      continue;
    const reviewerId = operation.userId;
    const source = await learningSnapshot(database, {
      ...operation,
      projectId: operation.projectId,
      userId: operation.userId,
      settledAt: operation.settledAt,
      outcome: operation.outcome,
    });
    if (!source) continue; // An indexed operation can precede product settlement.
    const { snapshot, nativeTurnID } = source;
    const selected =
      sampleLearningCase(snapshot.id, snapshot.outcome, snapshot.reviewReasons) &&
      ((snapshot.reviewReasons?.length ?? 0) > 0 ||
        snapshot.evidence.some(
          (item) => item.kind === "outcome" || item.kind === "artifact" || item.kind === "feedback",
        ));
    if (!selected) {
      snapshot.evidence = [];
      snapshot.targets = [];
    }
    async function authorizedIn(sql: DatabaseTransaction) {
      if (!(await learningEnabledIn(sql, snapshot.projectId, snapshot.ownerId))) return false;
      try {
        await learningAuthorityIn(sql, reviewerId, {
          ...snapshot,
          managerOnly: snapshot.activity === "setup",
        });
      } catch (cause) {
        if (cause instanceof CommandError) return false;
        throw cause;
      }
      return true;
    }
    let nativeEvidence: LearningCase["evidence"][number] | undefined;
    if (selected && nativeTurnID) {
      const admitted = await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        if (!(await authorizedIn(sql))) return null;
        const [existing] = await db
          .select({ id: savedCase.id })
          .from(savedCase)
          .where(eq(savedCase.id, snapshot.id));
        if (existing) return null;
        const [saved] = await db
          .select({
            turnID: sessionArchive.turnId,
            runtimeAttemptID: sessionArchive.runtimeAttemptId,
            sessionID: sessionArchive.sessionId,
            promptID: sessionArchive.promptId,
            throughMessageID: sessionArchive.throughMessageId,
            source: typedSQL<Record<string, unknown>>`${sessionArchive.sourceRefs}`,
            key: sessionArchive.manifestKey,
            sha256: sessionArchive.manifestSha256,
            producerVersion: sessionArchive.producerVersion,
          })
          .from(sessionArchive)
          .innerJoin(
            agentTurn,
            and(
              eq(agentTurn.id, sessionArchive.turnId),
              eq(agentTurn.state, "completed"),
              typedSQL`${agentTurn.authority}->>'mode'='build'`,
            ),
          )
          .innerJoin(
            changeAgentTurnIntent,
            and(
              eq(changeAgentTurnIntent.turnId, agentTurn.id),
              eq(changeAgentTurnIntent.runtimeAttemptId, sessionArchive.runtimeAttemptId),
              eq(changeAgentTurnIntent.sessionId, sessionArchive.sessionId),
              eq(changeAgentTurnIntent.promptId, sessionArchive.promptId),
              eq(changeAgentTurnIntent.changeId, agentTurn.changeId),
            ),
          )
          .innerJoin(
            runtimeAttempt,
            and(
              eq(runtimeAttempt.id, sessionArchive.runtimeAttemptId),
              eq(runtimeAttempt.changeId, agentTurn.changeId),
              eq(runtimeAttempt.projectId, agentTurn.projectId),
            ),
          )
          .where(
            and(
              eq(agentTurn.id, nativeTurnID),
              eq(agentTurn.projectId, snapshot.projectId),
              eq(sessionArchive.state, "saved"),
            ),
          );
        // Usage settles before the asynchronous archive and even before Git
        // submission. The existing Verification wait helps once a SHA exists,
        // but cannot cover that earlier race. Do not freeze an empty trace at
        // first sight or wait forever for a save that may never succeed.
        const age = Date.now() - Date.parse(snapshot.settledAt);
        if (!saved && age >= 0 && age < nativeArchiveGraceMS) return null;
        return { saved };
      });
      if (!admitted) continue;
      // Private object I/O must not hold policy/account locks or a SQL connection.
      const saved = admitted.saved;
      // The saved-state schema check requires these nullable columns to be present.
      nativeEvidence = await readNativeToolEvidence(
        nativeTurnID,
        saved &&
          saved.throughMessageID !== null &&
          saved.key !== null &&
          saved.sha256 !== null &&
          saved.producerVersion !== null
          ? {
              ...saved,
              throughMessageID: saved.throughMessageID,
              key: saved.key,
              sha256: saved.sha256,
              producerVersion: saved.producerVersion,
            }
          : undefined,
        objects,
      );
    }
    await database.client.begin(async (sql) => {
      if (!(await authorizedIn(sql))) return;
      if (nativeEvidence) snapshot.evidence.push(nativeEvidence);
      await drizzleTransaction(sql)
        .insert(savedCase)
        .values({
          id: snapshot.id,
          projectId: snapshot.projectId,
          ownerId: snapshot.ownerId,
          reviewerId,
          developerOnly: snapshot.developerOnly,
          activity: snapshot.activity,
          outcome: snapshot.outcome,
          settledAt: new Date(snapshot.settledAt),
          snapshot,
          selected,
        })
        .onConflictDoNothing();
    });
  }
  const last = operations.findLast((operation) => !operation.wiki);
  // Keep PostgreSQL's microseconds. A JS Date rounds them away and can repeat
  // the same full page when several operations share one settlement instant.
  // Full pages advance past deferred work; a completed pass starts again so
  // later archive/Verification settlement is observed without a worker restart.
  return last && operations.filter((operation) => !operation.wiki).length === 100
    ? { at: last.cursorAt, id: last.id }
    : null;
}

async function learningSnapshot(database: Database, operation: Operation) {
  const db = drizzleTransaction(database.client);
  const evidence: LearningCase["evidence"] = [];
  const targets: LearningCase["targets"] = [];
  const reviewReasons: string[] = [];
  let remaining = 20_000;
  let evidenceLimit = 24;
  let nativeTurnID: string | null = null;
  // Gather before allocating: SQL/source order must not spend the budget of
  // later approved scope, observed outcomes or editable guidance.
  function add(
    id: string,
    kind: LearningCase["evidence"][number]["kind"],
    value: unknown,
    limit = 4_000,
  ) {
    if (value === null || value === undefined) return;
    const body = typeof value === "string" ? value : JSON.stringify(value);
    if (!body?.trim()) return;
    const excerpt = body.slice(0, limit);
    if (!excerpt.trim()) return;
    evidence.push({ id, kind, body: excerpt, truncated: body.length > excerpt.length });
  }
  function editable(target: LearningTarget, evidenceId: string, value: unknown) {
    if (typeof value !== "string" || !value.trim() || targets.length >= 8) return;
    const excerpt = value.slice(0, 4_000);
    if (!excerpt.trim()) return;
    targets.push({ target, evidenceId, text: excerpt, truncated: excerpt.length < value.length });
  }
  let ownerId: string | null = operation.userId;
  let developerOnly = false;
  let activity = operation.purpose;
  let outcome = operation.outcome;
  let settledAt = operation.settledAt;
  const sourceID = operation.id.split(":")[1] ?? "";
  if (operation.id.startsWith("turn:") && uuid.test(sourceID)) {
    const [turn] = await db
      .select({
        id: agentTurn.id,
        input: typedSQL<Record<string, unknown>>`${agentTurn.input}`,
        authority: typedSQL<Record<string, unknown>>`${agentTurn.authority}`,
        ticketId: agentTurn.ticketId,
        conversationId: agentTurn.conversationId,
        createdBy: agentTurn.createdBy,
        summary: agentTurn.outcomeSummary,
        state: agentTurn.state,
        createdAt: agentTurn.createdAt,
        updatedAt: agentTurn.updatedAt,
        nativeCoding: exists(
          db
            .select({ id: changeAgentTurnIntent.turnId })
            .from(changeAgentTurnIntent)
            .where(eq(changeAgentTurnIntent.turnId, agentTurn.id)),
        ),
      })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.id, sourceID),
          eq(agentTurn.projectId, operation.projectId),
          inArray(agentTurn.state, ["completed", "failed", "stopped", "uncertain"]),
        ),
      );
    if (!turn) return null;
    ownerId = turn.ticketId ? null : turn.createdBy;
    activity =
      turn.authority["mode"] === "investigate" && turn.input["kind"] === "project-message"
        ? "research"
        : String(turn.input["kind"] ?? operation.purpose);
    developerOnly = turn.authority["mode"] === "build";
    if (developerOnly && turn.state === "completed" && turn.nativeCoding) {
      nativeTurnID = turn.id;
      // Leave one complete, bounded JSON item for the gated archive projection.
      remaining -= nativeToolEvidenceMaximumBytes;
      evidenceLimit--;
    }
    // Do not copy admission tokens, credential references or attachment bytes.
    add(`turn:${turn.id}:task`, "task", {
      kind: turn.input["kind"],
      text: turn.input["text"],
      answer: turn.input["answer"],
      intent: turn.input["intent"],
      sourceCommit: turn.input["sourceCommit"],
    });
    add(
      `turn:${turn.id}:configuration`,
      "configuration",
      {
        modelId: turn.authority["modelId"],
        mode: turn.authority["mode"],
        requirementRevisionId: turn.authority["requirementRevisionId"],
        skillRevisionIds: turn.authority["skillRevisionIds"],
      },
      1_000,
    );
    add(`turn:${turn.id}:summary`, "outcome", turn.summary);
    const artifacts = await db
      .select({
        ordinal: learningSourceArtifact.ordinal,
        reference: learningSourceArtifact.reference,
        body: learningSourceArtifact.body,
        truncated: learningSourceArtifact.truncated,
      })
      .from(learningSourceArtifact)
      .where(eq(learningSourceArtifact.turnId, turn.id))
      .orderBy(asc(learningSourceArtifact.ordinal));
    const questionId = turn.input["questionEntryId"];
    if (turn.conversationId && typeof questionId === "string" && uuid.test(questionId)) {
      const [question] = await db
        .select({ body: conversationEntry.body, payload: conversationEntry.payload })
        .from(conversationEntry)
        .where(
          and(
            eq(conversationEntry.id, questionId),
            eq(conversationEntry.conversationId, turn.conversationId),
          ),
        );
      if (question) add(`question:${questionId}`, "task", question, 3_000);
    }
    if (turn.conversationId) {
      const entries = await db
        .select({
          id: conversationEntry.id,
          body: conversationEntry.body,
          payload: conversationEntry.payload,
          citations: conversationEntry.citations,
        })
        .from(conversationEntry)
        .where(
          and(
            eq(conversationEntry.conversationId, turn.conversationId),
            inArray(conversationEntry.actor, ["project-agent", "change-agent"]),
            gte(conversationEntry.createdAt, turn.createdAt),
            lte(conversationEntry.createdAt, turn.updatedAt),
            eq(
              typedSQL<string>`coalesce(${conversationEntry.payload}->>'contextId','')`,
              String(turn.input["contextId"] ?? ""),
            ),
          ),
        )
        .orderBy(asc(conversationEntry.ordinal))
        .limit(3);
      for (const entry of entries) {
        if (
          entry.payload["visibility"] === "developer" ||
          JSON.stringify(entry.citations).includes('"code"')
        )
          developerOnly = true;
        add(
          `entry:${entry.id}`,
          "outcome",
          {
            body: entry.body,
            citations: entry.citations,
            requirement: entry.payload["requirement"],
            design: entry.payload["technicalDesignRevisionId"],
          },
          2_000,
        );
      }
    }
    const designs = await db
      .select({
        id: technicalDesignRevision.id,
        content: technicalDesignRevision.canonicalContent,
        commit: technicalDesignRevision.sourceCommit,
        citations: technicalDesignRevision.citations,
      })
      .from(technicalDesignRevision)
      .where(eq(technicalDesignRevision.turnId, turn.id))
      .orderBy(asc(technicalDesignRevision.ordinal))
      .limit(1);
    for (const design of designs) {
      developerOnly = true;
      add(`technical-design:${design.id}`, "artifact", design, 6_000);
    }
    if (turn.authority["mode"] === "build") {
      const [commit] = await db
        .select({
          id: changeCommitOperation.id,
          sha: changeCommitOperation.commitSha,
          parent: changeCommitOperation.expectedParentSha,
          state: changeCommitOperation.state,
          changeId: changeCommitOperation.changeId,
        })
        .from(changeCommitOperation)
        .where(eq(changeCommitOperation.id, turn.id));
      if (commit?.sha) {
        const checks = await db
          .select({
            id: verification.id,
            state: verification.state,
            summary: verification.summary,
            diagnosis: verification.diagnosis,
            completedAt: verification.completedAt,
          })
          .from(verification)
          .where(
            and(eq(verification.changeId, commit.changeId), eq(verification.commitSha, commit.sha)),
          )
          .orderBy(desc(verification.createdAt))
          .limit(1);
        if (
          operation.outcome === "completed" &&
          !checks[0]?.completedAt &&
          Date.now() - new Date(operation.settledAt).getTime() < 24 * 60 * 60_000
        )
          return null;
        add(`commit:${commit.id}`, "artifact", commit, 1_000);
        for (const check of checks)
          add(`verification:${check.id}`, "artifact", { commit: commit.sha, ...check }, 12_000);
        const diagnosis = checks[0]?.diagnosis;
        reviewReasons.push(
          ...(checks[0] && checks[0].state !== "succeeded"
            ? ["verification-not-successful"]
            : verificationReviewReasons(
                diagnosis && typeof diagnosis === "object"
                  ? (diagnosis as Record<string, unknown>)["receipt"]
                  : null,
                commit.sha,
              )),
        );
      } else {
        reviewReasons.push("missing-verification-evidence");
      }
      const requirementId = turn.authority["requirementRevisionId"];
      if (typeof requirementId === "string" && uuid.test(requirementId)) {
        const [requirement] = await db
          .select({ content: requirementRevision.canonicalContent })
          .from(requirementRevision)
          .where(eq(requirementRevision.id, requirementId));
        if (requirement) add(`requirements:${requirementId}`, "task", requirement.content, 3_000);
      }
      const feedback = await db
        .select({
          id: reviewFeedbackMessage.id,
          body: reviewFeedbackMessage.body,
          commit: reviewFeedback.commitSha,
        })
        .from(reviewFeedbackCommand)
        .innerJoin(reviewFeedback, eq(reviewFeedback.id, reviewFeedbackCommand.feedbackId))
        .innerJoin(reviewFeedbackMessage, eq(reviewFeedbackMessage.feedbackId, reviewFeedback.id))
        .where(eq(reviewFeedbackCommand.turnId, turn.id))
        .orderBy(asc(reviewFeedbackMessage.createdAt))
        .limit(3);
      for (const item of feedback) add(`feedback:${item.id}`, "feedback", item, 2_000);
    }
    const reviews = await db
      .select({
        id: candidateReview.id,
        result: candidateReview.result,
        evidence: candidateReview.evidence,
        commit: candidateReview.commitSha,
        base: candidateReview.baseSha,
        state: candidateReview.state,
      })
      .from(candidateReview)
      .where(
        and(
          or(
            eq(candidateReview.turnId, turn.id),
            exists(
              db
                .select({ id: changeCommitOperation.id })
                .from(changeCommitOperation)
                .where(
                  and(
                    eq(changeCommitOperation.id, turn.id),
                    eq(changeCommitOperation.changeId, candidateReview.changeId),
                    eq(changeCommitOperation.commitSha, candidateReview.commitSha),
                  ),
                ),
            ),
          ),
          isNotNull(candidateReview.completedAt),
        ),
      )
      .orderBy(asc(candidateReview.ordinal))
      .limit(2);
    for (const review of reviews) add(`candidate-review:${review.id}`, "artifact", review, 6_000);
    const skills = await db
      .select({
        id: skillRevision.id,
        version: skillRevision.revision,
        digest: skillRevision.contentDigest,
        scope: skillLibrary.scope,
        libraryId: skillLibrary.id,
        personalLoaded: typedSQL<boolean>`bool_or(${skillLibrary.scope}='personal') OVER ()`,
        content: typedSQL<Record<string, unknown>>`jsonb_build_object(
        'key',${skillRevision.content}->'key','name',${skillRevision.content}->'name',
        'description',${skillRevision.content}->'description','roles',${skillRevision.content}->'roles',
        'instructions',${skillRevision.content}->'instructions',
        'omitted','Bundled references and executable resources are not copied into this review.')`,
      })
      .from(agentTurnSkill)
      .innerJoin(skillRevision, eq(skillRevision.id, agentTurnSkill.revisionId))
      .leftJoin(skillLibraryRevision, eq(skillLibraryRevision.revisionId, skillRevision.id))
      .leftJoin(skillLibrary, eq(skillLibrary.id, skillLibraryRevision.libraryId))
      .where(eq(agentTurnSkill.turnId, turn.id))
      .orderBy(asc(skillRevision.id))
      .limit(6);
    for (const skill of skills) {
      if (skill.scope === "personal" || skill.personalLoaded) ownerId = turn.createdBy;
      add(`skill:${skill.id}`, "configuration", skill, 2_000);
      if (skill.libraryId && skill.content && typeof skill.content === "object") {
        const content = skill.content as Record<string, unknown>;
        for (const field of ["instructions", "description"] as const)
          editable(
            {
              kind: "skill",
              id: skill.libraryId,
              revisionId: skill.id,
              version: skill.version,
              field,
            },
            `skill:${skill.id}`,
            content[field],
          );
      }
    }
    // Raw source excerpts are supplementary, not a reason to drop the task,
    // exact Verification or loaded guidance when the item ceiling is reached.
    for (const artifact of artifacts) {
      if (artifact.reference.startsWith("code:")) developerOnly = true;
      const id = `turn:${turn.id}:source:${artifact.ordinal}`;
      add(id, "artifact", `${artifact.reference}\n${artifact.body}`, 2_500);
      const saved = evidence.find((item) => item.id === id);
      if (saved) saved.truncated ||= artifact.truncated;
    }
    // Native tools are added only after the final scope/authority checks.
    // A summary or missing archive never stands in for an observed tool trace.
  } else if (operation.id.startsWith("monitoring:") && uuid.test(sourceID)) {
    const [incident] = await db
      .select({
        state: monitoringIncident.state,
        title: monitoringIncident.title,
        instructions: monitoringPolicy.instructions,
        payloadDigest: monitoringIncident.payloadDigest,
        diagnosis: monitoringIncident.diagnosis,
        reason: monitoringIncident.reason,
        assignment: typedSQL<Record<string, unknown>>`jsonb_build_object(
        'revisionIds',${monitoringIncident.skillAssignment}->'revisionIds',
        'requiredRevisionIds',${monitoringIncident.skillAssignment}->'requiredRevisionIds',
        'codeAccess',${monitoringIncident.skillAssignment}->'codeAccess')`,
        policyId: monitoringIncident.policyId,
        hookId: monitoringHook.id,
        version: monitoringHook.version,
        current: eq(monitoringHook.policyId, monitoringPolicy.id),
      })
      .from(monitoringIncident)
      .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, monitoringIncident.policyId))
      .innerJoin(monitoringHook, eq(monitoringHook.id, monitoringPolicy.hookId))
      .where(
        and(
          eq(monitoringIncident.id, sourceID),
          eq(monitoringIncident.projectId, operation.projectId),
          isNotNull(monitoringIncident.settledAt),
        ),
      );
    if (!incident) return null;
    ownerId = null;
    const assignment = incident.assignment as Record<string, unknown> | null;
    const diagnosis = incident.diagnosis as Record<string, unknown> | null;
    developerOnly =
      assignment?.["codeAccess"] === true ||
      (Array.isArray(diagnosis?.["code"]) && diagnosis["code"].length > 0);
    activity = "input";
    // Raw webhook context is not a shared UI projection and may contain
    // credentials. Review the saved task and published outcome, not that body.
    add(`input:${sourceID}:task`, "task", {
      title: incident.title,
      instructions: incident.instructions,
    });
    add(
      `input:${sourceID}:outcome`,
      "outcome",
      { state: incident.state, diagnosis: incident.diagnosis, reason: incident.reason },
      8_000,
    );
    add(`input:${sourceID}:configuration`, "configuration", {
      policyId: incident.policyId,
      payloadDigest: incident.payloadDigest,
      revisionIds: assignment?.["revisionIds"],
      requiredRevisionIds: assignment?.["requiredRevisionIds"],
      codeAccess: assignment?.["codeAccess"],
      omitted: "Raw webhook context and private admission context are not shared work evidence.",
    });
    if (incident.current)
      editable(
        {
          kind: "input",
          id: incident.hookId,
          revisionId: incident.policyId,
          version: incident.version,
          field: "instructions",
        },
        `input:${sourceID}:task`,
        incident.instructions,
      );
  } else if (operation.id.startsWith("wiki:") && uuid.test(sourceID)) {
    const [generation] = await db
      .select({
        state: knowledgeGeneration.state,
        commit: knowledgeGeneration.sourceCommitSha,
        failure: knowledgeGeneration.failure,
        pages: knowledgeGeneration.pageCount,
        conflicts: knowledgeGeneration.conflictCount,
        completedAt: knowledgeGeneration.completedAt,
      })
      .from(knowledgeGeneration)
      .where(
        and(
          eq(knowledgeGeneration.id, sourceID),
          eq(knowledgeGeneration.projectId, operation.projectId),
          isNotNull(knowledgeGeneration.completedAt),
        ),
      );
    if (!generation?.completedAt) return null;
    // One model call's status says nothing about the generation this case reviews.
    outcome = generation.state === "succeeded" ? "completed" : "failed";
    const { completedAt, ...retained } = generation;
    settledAt = completedAt;
    ownerId = null;
    developerOnly = true;
    add(`wiki:${sourceID}:outcome`, "outcome", retained);
    const revisions = await db
      .select({
        id: knowledgeRevision.id,
        title: knowledgeRevision.title,
        body: knowledgeRevision.body,
        commit: knowledgeRevision.sourceCommitSha,
        pageId: knowledgePage.id,
        version: knowledgePage.version,
      })
      .from(knowledgeRevision)
      .leftJoin(
        knowledgePage,
        and(
          eq(knowledgePage.id, knowledgeRevision.pageId),
          eq(knowledgePage.currentRevisionId, knowledgeRevision.id),
          eq(knowledgePage.state, "active"),
        ),
      )
      .where(eq(knowledgeRevision.generationId, sourceID))
      .orderBy(asc(knowledgeRevision.id))
      .limit(3);
    for (const revision of revisions) {
      add(`knowledge:${revision.id}`, "artifact", revision, 5_000);
      if (revision.pageId && revision.version)
        editable(
          {
            kind: "knowledge",
            id: revision.pageId,
            revisionId: revision.id,
            version: revision.version,
            field: "body",
          },
          `knowledge:${revision.id}`,
          revision.body,
        );
    }
  } else if (operation.id.startsWith("setup:") && uuid.test(sourceID)) {
    const [inspection] = await db
      .select({
        state: projectSetupInspection.state,
        source: projectSetupInspection.sourceCommit,
        output: projectSetupInspection.output,
        failure: projectSetupInspection.failure,
      })
      .from(projectSetupInspection)
      .where(
        and(
          eq(projectSetupInspection.id, sourceID),
          eq(projectSetupInspection.projectId, operation.projectId),
          notInArray(projectSetupInspection.state, ["inspecting", "confirming"]),
        ),
      );
    if (!inspection) return null;
    // Setup drafts/inspection answers are not a shared Project conversation.
    developerOnly = false;
    add(`setup:${sourceID}:outcome`, "outcome", inspection, 8_000);
  } else {
    // Unknown activity still counts towards coverage but cannot supply a claim.
    // In particular, a human user ID never makes an AI output human feedback.
    add(
      `${operation.id}:missing`,
      "configuration",
      "No supported retained work-evidence adapter is available.",
    );
  }
  evidence.splice(evidenceLimit);
  const caseTargets = targets.filter((target) =>
    evidence.some((item) => item.id === target.evidenceId),
  );
  remaining -= caseTargets.length * 256;
  let passages = evidence.length + caseTargets.length;
  let unallocatedBytes =
    evidence.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0) +
    caseTargets.reduce((sum, target) => sum + Buffer.byteLength(target.text), 0);
  function allocate(value: string) {
    const bytes = Buffer.byteLength(value);
    const budget = unallocatedBytes <= remaining ? bytes : Math.floor(remaining / passages);
    unallocatedBytes -= bytes;
    passages--;
    let excerpt = value.slice(0, budget);
    while (Buffer.byteLength(excerpt) > budget)
      excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.75));
    remaining -= Buffer.byteLength(excerpt);
    return excerpt;
  }
  for (const item of evidence) {
    const excerpt = allocate(item.body);
    item.truncated ||= excerpt.length < item.body.length;
    item.body = excerpt;
  }
  for (const target of caseTargets) {
    const excerpt = allocate(target.text);
    target.truncated ||= excerpt.length < target.text.length;
    target.text = excerpt;
  }
  const retainedEvidence = evidence.filter((item) => item.body.trim());
  const snapshot = learningCase.parse({
    id: operation.id,
    projectId: operation.projectId,
    ownerId,
    developerOnly,
    activity,
    outcome,
    settledAt: new Date(settledAt).toISOString(),
    evidence: retainedEvidence,
    targets: caseTargets.filter(
      (target) =>
        target.text.trim() && retainedEvidence.some((item) => item.id === target.evidenceId),
    ),
    ...(reviewReasons.length ? { reviewReasons } : {}),
  });
  return { snapshot, nativeTurnID };
}
