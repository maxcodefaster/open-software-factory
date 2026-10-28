import type { createDatabase } from "../../../../packages/db/src/client";
import {
  learningCase,
  sampleLearningCase,
  type LearningCase,
  type LearningTarget,
} from "../../../../packages/conversation-domain/src/learning";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { CommandError } from "../command-error";
import { verificationReviewReasons } from "../../../../packages/conversation-domain/src/verification";

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

export type LearningSourceCursor = { at: string; id: string };
export async function collectLearningCases(
  database: Database,
  cursor: LearningSourceCursor | null = null,
) {
  // The journal is an index into retained product evidence, not a transcript lake.
  // Never wake a Sandbox or fetch native logs to perform retrospective review.
  const operations = await database.client<Operation[]>`
    SELECT operation.id,operation.project_id AS "projectId",operation.user_id AS "userId",
      operation.purpose,operation.outcome,operation.settled_at AS "settledAt",operation.settled_at::text AS "cursorAt"
    FROM factory.usage_operation operation
    WHERE operation.settled_at IS NOT NULL AND operation.project_id IS NOT NULL
      AND operation.user_id IS NOT NULL AND operation.purpose NOT IN ('probe','learning')
      AND NOT EXISTS(SELECT 1 FROM factory.learning_policy policy
        WHERE policy.project_id=operation.project_id AND policy.owner_id IS NULL AND NOT policy.enabled)
      AND (${cursor?.at ?? null}::timestamptz IS NULL OR (operation.settled_at,operation.id) >
        (${cursor?.at ?? null}::timestamptz,${cursor?.id ?? ""}))
      AND NOT EXISTS(SELECT 1 FROM factory.learning_case saved WHERE saved.id=operation.id)
    ORDER BY operation.settled_at,operation.id LIMIT 100`;
  for (const operation of operations) {
    const snapshot = await learningSnapshot(database, operation);
    if (!snapshot) continue; // An indexed operation can precede product settlement.
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
    await database.client.begin(async (sql) => {
      if (!(await learningEnabledIn(sql, snapshot.projectId, snapshot.ownerId))) return;
      try {
        await learningAuthorityIn(sql, operation.userId, {
          ...snapshot,
          managerOnly: snapshot.activity === "setup",
        });
      } catch (cause) {
        if (cause instanceof CommandError) return;
        throw cause;
      }
      await sql`
      INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected)
      VALUES(${snapshot.id},${snapshot.projectId},${snapshot.ownerId},${operation.userId},
        ${snapshot.developerOnly},${snapshot.activity},${snapshot.outcome},${snapshot.settledAt},
        ${JSON.stringify(snapshot)}::jsonb,${selected})
      ON CONFLICT DO NOTHING`;
    });
  }
  const last = operations.at(-1);
  // Keep PostgreSQL's microseconds. A JS Date rounds them away and can repeat
  // the same full page when several operations share one settlement instant.
  return last ? { at: last.cursorAt, id: last.id } : null;
}

