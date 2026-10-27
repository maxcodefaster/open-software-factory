import { describe, expect, test } from "bun:test";
import { learningFixture } from "../../../../test/fixtures/learning";
import { learningHistoryFixture } from "../../../../test/fixtures/learning-history";
import { learningFlowLayout, learningFlowRecords } from "./flow";
import { fixtureValue } from "../../../../test/fixtures/value";

describe("retained learning flow", () => {
  test("merges each proposal's lifecycle into one honest, dated record", () => {
    const view = learningHistoryFixture();
    const records = learningFlowRecords(view);
    expect(records.map((item) => item.status)).toEqual([
      "Ticket created",
      "Kept current",
      "Proposed",
      "Adopted v4",
    ]);
    expect(records.map((item) => item.dateLabel)).toEqual([
      "Source review",
      "Comparison started",
      "Source review",
      "Applied",
    ]);
    expect(records.at(-1)?.description).toContain("2 of 3 sampled cases reviewed");
    expect(records.at(-1)?.description).toContain("not causal proof");
    expect(records[0]?.description).toContain("normal approvals");
    expect(records[1]?.detailId).toBe(
      `work-comparison-${fixtureValue(view.comparisons[0], "view.comparisons[0]").id}`,
    );
    expect(records[2]?.detailId).toBe(
      `work-proposal-${fixtureValue(view.proposals[2], "view.proposals[2]").id}`,
    );
    expect(records.at(-1)?.detailId).toBe(
      `work-application-${fixtureValue(view.applications[0], "view.applications[0]").id}`,
    );
    const snapshot = structuredClone(view);
    view.proposals.reverse();
    view.reviews.reverse();
    expect(learningFlowRecords(view)).toEqual(records);
    view.proposals.reverse();
    view.reviews.reverse();
    expect(view).toEqual(snapshot);
  });
  test("never turns calibration, an empty view or an unsettled review into a learning win", () => {
    expect(learningFlowRecords(learningFixture(true))).toEqual([]);
    const view = learningFixture();
    view.proposals = [];
    fixtureValue(view.reviews[0], "view.reviews[0]").kind = "calibration";
    expect(learningFlowRecords(view)).toEqual([]);
    fixtureValue(view.reviews[0], "view.reviews[0]").kind = "work";
    expect(learningFlowRecords(view)[0]?.status).toBe("No change proposed");
    fixtureValue(view.reviews[0], "view.reviews[0]").state = "uncertain";
    fixtureValue(view.reviews[0], "view.reviews[0]").result = null;
    expect(learningFlowRecords(view)[0]?.status).toBe("Review unconfirmed");
    fixtureValue(view.reviews[0], "view.reviews[0]").state = "running";
    expect(learningFlowRecords(view)[0]?.status).toBe("Review running");
  });
  test("a passed comparison is not evidence that a revision is currently active", () => {
    const view = learningHistoryFixture();
    fixtureValue(view.comparisons[0], "view.comparisons[0]").result = {
      passed: true,
      decision: "applied",
      cases: [],
    };
    const record = fixtureValue(
      learningFlowRecords(view).find((item) => item.target === "Adoption comparison"),
      'learningFlowRecords(view).find((item) => item.target === "Adoption comparison")',
    );
    expect(record.status).toBe("Comparison passed");
    expect(record.mark).not.toBe("filled");
    expect(record.description).not.toContain("currently active");
    fixtureValue(view.comparisons[0], "view.comparisons[0]").reason = null;
    expect(learningFlowRecords(view).find((item) => item.id === record.id)?.description).toContain(
      "No applied revision is included",
    );
  });
  test("unknown, failed and blocked comparisons retain uncertainty", () => {
    for (const state of ["running", "uncertain", "failed"] as const) {
      const view = learningHistoryFixture();
      fixtureValue(view.comparisons[0], "view.comparisons[0]").state = state;
      fixtureValue(view.comparisons[0], "view.comparisons[0]").result = null;
      const record = fixtureValue(
        learningFlowRecords(view).find((item) => item.target === "Adoption comparison"),
        'learningFlowRecords(view).find( (item) => item.target === "Adoption comparison", )',
      );
      expect(record.status).toBe(
        { running: "Comparing", uncertain: "Unconfirmed", failed: "Comparison failed" }[state],
      );
      expect(record.mark).not.toBe("filled");
      expect(record.tone).toBe(state === "running" ? "pending" : "attention");
    }
    const view = learningHistoryFixture();
    fixtureValue(view.comparisons[0], "view.comparisons[0]").result = {
      passed: true,
      decision: "blocked",
      cases: [],
    };
    expect(
      learningFlowRecords(view).find((item) => item.target === "Adoption comparison")?.status,
    ).toBe("Adoption blocked");
  });
  test("manual application, dismissal and protected reversion keep their actual meaning", () => {
    const view = learningHistoryFixture();
    fixtureValue(view.proposals[2], "view.proposals[2]").state = "dismissed";
    fixtureValue(view.applications[0], "view.applications[0]").automatic = false;
    const applied = fixtureValue(
      learningFlowRecords(view).at(-1),
      "learningFlowRecords(view).at(-1)",
    );
    expect(applied.status).toBe("Applied v4");
    expect(applied.description).toContain("explicit human decision");
    expect(
      learningFlowRecords(view).find((item) => item.title.includes("incomplete"))?.status,
    ).toBe("Dismissed");
    fixtureValue(view.applications[0], "view.applications[0]").state = "reverted";
    fixtureValue(view.applications[0], "view.applications[0]").revertedAt = "2026-10-27T12:00:00Z";
    fixtureValue(view.applications[0], "view.applications[0]").automaticRecovery = true;
    const reverted = fixtureValue(
      learningFlowRecords(view).at(-1),
      "learningFlowRecords(view).at(-1)",
    );
    expect(reverted.id).toBe(applied.id);
    expect(reverted.status).toBe("Reverted");
    expect(reverted.dateLabel).toBe("Reverted");
    expect(reverted.at).toBe("2026-10-27T12:00:00Z");
    expect(reverted.description).toContain("matched recovery comparison");
    expect(reverted.mark).not.toBe("filled");
  });
  test("retention windows cannot invent no-change decisions or an applied revision", () => {
    const view = learningHistoryFixture();
    view.proposals = [];
    expect(learningFlowRecords(view).some((item) => item.status === "Adopted v4")).toBe(true);
    const empty = learningFixture();
    fixtureValue(
      fixtureValue(empty.reviews[0], "empty.reviews[0]").result,
      "empty.reviews[0]!.result",
    ).proposals = [fixtureValue(empty.proposals[0], "empty.proposals[0]").content];
    empty.proposals = [];
    expect(learningFlowRecords(empty)[0]?.status).toBe("Proposals recorded");
    const missing = learningHistoryFixture();
    missing.applications = [];
    expect(learningFlowRecords(missing).at(-1)?.status).toBe("Revision unavailable");
    expect(learningFlowRecords(missing).at(-1)?.detailId).toBe(
      `work-review-${fixtureValue(missing.proposals[3], "missing.proposals[3]").reviewId}`,
    );
  });
  test("history is read-only and has no dependency on current pause or management rights", () => {
    const view = learningHistoryFixture();
    const before = structuredClone(view);
    const records = learningFlowRecords(view);
    expect(view).toEqual(before);
    view.enabled = false;
    view.canManage = false;
    expect(learningFlowRecords(view)).toEqual(records);
    const privateView = learningFixture(true);
    privateView.scope = "personal";
    expect(learningFlowRecords(privateView)).toEqual([]);
  });
});

