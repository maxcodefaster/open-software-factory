import { describe, expect, test } from "bun:test";
import { resolveHeaderPlanningBadges } from "./ticket-header-planning-badges";

describe("resolveHeaderPlanningBadges", () => {
  test("shows Technical planning in progress and suppresses contradictory Clarification in progress", () => {
    const result = resolveHeaderPlanningBadges({
      technicalBadge: { kind: "planning-required", label: "Technical planning required" },
      hasChange: false,
      hasProposal: false,
      technicalPlanningPending: true,
      planningBusy: true,
      canInterview: true,
      clarificationAction: { label: "Clarification in progress", status: true },
    });
    expect(result).toEqual({
      technicalBadge: { label: "Technical planning in progress", live: true },
      clarificationStatus: undefined,
    });
  });

  test("also suppresses Clarification in progress when assistantPending drives status during pending technical planning", () => {
    const result = resolveHeaderPlanningBadges({
      technicalBadge: { kind: "planning-required", label: "Technical planning required" },
      hasChange: false,
      hasProposal: false,
      technicalPlanningPending: true,
      planningBusy: false,
      canInterview: true,
      clarificationAction: { label: "Clarification in progress", status: true },
    });
    expect(result).toEqual({
      technicalBadge: { label: "Technical planning in progress", live: true },
      clarificationStatus: undefined,
    });
  });

  test("retains Technical planning required when technical planning is idle and pending", () => {
    const result = resolveHeaderPlanningBadges({
      technicalBadge: { kind: "planning-required", label: "Technical planning required" },
      hasChange: false,
      hasProposal: false,
      technicalPlanningPending: true,
      planningBusy: false,
      canInterview: true,
      clarificationAction: { label: "Ask AI to clarify", status: false },
    });
    expect(result).toEqual({
      technicalBadge: { label: "Technical planning required", live: false },
      clarificationStatus: undefined,
    });
  });

  test("preserves Clarification in progress during product requirements interview", () => {
    const result = resolveHeaderPlanningBadges({
      technicalBadge: { kind: "hidden" },
      hasChange: false,
      hasProposal: false,
      technicalPlanningPending: false,
      planningBusy: true,
      canInterview: true,
      clarificationAction: { label: "Clarification in progress", status: true },
    });
    expect(result).toEqual({
      technicalBadge: undefined,
      clarificationStatus: "Clarification in progress",
    });
  });
});
