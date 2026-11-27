import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql as typedSQL,
} from "drizzle-orm";
import {
  agentTurn,
  candidateReview,
  changeAgentTurnIntent,
  changeCommitOperation,
  conversationEntry,
  operation as operationRecord,
  skillLibrary,
  skillRevision,
  technicalDesignRevision,
} from "#db/schema";
import { nativeToolEvidenceMaximumBytes } from "./native-tool-evidence";
import { collectTurnBuildEvidence } from "./sources-turn-build";
import {
  type EvidenceCollector,
  type LearningDrizzle,
  type SnapshotMetadata,
  type SourceOperation,
  uuidPattern,
} from "./sources-types";

export async function collectTurnEvidence(
  db: LearningDrizzle,
  operation: SourceOperation,
  turnId: string,
  collector: EvidenceCollector,
): Promise<SnapshotMetadata | null> {
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
        eq(agentTurn.id, turnId),
        eq(agentTurn.projectId, operation.projectId),
        inArray(agentTurn.state, ["completed", "failed", "stopped", "uncertain"]),
      ),
    );
  if (!turn) return null;

  let ownerId: string | null = turn.ticketId ? null : turn.createdBy;
  const activity =
    turn.authority["mode"] === "investigate" && turn.input["kind"] === "project-message"
      ? "research"
      : String(turn.input["kind"] ?? operation.purpose);
  let developerOnly = turn.authority["mode"] === "build";
  let nativeTurnID: string | null = null;
  if (developerOnly && turn.state === "completed" && turn.nativeCoding) {
    nativeTurnID = turn.id;
    collector.reserveNativeEvidence(nativeToolEvidenceMaximumBytes);
  }

  // Do not copy admission tokens, credential references or attachment bytes.
  collector.add(`turn:${turn.id}:task`, "task", {
    kind: turn.input["kind"],
    text: turn.input["text"],
    answer: turn.input["answer"],
    intent: turn.input["intent"],
    sourceCommit: turn.input["sourceCommit"],
  });
  collector.add(
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
  collector.add(`turn:${turn.id}:summary`, "outcome", turn.summary);

  const artifacts = await db
    .select({
      ordinal: typedSQL<number>`(${operationRecord.payload}->>'ordinal')::int`,
      reference: typedSQL<string>`${operationRecord.payload}->>'reference'`,
      body: typedSQL<string>`${operationRecord.payload}->>'body'`,
      truncated: typedSQL<boolean>`(${operationRecord.payload}->>'truncated')::boolean`,
    })
    .from(operationRecord)
    .where(
      and(
        eq(operationRecord.kind, "learning.source_artifact"),
        eq(operationRecord.scopeType, "agent_turn"),
        eq(operationRecord.scopeId, turn.id),
      ),
    )
    .orderBy(asc(typedSQL<number>`(${operationRecord.payload}->>'ordinal')::int`));

  const questionId = turn.input["questionEntryId"];
  if (turn.conversationId && typeof questionId === "string" && uuidPattern.test(questionId)) {
    const [question] = await db
      .select({ body: conversationEntry.body, payload: conversationEntry.payload })
      .from(conversationEntry)
      .where(
        and(
          eq(conversationEntry.id, questionId),
          eq(conversationEntry.conversationId, turn.conversationId),
        ),
      );
    if (question) collector.add(`question:${questionId}`, "task", question, 3_000);
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
      collector.add(
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
    collector.add(`technical-design:${design.id}`, "artifact", design, 6_000);
  }

  if (turn.authority["mode"] === "build") {
    const ready = await collectTurnBuildEvidence(db, operation, turn.id, turn.authority, collector);
    if (!ready) return null;
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
  for (const review of reviews)
    collector.add(`candidate-review:${review.id}`, "artifact", review, 6_000);

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
    .from(operationRecord)
    .innerJoin(
      skillRevision,
      eq(
        typedSQL<string>`${skillRevision.id}::text`,
        typedSQL<string>`${operationRecord.payload}->>'revisionId'`,
      ),
    )
    .leftJoin(skillLibrary, eq(skillLibrary.id, skillRevision.libraryId))
    .where(
      and(
        eq(operationRecord.kind, "coding.turn_skill"),
        eq(operationRecord.scopeType, "agent_turn"),
        eq(operationRecord.scopeId, turn.id),
      ),
    )
    .orderBy(asc(skillRevision.id))
    .limit(6);
  for (const skill of skills) {
    if (skill.scope === "personal" || skill.personalLoaded) ownerId = turn.createdBy;
    collector.add(`skill:${skill.id}`, "configuration", skill, 2_000);
    if (skill.libraryId && skill.content && typeof skill.content === "object") {
      const content = skill.content as Record<string, unknown>;
      for (const field of ["instructions", "description"] as const)
        collector.editable(
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
    collector.add(
      `turn:${turn.id}:source:${artifact.ordinal}`,
      "artifact",
      `${artifact.reference}\n${artifact.body}`,
      2_500,
      artifact.truncated,
    );
  }
  // Native tools are added only after the final scope/authority checks.
  // A summary or missing archive never stands in for an observed tool trace.
  return {
    ownerId,
    developerOnly,
    activity,
    outcome: operation.outcome,
    settledAt: operation.settledAt,
    nativeTurnID,
  };
}
