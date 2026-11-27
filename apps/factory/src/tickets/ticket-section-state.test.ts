import { describe, expect, test } from "bun:test";
import {
  resolveTicketActivityNotice,
  resolveTicketProgressBanner,
  resolveTicketSaveError,
  resolveTicketSaveFeedback,
} from "./ticket-section-state";
import type { TicketWorkspaceProps } from "./ticket-workspace-types";

describe("ticket section discriminated states", () => {
  test("resolves mutually exclusive activity notices", () => {
    expect(resolveTicketActivityNotice({ computeWait: undefined, codingPause: undefined })).toEqual(
      {
        kind: "none",
      },
    );
    expect(
      resolveTicketActivityNotice({ computeWait: "waiting-for-capacity", codingPause: undefined }),
    ).toEqual({
      kind: "compute-wait",
    });
    expect(
      resolveTicketActivityNotice({
        computeWait: "waiting-for-capacity",
        codingPause: { reason: "accounting-incomplete", turnID: "turn-1" },
      }),
    ).toEqual({ kind: "coding-paused", reason: "accounting-incomplete" });
    expect(
      resolveTicketActivityNotice({
        computeWait: undefined,
        codingPause: { reason: "budget-limit", turnID: "turn-2" },
      }),
    ).toEqual({ kind: "coding-paused", reason: "allowance" });
  });

  test("resolves save feedback states with proposal privacy precedence", () => {
    expect(
      resolveTicketSaveFeedback({
        hasProposal: true,
        editing: true,
        hasChanges: true,
        saving: false,
        editorError: undefined,
        savedDocument: false,
      }),
    ).toEqual({ kind: "proposal-private" });

    expect(
      resolveTicketSaveFeedback({
        hasProposal: true,
        editing: true,
        hasChanges: true,
        saving: true,
        editorError: undefined,
        savedDocument: false,
      }),
    ).toEqual({ kind: "standard", state: "saving" });

    expect(
      resolveTicketSaveFeedback({
        hasProposal: false,
        editing: false,
        hasChanges: false,
        saving: false,
        editorError: undefined,
        savedDocument: true,
      }),
    ).toEqual({ kind: "standard", state: "saved" });
  });

  test("resolves save error banner states", () => {
    expect(
      resolveTicketSaveError({
        editorError: undefined,
        conflict: false,
        saving: false,
        hasChanges: true,
        hasProposal: false,
        title: "Ticket",
      }),
    ).toEqual({ kind: "hidden" });

    expect(
      resolveTicketSaveError({
        editorError: "Changed elsewhere",
        conflict: true,
        saving: false,
        hasChanges: true,
        hasProposal: false,
        title: "Ticket",
      }),
    ).toEqual({ kind: "conflict", message: "Changed elsewhere", saving: false });

    expect(
      resolveTicketSaveError({
        editorError: "Network error",
        conflict: false,
        saving: false,
        hasChanges: true,
        hasProposal: false,
        title: "Ticket",
      }),
    ).toEqual({ kind: "retryable", message: "Network error", saving: false });

    expect(
      resolveTicketSaveError({
        editorError: "Title required",
        conflict: false,
        saving: false,
        hasChanges: true,
        hasProposal: false,
        title: "   ",
      }),
    ).toEqual({ kind: "error", message: "Title required" });
  });

  test("marks progress banners that already explain the Implement blocker so header reasons never duplicate", () => {
    const baseWorkspace = {
      current: {
        ticket: { id: "t-1", title: "Export", description: "Details", state: "ready", version: 1 },
        revisions: [],
        documentRevisions: [],
        origin: null,
        followUps: [],
        technicalPlanningPending: false,
      },
      dependencies: { prerequisites: [], candidates: [], admitted: false, pending: false },
      canDevelop: true,
      planningBusy: false,
      awaitingAnswer: false,
    } as unknown as TicketWorkspaceProps;

    const dirtyBanner = resolveTicketProgressBanner({
      workspace: baseWorkspace,
      hasProposal: false,
      technicalDirty: true,
      requirementsIncomplete: false,
      incompleteReason: "Incomplete",
      description: "Details",
      summary: "Summary",
      implementationBusy: false,
      implementationPreparing: false,
      openThreads: undefined,
    });
    expect(dirtyBanner.kind).toBe("technical-dirty");
    if (dirtyBanner.kind !== "hidden") expect(dirtyBanner.hasActionReasonId).toBe(true);

    const pendingTechBanner = resolveTicketProgressBanner({
      workspace: {
        ...baseWorkspace,
        current: { ...baseWorkspace.current, technicalPlanningPending: true },
      },
      hasProposal: false,
      technicalDirty: false,
      requirementsIncomplete: false,
      incompleteReason: "Incomplete",
      description: "Details",
      summary: "Summary",
      implementationBusy: false,
      implementationPreparing: false,
      openThreads: undefined,
    });
    expect(pendingTechBanner.kind).toBe("progress");
    if (pendingTechBanner.kind !== "hidden") {
      expect(pendingTechBanner.hasActionReasonId).toBe(true);
      expect(pendingTechBanner.message).toContain("Technical planning is unfinished");
    }

    const incompleteBanner = resolveTicketProgressBanner({
      workspace: baseWorkspace,
      hasProposal: false,
      technicalDirty: false,
      requirementsIncomplete: true,
      incompleteReason: "Add a summary and at least one acceptance criterion to enable Implement.",
      description: "Details",
      summary: "",
      implementationBusy: false,
      implementationPreparing: false,
      openThreads: undefined,
    });
    expect(incompleteBanner.kind).toBe("incomplete");
    if (incompleteBanner.kind !== "hidden") expect(incompleteBanner.hasActionReasonId).toBe(true);
  });
});