async function learningSnapshot(database: Database, operation: Operation) {
  const evidence: LearningCase["evidence"] = [];
  const targets: LearningCase["targets"] = [];
  const reviewReasons: string[] = [];
  let remaining = 20_000;
  function add(
    id: string,
    kind: LearningCase["evidence"][number]["kind"],
    value: unknown,
    limit = 4_000,
  ) {
    if (value === null || value === undefined) return;
    const body = typeof value === "string" ? value : JSON.stringify(value);
    if (!body?.trim() || remaining <= 0 || evidence.length >= 24) return;
    let excerpt = body.slice(0, Math.min(limit, remaining));
    while (Buffer.byteLength(excerpt) > remaining)
      excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.75));
    if (!excerpt.trim()) return;
    evidence.push({ id, kind, body: excerpt, truncated: body.length > excerpt.length });
    remaining -= Buffer.byteLength(excerpt);
  }
  function editable(target: LearningTarget, evidenceId: string, value: unknown) {
    if (typeof value !== "string" || !value.trim() || remaining < 512 || targets.length >= 8)
      return;
    let excerpt = value.slice(0, Math.min(4_000, remaining - 256));
    while (Buffer.byteLength(excerpt) > remaining - 256)
      excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.75));
    if (!excerpt.trim()) return;
    targets.push({ target, evidenceId, text: excerpt, truncated: excerpt.length < value.length });
    remaining -= Buffer.byteLength(excerpt) + 256;
  }
  let ownerId: string | null = operation.userId;
  let developerOnly = false;
  let activity = operation.purpose;
  const sourceID = operation.id.split(":")[1] ?? "";
  if (operation.id.startsWith("turn:") && uuid.test(sourceID)) {
    const [turn] = await database.client<
      {
        id: string;
        input: Record<string, unknown>;
        authority: Record<string, unknown>;
        ticketId: string | null;
        conversationId: string | null;
        createdBy: string;
        summary: string | null;
        createdAt: Date;
        updatedAt: Date;
      }[]
    >`SELECT id,input,authority,ticket_id AS "ticketId",conversation_id AS "conversationId",
      created_by AS "createdBy",outcome_summary AS summary,created_at AS "createdAt",updated_at AS "updatedAt"
      FROM factory.agent_turn WHERE id=${sourceID} AND project_id=${operation.projectId}
      AND state IN ('completed','failed','stopped','uncertain')`;
    if (!turn) return null;
    ownerId = turn.ticketId ? null : turn.createdBy;
    activity =
      turn.authority["mode"] === "investigate" && turn.input["kind"] === "project-message"
        ? "research"
        : String(turn.input["kind"] ?? operation.purpose);
    developerOnly = turn.authority["mode"] === "build";
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
    const artifacts = await database.client<
      { ordinal: number; reference: string; body: string; truncated: boolean }[]
    >`SELECT ordinal,reference,body,truncated FROM factory.learning_source_artifact WHERE turn_id=${turn.id} ORDER BY ordinal`;
    for (const artifact of artifacts) {
      if (artifact.reference.startsWith("code:")) developerOnly = true;
      const id = `turn:${turn.id}:source:${artifact.ordinal}`;
      add(id, "artifact", `${artifact.reference}\n${artifact.body}`, 2_500);
      const saved = evidence.find((item) => item.id === id);
      if (saved) saved.truncated ||= artifact.truncated;
    }
    const questionId = turn.input["questionEntryId"];
    if (turn.conversationId && typeof questionId === "string" && uuid.test(questionId)) {
      const [question] = await database.client<{ body: string; payload: unknown }[]>`
        SELECT body,payload FROM factory.conversation_entry WHERE id=${questionId} AND conversation_id=${turn.conversationId}`;
      if (question) add(`question:${questionId}`, "task", question, 3_000);
    }
    if (turn.conversationId) {
      const entries = await database.client<
        { id: string; body: string; payload: Record<string, unknown>; citations: unknown }[]
      >`
        SELECT id,body,payload,citations FROM factory.conversation_entry
        WHERE conversation_id=${turn.conversationId} AND actor IN ('project-agent','change-agent')
          AND created_at>=${turn.createdAt} AND created_at<=${turn.updatedAt}
          AND coalesce(payload->>'contextId','')=${String(turn.input["contextId"] ?? "")}
        ORDER BY ordinal LIMIT 3`;
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
    const designs = await database.client<
      { id: string; content: string; commit: string; citations: unknown }[]
    >`
      SELECT id,canonical_content AS content,source_commit AS commit,citations FROM factory.technical_design_revision
      WHERE turn_id=${turn.id} ORDER BY ordinal LIMIT 1`;
    for (const design of designs) {
      developerOnly = true;
      add(`technical-design:${design.id}`, "artifact", design, 6_000);
    }
    if (turn.authority["mode"] === "build") {
      const [commit] = await database.client<
        { id: string; sha: string | null; parent: string; state: string; changeId: string }[]
      >`
        SELECT id,commit_sha AS sha,expected_parent_sha AS parent,state,change_id AS "changeId"
        FROM factory.change_commit_operation WHERE id=${turn.id}`;
      if (commit?.sha) {
        const checks = await database.client<
          {
            id: string;
            state: string;
            summary: string | null;
            diagnosis: unknown;
            completedAt: Date | null;
          }[]
        >`
          SELECT id,state,summary,diagnosis,completed_at AS "completedAt" FROM factory.verification
          WHERE change_id=${commit.changeId} AND commit_sha=${commit.sha} ORDER BY created_at DESC LIMIT 1`;
        if (
          operation.outcome === "completed" &&
          !checks[0]?.completedAt &&
          Date.now() - new Date(operation.settledAt).getTime() < 24 * 60 * 60_000
        )
          return null;
        add(`commit:${commit.id}`, "artifact", commit, 1_000);
        for (const check of checks)
          add(`verification:${check.id}`, "artifact", { ...check, commit: commit.sha }, 12_000);
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
        const [requirement] = await database.client<{ content: string }[]>`
          SELECT canonical_content AS content FROM factory.requirement_revision WHERE id=${requirementId}`;
        if (requirement) add(`requirements:${requirementId}`, "task", requirement.content, 3_000);
      }
      const feedback = await database.client<{ id: string; body: string; commit: string }[]>`
        SELECT message.id,message.body,feedback.commit_sha AS commit FROM factory.review_feedback_command command
        JOIN factory.review_feedback feedback ON feedback.id=command.feedback_id
        JOIN factory.review_feedback_message message ON message.feedback_id=feedback.id
        WHERE command.turn_id=${turn.id} ORDER BY message.created_at LIMIT 3`;
      for (const item of feedback) add(`feedback:${item.id}`, "feedback", item, 2_000);
    }
    const reviews = await database.client<
      {
        id: string;
        result: unknown;
        evidence: unknown;
        commit: string;
        base: string;
        state: string;
      }[]
    >`
      SELECT review.id,review.result,review.evidence,review.commit_sha AS commit,review.base_sha AS base,review.state FROM factory.candidate_review review
      WHERE (review.turn_id=${turn.id} OR EXISTS(
        SELECT 1 FROM factory.change_commit_operation commit WHERE commit.id=${turn.id} AND commit.change_id=review.change_id AND commit.commit_sha=review.commit_sha))
      AND review.completed_at IS NOT NULL ORDER BY review.ordinal LIMIT 2`;
    for (const review of reviews) add(`candidate-review:${review.id}`, "artifact", review, 6_000);
    const skills = await database.client<
      {
        id: string;
        digest: string;
        scope: string | null;
        libraryId: string | null;
        version: number;
        content: unknown;
      }[]
    >`
      SELECT revision.id,revision.revision::int AS version,revision.content_digest AS digest,library.scope,library.id AS "libraryId",
        jsonb_build_object('key',revision.content->'key','name',revision.content->'name',
          'description',revision.content->'description','roles',revision.content->'roles',
          'instructions',revision.content->'instructions',
          'omitted','Bundled references and executable resources are not copied into this review.') AS content
      FROM factory.agent_turn_skill loaded JOIN factory.skill_revision revision ON revision.id=loaded.revision_id
      LEFT JOIN factory.skill_library_revision link ON link.revision_id=revision.id
      LEFT JOIN factory.skill_library library ON library.id=link.library_id WHERE loaded.turn_id=${turn.id}
      ORDER BY revision.id LIMIT 6`;
    for (const skill of skills) {
      if (skill.scope === "personal") ownerId = turn.createdBy;
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
    // Build summaries are deliberately not represented as native tool traces.
    // With no exact artifact the judge must leave correctness/verification unknown.
  } else if (operation.id.startsWith("monitoring:") && uuid.test(sourceID)) {
    const [incident] = await database.client<
      {
        state: string;
        title: string;
        instructions: string | null;
        payloadDigest: string;
        diagnosis: unknown;
        reason: string | null;
        assignment: unknown;
        policyId: string;
        hookId: string;
        version: number;
        current: boolean;
      }[]
    >`
      SELECT incident.state,incident.title,policy.instructions,incident.payload_digest AS "payloadDigest",
        incident.diagnosis,incident.reason,
        jsonb_build_object('revisionIds',incident.skill_assignment->'revisionIds',
          'requiredRevisionIds',incident.skill_assignment->'requiredRevisionIds',
          'codeAccess',incident.skill_assignment->'codeAccess') AS assignment,incident.policy_id AS "policyId",
        hook.id AS "hookId",hook.version::int AS version,(hook.policy_id=policy.id) AS current
      FROM factory.monitoring_incident incident JOIN factory.monitoring_policy policy ON policy.id=incident.policy_id
      JOIN factory.monitoring_hook hook ON hook.id=policy.hook_id
      WHERE incident.id=${sourceID} AND incident.project_id=${operation.projectId} AND incident.settled_at IS NOT NULL`;
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
    const [generation] = await database.client<
      {
        state: string;
        commit: string;
        failure: string | null;
        pages: number | null;
        conflicts: number | null;
      }[]
    >`
      SELECT state,source_commit_sha AS commit,failure,page_count AS pages,conflict_count AS conflicts
      FROM factory.knowledge_generation WHERE id=${sourceID} AND project_id=${operation.projectId} AND completed_at IS NOT NULL`;
    if (!generation) return null;
    ownerId = null;
    developerOnly = true;
    add(`wiki:${sourceID}:outcome`, "outcome", generation);
    const revisions = await database.client<
      {
        id: string;
        title: string;
        body: string;
        commit: string;
        pageId: string | null;
        version: number | null;
      }[]
    >`
      SELECT revision.id,revision.title,revision.body,revision.source_commit_sha AS commit,
        page.id AS "pageId",page.version::int AS version
      FROM factory.knowledge_revision revision LEFT JOIN factory.knowledge_page page
        ON page.id=revision.page_id AND page.current_revision_id=revision.id AND page.state='active'
      WHERE revision.generation_id=${sourceID} ORDER BY revision.id LIMIT 3`;
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
    const [inspection] = await database.client<
      { state: string; source: string; output: unknown; failure: string | null }[]
    >`
      SELECT state,source_commit AS source,output,failure FROM factory.project_setup_inspection
      WHERE id=${sourceID} AND project_id=${operation.projectId} AND state NOT IN ('inspecting','confirming')`;
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
  return learningCase.parse({
    id: operation.id,
    projectId: operation.projectId,
    ownerId,
    developerOnly,
    activity,
    outcome: operation.outcome,
    settledAt: new Date(operation.settledAt).toISOString(),
    evidence,
    targets,
    ...(reviewReasons.length ? { reviewReasons } : {}),
  });
}
