import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applyLearningEdit,
  type LearningCase,
  type LearningEdit,
  type LearningResult,
  LearningResultRejected,
  learningEdit,
  validateLearningResult,
} from "#conversation-domain/learning";

export type PriorProposal = {
  id: string;
  state: string;
  applicationState: string | null;
  content: Pick<LearningResult["proposals"][number], "title" | "target" | "change" | "edit">;
};
type PriorEdit =
  | LearningEdit
  | {
      target: LearningEdit["target"];
      passagesOmitted: true;
      passagesDigest: string;
    };

const historyEntry = z.object({
  id: z.uuid(),
  state: z.string(),
  applicationState: z.string().nullable(),
  target: z.string(),
  edit: z.unknown(),
});

// The link belongs to the later review, not the original immutable proposal.
// Only Factory's admitted history can identify an existing edit; task prose,
// omitted passages and merely sharing a Skill do not establish that association.
export function relatedProposalEdit(
  finding: LearningResult["findings"][number],
  cases: LearningCase[],
): LearningEdit | null {
  if (!finding.relatedProposalId) return null;
  const reject = () => {
    throw new LearningResultRejected("A related proposal must match observed pending guidance");
  };
  const scope = cases[0];
  if (
    !scope ||
    finding.dimension !== "method" ||
    cases.some(
      (item) =>
        item.projectId !== scope.projectId ||
        item.ownerId !== scope.ownerId ||
        item.developerOnly !== scope.developerOnly,
    )
  )
    return reject();
  const history = cases.flatMap((item) =>
    item.evidence.filter(
      (source) =>
        source.kind === "configuration" && source.id.startsWith("learning:prior-proposals:"),
    ),
  );
  if (history.length !== 1 || history[0]?.truncated) return reject();
  let entries: z.infer<typeof historyEntry>[];
  try {
    entries = z
      .array(historyEntry)
      .max(12)
      .parse(JSON.parse(history[0]?.body ?? ""));
  } catch {
    return reject();
  }
  const matches = entries.filter((item) => item.id === finding.relatedProposalId);
  const previous = matches[0];
  if (
    matches.length !== 1 ||
    !previous ||
    previous.state !== "proposed" ||
    previous.applicationState !== null
  )
    return reject();
  const parsed = learningEdit.safeParse(previous.edit);
  if (!parsed.success || previous.target !== parsed.data.target.kind) return reject();
  const edit = parsed.data;
  for (const id of finding.caseIds) {
    const source = cases.find((item) => item.id === id);
    if (
      !source?.evidence.some(
        (item) =>
          finding.evidenceIds.includes(item.id) &&
          ["outcome", "artifact", "feedback"].includes(item.kind),
      )
    )
      return reject();
    const observed = source.targets.find(
      (item) =>
        item.target.kind === edit.target.kind &&
        item.target.id === edit.target.id &&
        item.target.revisionId === edit.target.revisionId &&
        item.target.version === edit.target.version &&
        item.target.field === edit.target.field &&
        !item.truncated &&
        finding.evidenceIds.includes(item.evidenceId) &&
        source.evidence.some(
          (evidence) =>
            evidence.id === item.evidenceId &&
            evidence.kind === "configuration" &&
            !evidence.truncated,
        ),
    );
    if (!observed) return reject();
    try {
      applyLearningEdit(observed.text, edit);
    } catch {
      return reject();
    }
  }
  return edit;
}

export function validateWorkReviewResult(input: unknown, cases: LearningCase[]): LearningResult {
  const result = validateLearningResult(input, cases);
  for (const finding of result.findings) relatedProposalEdit(finding, cases);
  return result;
}

// Keep every admitted history entry's state and target identity. Prefer complete
// edits, but never silently cut a passage or exceed one evidence item's bound.
export function priorProposalEvidence(
  previous: PriorProposal[],
  judgeKey: string,
): LearningCase["evidence"][number] {
  let truncated = previous.some((item) => item.content.change.length > 400);
  const history = previous.map((item) => ({
    id: item.id,
    state: item.state,
    applicationState: item.applicationState,
    title: item.content.title,
    target: item.content.target,
    change: item.content.change.slice(0, 400),
    edit: (item.content.edit ?? null) as PriorEdit | null,
  }));
  let body = JSON.stringify(history);
  for (const item of [...history].sort(
    (a, b) => JSON.stringify(b.edit).length - JSON.stringify(a.edit).length,
  )) {
    if (body.length <= 12_000) break;
    if (!item.edit || !("before" in item.edit)) continue;
    truncated = true;
    const { target, before, after } = item.edit;
    item.edit = {
      target,
      passagesOmitted: true,
      passagesDigest: createHash("sha256").update(JSON.stringify({ before, after })).digest("hex"),
    };
    body = JSON.stringify(history);
  }
  // Escape-heavy titles/descriptions can exceed the bound even after passages
  // are omitted. Retain all identities and fingerprints before spending on prose.
  while (body.length > 12_000 && history.some((item) => item.title.length || item.change.length)) {
    truncated = true;
    for (const item of history) {
      item.title = item.title.slice(0, Math.floor(item.title.length / 2));
      item.change = item.change.slice(0, Math.floor(item.change.length / 2));
    }
    body = JSON.stringify(history);
  }
  return {
    id: `learning:prior-proposals:${judgeKey}`,
    kind: "configuration",
    truncated,
    body,
  };
}
