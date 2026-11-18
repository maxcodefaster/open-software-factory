import { createHash } from "node:crypto";
import type {
  LearningCase,
  LearningEdit,
  LearningResult,
} from "../../../../packages/conversation-domain/src/learning";

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

// Keep every admitted history entry's state and target identity. Prefer complete
// edits, but never silently cut a passage or exceed one evidence item's bound.
export function priorProposalEvidence(
  previous: PriorProposal[],
  judgeKey: string,
): LearningCase["evidence"][number] {
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
    for (const item of history) {
      item.title = item.title.slice(0, Math.floor(item.title.length / 2));
      item.change = item.change.slice(0, Math.floor(item.change.length / 2));
    }
    body = JSON.stringify(history);
  }
  return {
    id: `learning:prior-proposals:${judgeKey}`,
    kind: "configuration",
    truncated: true,
    body,
  };
}