describe("learning flow geometry", () => {
  test("sparse histories take less room without inventing more nodes", () => {
    const single = learningFlowLayout(800, 1);
    const pair = learningFlowLayout(800, 2);
    const full = learningFlowLayout(800, 4);
    expect(single.height).toBeLessThan(pair.height);
    expect(pair.height).toBeLessThan(full.height);
    expect(single.nodes).toHaveLength(1);
    expect(pair.nodes).toHaveLength(2);
  });
  for (const width of [224, 288, 360, 519, 520, 600, 1000]) {
    for (const count of [0, 1, 2, 3, 4]) {
      test(`${count} records fit a ${width}px container without scaling labels`, () => {
        const layout = learningFlowLayout(width, count);
        expect(layout.width).toBe(width);
        expect(layout.nodes).toHaveLength(count);
        expect(layout.selections).toHaveLength(count);
        for (const segment of layout.selections) {
          expect(segment.paths).toHaveLength(13);
          for (const point of [segment.start, segment.end]) {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(width);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThanOrEqual(layout.height);
          }
        }
        for (const node of layout.nodes) {
          expect(node.label.x).toBeGreaterThanOrEqual(0);
          expect(node.label.x + node.label.width).toBeLessThanOrEqual(width);
          expect(node.label.y).toBeGreaterThanOrEqual(0);
          expect(node.label.y + 72).toBeLessThan(layout.height);
          expect(node.x).toBeGreaterThanOrEqual(22);
          expect(node.x).toBeLessThanOrEqual(width - 22);
        }
        for (const path of layout.threads) {
          expect(path).not.toContain("NaN");
          expect(path).not.toContain("Infinity");
          const coordinates = [...path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)];
          for (const coordinate of coordinates) {
            expect(Number(coordinate[1])).toBeGreaterThanOrEqual(0);
            expect(Number(coordinate[1])).toBeLessThanOrEqual(width);
            expect(Number(coordinate[2])).toBeGreaterThanOrEqual(0);
            expect(Number(coordinate[2])).toBeLessThanOrEqual(layout.height);
          }
        }
      });
    }
  }
});
