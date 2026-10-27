import { createHash } from "node:crypto";
import type { createDatabase } from "../../packages/db/src/client";
import type { LearningEdit, LearningCase } from "../../packages/conversation-domain/src/learning";

export async function retainedEditProposal(
  database: ReturnType<typeof createDatabase>,
  input: {
    projectId: string;
    userId: string;
    edit: LearningEdit;
    text: string;
    private?: boolean;
    developerOnly?: boolean;
    title?: string;
    activity?: string;
  },
) {
  const reviewId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const source: LearningCase = {
    id: `owned:case:${id}`,
    projectId: input.projectId,
    ownerId: input.private ? input.userId : null,
    developerOnly: input.developerOnly ?? false,
    activity: input.activity ?? "research",
    outcome: "completed",
    settledAt: new Date().toISOString(),
    evidence: [
      {
        id: `owned:config:${id}`,
        kind: "configuration",
        body: JSON.stringify(input.edit.target),
        truncated: false,
      },
      {
        id: `owned:outcome:${id}`,
        kind: "outcome",
        body: "Owned fixture observed an avoidable repeated question despite an inspected source.",
        truncated: false,
      },
    ],
    targets: [
      {
        target: input.edit.target,
        evidenceId: `owned:config:${id}`,
        text: input.text,
        truncated: false,
      },
    ],
  };
  const content = {
    title: input.title ?? "Use the inspected source before asking again",
    target: input.edit.target.kind,
    caseIds: [source.id],
    evidenceIds: source.evidence.map((item) => item.id),
    change: "Replace one observed instruction passage.",
    expectedEffect: "Avoid a repeated question without changing authority.",
    validation: "Check the same source-backed task and a healthy comparison.",
    edit: input.edit,
  };
  const result = {
    cases: [
      {
        caseId: source.id,
        fulfillment: "problem",
        rework: "avoidable",
        verification: "unknown",
        explanation: "Owned controlled comparison evidence.",
        evidenceIds: [`owned:outcome:${id}`],
      },
    ],
    findings: [],
    proposals: [content],
  };
  const snapshot = JSON.stringify([source]);
  await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,
    judge_key,state,input,input_digest,result,owner_token,owner_expires_at,completed_at)
    VALUES(${reviewId},${input.projectId},${source.ownerId},${source.developerOnly},${input.userId},'work','work-review/v1','owned-model',
      'owned-judge','completed',${snapshot}::jsonb,${createHash("sha256").update(snapshot).digest("hex")},
      ${JSON.stringify(result)}::jsonb,${crypto.randomUUID()},now(),now())`;
  await database.client`INSERT INTO factory.learning_proposal(id,review_id,ordinal,content)
    VALUES(${id},${reviewId},0,${JSON.stringify(content)}::jsonb)`;
  return { id, reviewId, source, content };
}
