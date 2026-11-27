import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import type { TicketBoardInput } from "#interface-domain/ticket-board";
import type { DeliveryBlock } from "#interface-domain/ticket-progress";
import type { RequirementContent } from "#requirement-domain/content";
import { ticketDocumentInput } from "#requirement-domain/document";
import type { TechnicalDesignContent } from "#requirement-domain/technical-design";
import type {
  RequirementProposal,
  TechnicalDesignRevision,
  TicketDetail,
  TicketDocumentSave,
  TicketDraft,
} from "../change/contracts";
import { type DocumentBlock, type DocumentEditor, documentBlocks } from "../editor/client";
import type { Epic } from "../projects/contracts";
import type { TicketCheckDetails } from "./ticket-checks";
import type { TicketWorkspaceDependencies } from "./ticket-dependencies";

export type TicketView = {
  id: string;
  title: string;
  description: string;
  state: TicketBoardInput["ticketState"];
  version: number;
  epicId?: string | null | undefined;
  convertedToEpicId?: string | null | undefined;
  trashedAt?: string | number | null | undefined;
  trashStopPending?: boolean | null | undefined;
};

export type RequirementRevisionView = {
  id: string;
  ordinal: number;
  canonicalContent: string;
  contentDigest: string;
  createdAt?: string | undefined;
  approvalId?: string | undefined;
  approvedAt?: string | undefined;
  author?: string | null | undefined;
  authorKind?: "human" | "ai" | undefined;
  title?: string | undefined;
  description?: string | undefined;
};

export type TicketDocumentRevisionView = RequirementRevisionView & {
  title: string;
  description: string;
  requirementRevisionId: string | null;
};

export type ChangeView = {
  id: string;
  requirementApprovalId?: string | undefined;
  state: string;
  baseSha: string;
  branchName: string;
  runtimeState?: string | undefined;
  verificationState?: string | undefined;
  buildTurnState?: string | undefined;
  buildTurnPurpose?: string | undefined;
  implementationState?: string | undefined;
  failure?: string | undefined;
};

export type DeliveryView = TicketCheckDetails & {
  pullRequestNumber?: number | undefined;
  pullRequestUrl?: string | undefined;
  pullRequestState?: string | undefined;
  verificationState?: string | undefined;
  verificationSummary?: string | undefined;
  actionRunUrl?: string | undefined;
  approvedAt?: string | undefined;
  mergeState?: string | undefined;
  promotionState?: string | undefined;
  promotionId?: string | undefined;
  cleanupError?: string | undefined;
  replacementRuntimeState?: string | undefined;
};

export type TicketWorkspaceProps = {
  projectID?: string | undefined;
  people?: JSX.Element;
  feedbackID?: string | undefined;
  current: {
    ticket: TicketView;
    revisions: RequirementRevisionView[];
    documentRevisions: TicketDocumentRevisionView[];
    origin: { id: string; title: string } | null;
    followUps: Array<{ id: string; title: string }>;
    proposal?: RequirementProposal | null;
    technicalDesigns?: TechnicalDesignRevision[] | undefined;
    technicalDesignPresent?: boolean | undefined;
    technicalPlanningPending?: boolean | undefined;
    implementationOrder?: TicketDetail["implementationOrder"];
  };
  ticketReference: string;
  storageKey: string;
  change?: ChangeView | undefined;
  delivery?: DeliveryView | undefined;
  deliveryBlock?: DeliveryBlock | undefined;
  latestRevision?: RequirementRevisionView | undefined;
  latestRequirement?: RequirementContent | undefined;
  pending: boolean;
  buildInProgress?: boolean;
  epics: readonly Epic[];
  dependencies: TicketWorkspaceDependencies;
  onAssignEpic(epicId: string | null): void;
  drafts: Map<string, TicketDraft>;
  onInterview(): void;
  onFullPlanning?(): void;
  onTechnicalPlanning?(): void;
  onSaveTechnicalDesign?(revisionID: string, content: TechnicalDesignContent): Promise<boolean>;
  planningBusy?: boolean;
  onSaveDocument(input: TicketDraft, ticketID: string): Promise<TicketDocumentSave | undefined>;
  onConfirmRequirements(
    input: TicketDraft,
    ticketID: string,
  ): Promise<TicketDocumentSave | undefined>;
  clarificationAction: { label: string; status: boolean };
  awaitingAnswer?: boolean;
  onFollowUp(): void;
  onOpenTicket(id: string): void;
  onOpenEpic(id: string): void;
  onTrash(): void;
  onRestore(): void;
  onImplement(revisionID: string): void;
  onCodingOptions(revisionID: string): void;
  codingOptionsOpen: boolean;
  implementationAvailable: boolean;
  codingPause?: { reason: string; turnID: string } | null | undefined;
  computeWait?: string | null | undefined;
  onResumeCoding?(): void;
  onStopImplementation(): void;
  onCancelImplementation?(): void;
  onOpenIDE(): void;
  onOpenPreview?: (() => void) | undefined;
  active?: boolean | undefined;
  onApproveDelivery(changeID: string): void;
  onRetryReview?(changeID: string): void;
  onRetryPromotion?(changeID: string): void;
  onResumeChecks?(changeID: string): void;
  canDevelop: boolean;
  userID?: string;
};

