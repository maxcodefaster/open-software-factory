import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createTicketWorkspaceActions,
  selectPrimaryHeaderActionId,
} from "./ticket-workspace-actions";
import type { TicketWorkspaceProps } from "./ticket-workspace-types";

const noop = () => {};

function makeWorkspaceProps(overrides: Partial<TicketWorkspaceProps> = {}): TicketWorkspaceProps {
  return {
    current: {
      ticket: {
        id: "t-1",
        title: "Export invoices",
        description: "Customers need CSV exports.",
        state: "ready",
        version: 1,
      },
      revisions: [],
      documentRevisions: [],
      origin: null,
      followUps: [],
      technicalDesigns: [],
      technicalDesignPresent: false,
      technicalPlanningPending: false,
      implementationOrder: null,
    },
    ticketReference: "BILL-1",
    storageKey: "test:t-1",
    latestRevision: {
      id: "rev-1",
      ordinal: 1,
      canonicalContent: "{}",
      contentDigest: "digest-1",
    },
    pending: false,
    epics: [],
    dependencies: {
      prerequisites: [],
      candidates: [],
      admitted: false,
      pending: false,
      onOpen: noop,
      onAdd: async () => false,
      onRemove: noop,
    },
    onAssignEpic: noop,
    drafts: new Map(),
    onInterview: noop,
    onFullPlanning: noop,
    onTechnicalPlanning: noop,
    onSaveDocument: async () => undefined,
    onConfirmRequirements: async () => undefined,
    clarificationAction: { label: "Ask AI to clarify", status: false },
    onFollowUp: noop,
    onOpenTicket: noop,
    onOpenEpic: noop,
    onTrash: noop,
    onRestore: noop,
    onImplement: noop,
    onCodingOptions: noop,
    codingOptionsOpen: false,
    implementationAvailable: true,
    onStopImplementation: noop,
    onOpenIDE: noop,
    onOpenPreview: noop,
    onApproveDelivery: noop,
    onRetryReview: noop,
    onRetryPromotion: noop,
    onResumeChecks: noop,
    onResumeCoding: noop,
    canDevelop: true,
    ...overrides,
  };
}

describe("selectPrimaryHeaderActionId", () => {
  const defaultContext = {
    ticketState: "ready" as const,
    continueTechnical: false,
    technicalPlanningPending: false,
  };

  test("enforces strict priority order with at most one primary action", () => {
    const all = [
      { id: "epic" },
      { id: "interview" },
      { id: "implement" },
      { id: "follow-up" },
      { id: "deliver" },
      { id: "revision" },
      { id: "retry-review" },
      { id: "resume-checks" },
      { id: "resume-coding" },
      { id: "retry-promotion" },
      { id: "confirm" },
      { id: "restore" },
    ];
    expect(selectPrimaryHeaderActionId(all, defaultContext)).toBe("restore");
    expect(
      selectPrimaryHeaderActionId(
        all.filter((a) => a.id !== "restore"),
        defaultContext,
      ),
    ).toBe("confirm");
    expect(
      selectPrimaryHeaderActionId(
        all.filter((a) => !["restore", "confirm"].includes(a.id)),
        defaultContext,
      ),
    ).toBe("retry-promotion");
    expect(
      selectPrimaryHeaderActionId(
        all.filter((a) => !["restore", "confirm", "retry-promotion"].includes(a.id)),
        defaultContext,
      ),
    ).toBe("resume-coding");
    expect(
      selectPrimaryHeaderActionId(
        all.filter(
          (a) => !["restore", "confirm", "retry-promotion", "resume-coding"].includes(a.id),
        ),
        defaultContext,
      ),
    ).toBe("resume-checks");
    expect(
      selectPrimaryHeaderActionId(
        all.filter(
          (a) =>
            !["restore", "confirm", "retry-promotion", "resume-coding", "resume-checks"].includes(
              a.id,
            ),
        ),
        defaultContext,
      ),
    ).toBe("retry-review");
    expect(
      selectPrimaryHeaderActionId([{ id: "deliver" }, { id: "revision" }], defaultContext),
    ).toBe("revision");
    expect(
      selectPrimaryHeaderActionId([{ id: "follow-up" }, { id: "deliver" }], defaultContext),
    ).toBe("deliver");
    expect(
      selectPrimaryHeaderActionId([{ id: "implement" }, { id: "follow-up" }], defaultContext),
    ).toBe("follow-up");
  });

  test("promotes Continue technical planning over disabled Implement when technical planning is pending", () => {
    expect(
      selectPrimaryHeaderActionId([{ id: "interview" }, { id: "implement" }], {
        ticketState: "ready",
        continueTechnical: true,
        technicalPlanningPending: true,
      }),
    ).toBe("interview");

    // Contributors without continueTechnical do not get a disabled primary Implement either.
    expect(
      selectPrimaryHeaderActionId([{ id: "interview" }, { id: "implement" }], {
        ticketState: "ready",
        continueTechnical: false,
        technicalPlanningPending: true,
      }),
    ).toBeUndefined();
  });

  test("promotes Ask AI to clarify on inbox and backlog Ideas, and Open Epic on converted tickets", () => {
    expect(
      selectPrimaryHeaderActionId([{ id: "interview" }], {
        ticketState: "inbox",
        continueTechnical: false,
        technicalPlanningPending: false,
      }),
    ).toBe("interview");

    expect(
      selectPrimaryHeaderActionId([{ id: "interview" }], {
        ticketState: "backlog",
        continueTechnical: false,
        technicalPlanningPending: false,
      }),
    ).toBe("interview");

    expect(
      selectPrimaryHeaderActionId([{ id: "epic" }], {
        ticketState: "ready",
        continueTechnical: false,
        technicalPlanningPending: false,
      }),
    ).toBe("epic");
  });
});

