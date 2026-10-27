import type { LearningView } from "../../../../packages/conversation-domain/src/learning";

export type LearningFlowRecord = {
  id: string;
  title: string;
  at: string;
  dateLabel: string;
  target: string;
  status: string;
  tone: "quiet" | "pending" | "applied" | "attention";
  mark: "circle" | "diamond" | "square" | "filled";
  description: string;
  detailId: string;
};
const targets = {
  skill: "Skill",
  knowledge: "Wiki",
  input: "Project Input",
  tests: "Tests",
  ci: "Project CI",
  instructions: "Repository instructions",
  "factory-defect": "Factory defect",
};
const newest = <T extends { createdAt: string }>(items: T[]) =>
  items.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

/** A bounded view of retained records, not an inference about improvement or causality. */
export function learningFlowRecords(view: LearningView): LearningFlowRecord[] {
  const records: LearningFlowRecord[] = [];
  const proposals = new Map(view.proposals.map((proposal) => [proposal.id, proposal]));
  const reviewIds = new Set(view.proposals.map((proposal) => proposal.reviewId));
  const ids = new Set([
    ...proposals.keys(),
    ...view.applications.map((item) => item.proposalId),
    ...view.comparisons.map((item) => item.proposalId),
  ]);
  for (const id of ids) {
    const proposal = proposals.get(id);
    const review = view.reviews.find((item) => item.id === proposal?.reviewId);
    const application = newest(view.applications.filter((item) => item.proposalId === id));
    const comparison = newest(view.comparisons.filter((item) => item.proposalId === id));
    if (application) {
      const reverted = application.state === "reverted";
      records.push({
        id: `proposal:${id}`,
        title: application.title,
        at: application.revertedAt ?? application.createdAt,
        dateLabel: application.revertedAt ? "Reverted" : "Applied",
        target: `${application.targetLabel ?? targets[application.target.kind]} · v${application.appliedVersion}`,
        status: reverted
          ? "Reverted"
          : `${application.automatic ? "Adopted" : "Applied"} v${application.appliedVersion}`,
        tone: reverted ? "quiet" : "applied",
        mark: reverted ? "square" : "filled",
        description: reverted
          ? application.automaticRecovery
            ? "Reverted after a matched recovery comparison. The accepted edit and original revision remain in the record."
            : "Reverted by an explicit decision. The accepted edit and original revision remain in the record."
          : `${
              application.automatic
                ? "Adopted under saved permission after a matched text comparison."
                : "Applied by an explicit human decision."
            } Later use: ${application.subsequent.reviewed} of ${application.subsequent.sampled} sampled cases reviewed, ${application.subsequent.problems} with problems. These observations are not causal proof.`,
        detailId: `work-application-${application.id}`,
      });
    } else if (proposal?.state === "dismissed" || proposal?.state === "ticket-created") {
      if (!review) continue;
      records.push({
        id: `proposal:${id}`,
        title: proposal.content.title,
        at: review.completedAt ?? review.createdAt,
        dateLabel: "Source review",
        target: targets[proposal.content.target],
        status: proposal.state === "dismissed" ? "Dismissed" : "Ticket created",
        tone: "quiet",
        mark: proposal.state === "dismissed" ? "diamond" : "square",
        description:
          proposal.state === "dismissed"
            ? "The proposal was dismissed. Its source review and evidence are retained."
            : "An improvement Ticket was prepared. Implementation and Delivery still need their normal approvals.",
        detailId: `work-review-${review.id}`,
      });
    } else if (comparison) {
      const result = comparison.result;
      const kept = comparison.state === "completed" && result?.decision === "kept";
      const passed =
        comparison.state === "completed" &&
        result?.passed &&
        !kept &&
        result.decision !== "blocked";
      records.push({
        id: `proposal:${id}`,
        title: comparison.title,
        at: comparison.createdAt,
        dateLabel: "Comparison started",
        target: `${comparison.phase === "recover" ? "Recovery" : "Adoption"} comparison`,
        status:
          comparison.state === "running"
            ? "Comparing"
            : comparison.state === "uncertain"
              ? "Unconfirmed"
              : comparison.state === "failed"
                ? "Comparison failed"
                : kept
                  ? "Kept current"
                  : result?.decision === "blocked"
                    ? "Adoption blocked"
                    : passed
                      ? "Comparison passed"
                      : "Not demonstrated",
        tone: comparison.state === "running" ? "pending" : kept || passed ? "quiet" : "attention",
        mark: kept ? "diamond" : "circle",
        description:
          comparison.reason ??
          (kept
            ? "The comparison kept the current revision. The actual responses and verdicts are retained."
            : passed
              ? "The comparison recorded a passing result. No applied revision is included in this view; inspect the exact result before assuming a change is active."
              : "A comparison alone is not an adopted change. Inspect its retained responses and decision."),
        detailId: `work-comparison-${comparison.id}`,
      });
    } else if (proposal && review) {
      const state = proposal.comparisonState;
      records.push({
        id: `proposal:${id}`,
        title: proposal.content.title,
        at: review.completedAt ?? review.createdAt,
        dateLabel: "Source review",
        target: proposal.targetLabel ?? targets[proposal.content.target],
        status:
          proposal.state === "applied"
            ? "Revision unavailable"
            : state === "running"
              ? "Comparing"
              : state === "unconfirmed"
                ? "Unconfirmed"
                : state === "not-demonstrated"
                  ? "Not demonstrated"
                  : "Proposed",
        tone: state === "unconfirmed" || proposal.state === "applied" ? "attention" : "pending",
        mark: "circle",
        description:
          proposal.state === "applied"
            ? "The proposal records an applied decision, but its exact applied revision is not included in this view."
            : `Proposed change, not applied: ${proposal.content.change}`,
        detailId:
          proposal.state === "applied"
            ? `work-review-${review.id}`
            : `work-proposal-${proposal.id}`,
      });
    }
  }
  for (const review of view.reviews) {
    // Calibration is about the judge, not the Project learning a new method.
    if (review.kind !== "work" || reviewIds.has(review.id)) continue;
    const settled = review.state === "completed" && review.result !== null;
    const running = review.state === "running";
    const omitted = review.result?.proposals.length ?? 0;
    records.push({
      id: `review:${review.id}`,
      title: `Review of ${review.cases.length} work ${review.cases.length === 1 ? "case" : "cases"}`,
      at: review.completedAt ?? review.createdAt,
      dateLabel: review.completedAt ? "Reviewed" : "Review started",
      target: "Work review",
      status: settled
        ? omitted
          ? "Proposals recorded"
          : "No change proposed"
        : running
          ? "Review running"
          : review.state === "failed"
            ? "Review failed"
            : "Review unconfirmed",
      tone: settled ? "quiet" : running ? "pending" : "attention",
      mark: settled ? "diamond" : "circle",
      description:
        review.reason ??
        (settled
          ? omitted
            ? `This review recorded ${omitted} improvement ${omitted === 1 ? "proposal" : "proposals"}. Their current decisions are outside this view.`
            : "This review produced no retained improvement proposal. Keeping the current approach is a valid outcome."
          : "No settled review decision is available. Missing or uncertain evidence does not establish an improvement."),
      detailId: `work-review-${review.id}`,
    });
  }
  return records.toSorted(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
}

type Point = { x: number; y: number };

/** Schematic order only. Fiber count, distance and width do not encode measurements. */
export function learningFlowLayout(width: number, count: number) {
  const mobile = width < 520;
  const height = mobile
    ? Math.max(204, count * 116 + 40)
    : count === 1
      ? 240
      : count === 2
        ? 288
        : 320;
  const nodes = Array.from({ length: count }, (_, index) => {
    const lane = index % 4;
    const verticalPosition = lane === 0 ? 0.51 : lane === 1 ? 0.59 : lane === 2 ? 0.43 : 0.53;
    const x = mobile
      ? 34 + Math.sin(index * 1.7) * 10
      : count === 1
        ? width / 2
        : 62 + (index * (width - 124)) / (count - 1);
    const y = mobile
      ? count === 1
        ? height / 2
        : 52 + (index * (height - 104)) / (count - 1)
      : height * verticalPosition;
    const labelWidth = mobile ? width - 88 : Math.min(152, width / Math.max(1, count) - 8);
    return {
      x,
      y,
      label: {
        x: mobile
          ? 82
          : index === 0 && count > 1
            ? 0
            : index === count - 1 && count > 1
              ? width - labelWidth
              : x - labelWidth / 2,
        y: mobile ? y - 34 : index % 2 === 0 ? y - 104 : y + 38,
        width: labelWidth,
      },
    };
  });
  const first = nodes[0];
  const last = nodes.at(-1);
  const anchors: Point[] =
    first && last
      ? [
          mobile ? { x: first.x, y: 8 } : { x: 8, y: first.y },
          ...nodes,
          mobile ? { x: last.x, y: height - 8 } : { x: width - 8, y: last.y },
        ]
      : [];
  function point(t: number, strand: number) {
    const scaled = t * (anchors.length - 1);
    const segment = Math.min(anchors.length - 2, Math.floor(scaled));
    const u = scaled - segment;
    const from = anchors[segment];
    const to = anchors[segment + 1];
    if (!from || !to) throw new RangeError("The learning flow segment is outside its layout");
    const smooth = u * u * (3 - 2 * u);
    const spread = Math.sin(u * Math.PI) ** 1.5;
    const tail = segment === 0 || segment === anchors.length - 2;
    const offset = tail
      ? strand * (0.16 + (segment === 0 ? 1 - u : u) ** 1.3 * 1.2)
      : strand * (0.16 + spread * (mobile ? 1.3 : 3.1)) +
        Math.sin(u * Math.PI * 2) * (mobile ? 8 : 14);
    return mobile
      ? { x: from.x + (to.x - from.x) * smooth + offset, y: from.y + (to.y - from.y) * u }
      : { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * smooth + offset };
  }
  function path(strand: number, start = 0, end = 1) {
    if (!count) return "";
    const steps = Math.ceil((end - start) * (count + 1) * 36);
    return Array.from({ length: steps + 1 }, (_, index) => {
      const p = point(start + ((end - start) * index) / steps, strand);
      return `${index ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    }).join(" ");
  }
  const threads = Array.from({ length: 27 }, (_, index) => path(index - 13));
  const selections = nodes.map((_, index) => {
    const start = (index + 0.35) / (count + 1);
    const end = (index + 1.65) / (count + 1);
    return {
      start: point(start, 0),
      end: point(end, 0),
      paths: Array.from({ length: 13 }, (_, strand) => path((strand - 6) * 2, start, end)),
    };
  });
  return { width, height, mobile, nodes, threads, selections };
}