export type EditorField = "title" | "description" | "summary" | "acceptance" | "non-goal";
export type SlashBlock = "acceptance" | "non-goal" | DocumentBlock;
export const slashBlocks = [
  ...documentBlocks,
  { id: "acceptance", label: "Acceptance criterion" },
  { id: "non-goal", label: "Non-goal" },
] as const;

export type SelectionToolbar = { element: HTMLElement; range: Range };
export type SlashMenu = SelectionToolbar & { query: string; length: number };

export type DraftBlock = {
  id: string;
  value(): string;
  setValue(value: string): void;
};

export type TextSurfaceProps = {
  attachmentScopeKey?: string | undefined;
  value: string;
  label: string;
  field: EditorField;
  editable: boolean;
  plain?: boolean;
  placeholder?: string;
  class: string;
  onElement?(element: HTMLElement): void;
  onEditor?(element: HTMLElement, handle: DocumentEditor): void;
  onFocus?(element: HTMLElement): void;
  onInput(value: string, element: HTMLElement): void;
  onKeyDown(event: KeyboardEvent, element: HTMLElement): void;
  onSelection(element: HTMLElement): void;
};

export type RichTextHandlerOptions = {
  slash?: boolean;
  update(value: string): void;
};

export type RichTextHandlers = {
  onInput: (value: string, element: HTMLElement) => void;
  onKeyDown: (event: KeyboardEvent, element: HTMLElement) => void;
  onSelection: (element: HTMLElement) => void;
  onEditor: (element: HTMLElement, handle: DocumentEditor) => void;
};

export function createDraftBlock(value: string): DraftBlock {
  const [blockValue, setBlockValue] = createSignal(value);
  return { id: crypto.randomUUID(), value: blockValue, setValue: setBlockValue };
}

export function canEditTicketSpecification(ticket: TicketView): boolean {
  return !ticket.trashedAt && !ticket.convertedToEpicId && ticket.state !== "cancelled";
}

export function parseRequirement(revision: RequirementRevisionView) {
  try {
    const parsed = ticketDocumentInput.shape.requirement.safeParse(
      JSON.parse(revision.canonicalContent),
    );
    return parsed.success ? (parsed.data ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

export function normalizedRequirement(content: RequirementContent): RequirementContent {
  return {
    summary: content.summary.trim(),
    acceptanceCriteria: content.acceptanceCriteria.map((value) => value.trim()).filter(Boolean),
    nonGoals: content.nonGoals.map((value) => value.trim()).filter(Boolean),
  };
}

export function sameRequirement(left: RequirementContent, right: RequirementContent) {
  return (
    JSON.stringify(normalizedRequirement(left)) === JSON.stringify(normalizedRequirement(right))
  );
}