describe("createTicketWorkspaceActions", () => {
  test("surfaces Stop implementation as quiet non-primary danger action while busy and hides Open IDE during delivering", () => {
    createRoot((dispose) => {
      const busyController = createTicketWorkspaceActions({
        props: makeWorkspaceProps({
          change: {
            id: "chg-1",
            state: "active",
            baseSha: "a".repeat(40),
            branchName: "factory/t-1",
            implementationState: "working",
            buildTurnState: "running",
          },
        }),
        proposal: () => undefined,
        currentDocument: () => undefined,
        hasChanges: () => false,
        saving: () => false,
        technical: () => undefined,
        technicalDirty: () => false,
        openReviewThreads: () => undefined,
        reviewActions: () => undefined,
        onConfirmProposal: async () => {},
      });

      const busyActions = busyController.headerActions();
      const stop = busyActions.find((action) => action.id === "stop");
      expect(stop).toBeDefined();
      expect(stop?.label).toBe("Stop implementation");
      expect(stop?.danger).toBe(true);
      expect(stop?.primary).toBeUndefined();
      expect(busyActions.filter((action) => action.primary)).toHaveLength(0);
      expect(busyActions.some((action) => action.id === "ide")).toBe(true);

      const deliveringController = createTicketWorkspaceActions({
        props: makeWorkspaceProps({
          change: {
            id: "chg-2",
            state: "delivering",
            baseSha: "a".repeat(40),
            branchName: "factory/t-1",
            implementationState: "committed",
          },
        }),
        proposal: () => undefined,
        currentDocument: () => undefined,
        hasChanges: () => false,
        saving: () => false,
        technical: () => undefined,
        technicalDirty: () => false,
        openReviewThreads: () => undefined,
        reviewActions: () => undefined,
        onConfirmProposal: async () => {},
      });

      expect(deliveringController.headerActions().some((action) => action.id === "ide")).toBe(
        false,
      );
      dispose();
    });
  });

  test("never marks more than one action as primary even when multiple recovery actions exist", () => {
    createRoot((dispose) => {
      const controller = createTicketWorkspaceActions({
        props: makeWorkspaceProps({
          change: {
            id: "chg-3",
            state: "active",
            baseSha: "a".repeat(40),
            branchName: "factory/t-1",
            implementationState: "committed",
          },
          delivery: {
            verificationState: "failed",
            checksStopId: "stop-1",
            reviewState: "incomplete",
          },
          codingPause: { reason: "budget-limit", turnID: "turn-1" },
        }),
        proposal: () => undefined,
        currentDocument: () => undefined,
        hasChanges: () => false,
        saving: () => false,
        technical: () => undefined,
        technicalDirty: () => false,
        openReviewThreads: () => 2,
        reviewActions: () => ({
          addFeedback: noop,
          reload: noop,
          revision: {
            count: 2,
            sending: false,
            disabled: false,
            request: noop,
          },
        }),
        onConfirmProposal: async () => {},
      });

      const primaries = controller.headerActions().filter((action) => action.primary);
      expect(primaries.map((action) => action.id)).toEqual(["resume-coding"]);
      dispose();
    });
  });
});
