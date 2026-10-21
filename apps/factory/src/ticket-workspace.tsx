import { createEffect, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import {
  type TicketBoardInput,
  ticketBoardStatus,
} from "../../../packages/interface-domain/src/ticket-board";
import {
  type RequirementContent,
  requirementContentInput,
} from "../../../packages/requirement-domain/src/content";
import { ticketDocumentInput } from "../../../packages/requirement-domain/src/document";
import type { Epic, RequirementProposal, TicketDocumentSave } from "./api-contracts";
import {
  type DocumentBlock,
  type DocumentEditor,
  documentBlocks,
  supportsDocumentMarkdown,
} from "./document-editor";
import { documentSlash, filterDocumentBlocks } from "./document-slash";
import { editorCommandHeight, editorPopoverPosition } from "./editor-popover-position";
import { editorTextRectangles } from "./editor-text-rectangles";
import { markdownHTML } from "./markdown";
import { RequirementDocument } from "./requirement-document";
import { RichDocumentSurface } from "./rich-document-surface";
import { sourceReviewURL } from "./source-review";
import { TicketChecks } from "./ticket-checks";
import { TicketDependencies, type TicketDependenciesProps } from "./ticket-dependencies";
import { TicketSecondaryActions } from "./ticket-secondary-actions";
import { VersionHistory } from "./version-history";

type TicketView = {
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

type RequirementRevisionView = {
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
type TicketDocumentRevisionView = RequirementRevisionView & {
  title: string;
  description: string;
  requirementRevisionId: string | null;
};

type ChangeView = {
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

type DeliveryView = import("./ticket-checks").TicketCheckDetails & {
  pullRequestNumber?: number | undefined;
  pullRequestUrl?: string | undefined;
  pullRequestState?: string | undefined;
  verificationState?: string | undefined;
  verificationSummary?: string | undefined;
  actionRunUrl?: string | undefined;
  approvedAt?: string | undefined;
  mergeState?: string | undefined;
  promotionState?: string | undefined;
  cleanupError?: string | undefined;
  replacementRuntimeState?: string | undefined;
};

export type TicketEdit = Pick<TicketView, "title" | "description">;

export type TicketDraft = TicketEdit & {
  requirement: RequirementContent;
  expectedVersion?: number;
  expectedDocumentId?: string | null;
  requirementRevisionId?: string | null;
  proposalEntryId?: string | undefined;
};

export type TicketWorkspaceProps = {
  current: {
    ticket: TicketView;
    revisions: RequirementRevisionView[];
    documentRevisions: TicketDocumentRevisionView[];
    origin: { id: string; title: string } | null;
    followUps: Array<{ id: string; title: string }>;
    proposal?: RequirementProposal | null;
  };
  ticketReference: string;
  storageKey: string;
  change?: ChangeView | undefined;
  delivery?: DeliveryView | undefined;
  latestRevision?: RequirementRevisionView | undefined;
  latestRequirement?: RequirementContent | undefined;
  pending: boolean;
  buildInProgress?: boolean;
  epics: readonly Epic[];
  dependencies: TicketDependenciesProps;
  onAssignEpic(epicId: string | null): void;
  drafts: Map<string, TicketDraft>;
  onInterview(): void;
  onWriteRequirements(): void;
  onSaveDocument(input: TicketDraft): Promise<TicketDocumentSave | undefined>;
  onConfirmRequirements(input: TicketDraft): Promise<TicketDocumentSave | undefined>;
  clarificationAction: { label: string; status: boolean };
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
  onOpenIDE(): void;
  onApproveDelivery(changeID: string): void;
  onRetryReview?(changeID: string): void;
  onResumeChecks?(changeID: string): void;
  canDevelop: boolean;
  onRequestChanges(): void;
};

type EditorField = "title" | "description" | "summary" | "acceptance" | "non-goal";
type SlashBlock = "acceptance" | "non-goal" | DocumentBlock;
const slashBlocks = [
  ...documentBlocks,
  { id: "acceptance", label: "Acceptance criterion" },
  { id: "non-goal", label: "Non-goal" },
] as const;
type SelectionToolbar = { element: HTMLElement; range: Range };
type SlashMenu = SelectionToolbar & { query: string; length: number };
type DraftBlock = {
  id: string;
  value(): string;
  setValue(value: string): void;
};

function createDraftBlock(value: string): DraftBlock {
  const [blockValue, setBlockValue] = createSignal(value);
  return { id: crypto.randomUUID(), value: blockValue, setValue: setBlockValue };
}

function parseRequirement(revision: RequirementRevisionView) {
  try {
    const parsed = ticketDocumentInput.shape.requirement.safeParse(
      JSON.parse(revision.canonicalContent),
    );
    return parsed.success ? (parsed.data ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

function normalizedRequirement(content: RequirementContent): RequirementContent {
  return {
    summary: content.summary.trim(),
    acceptanceCriteria: content.acceptanceCriteria.map((value) => value.trim()).filter(Boolean),
    nonGoals: content.nonGoals.map((value) => value.trim()).filter(Boolean),
  };
}

function sameRequirement(left: RequirementContent, right: RequirementContent) {
  return (
    JSON.stringify(normalizedRequirement(left)) === JSON.stringify(normalizedRequirement(right))
  );
}

type TextSurfaceProps = {
  value: string;
  label: string;
  field: EditorField;
  editable: boolean;
  plain?: boolean;
  placeholder?: string;
  class: string;
  onElement?(element: HTMLElement): void;
  onEditor?(element: HTMLElement, handle: DocumentEditor): void;
  onFocus(element: HTMLElement): void;
  onInput(value: string, element: HTMLElement): void;
  onKeyDown(event: KeyboardEvent, element: HTMLElement): void;
  onSelection(element: HTMLElement): void;
};

function RichTextSurface(props: TextSurfaceProps) {
  let editor: HTMLElement | undefined;
  const sourceMode = () => !props.plain && !supportsDocumentMarkdown(props.value);

  function writeValue(element: HTMLElement, value: string) {
    element.textContent = value;
  }

  function readValue(element: HTMLElement) {
    return element.textContent ?? "";
  }

  createEffect(
    () => props.value,
    (value) => {
      if (editor && document.activeElement !== editor) writeValue(editor, value);
    },
  );

  return (
    <Show
      when={sourceMode()}
      fallback={
        <Show when={props.plain} fallback={<RichDocumentSurface {...props} />}>
          {/* biome-ignore lint/a11y: Inline title editing retains its document typography. Solid's lowercase tabindex makes this textbox keyboard focusable. */}
          <div
            ref={(element) => {
              editor = element;
              writeValue(element, props.value);
              props.onElement?.(element);
            }}
            class={`${props.class}${props.editable ? " inline-editor-surface" : ""}`}
            contenteditable={props.editable ? (props.plain ? "plaintext-only" : "true") : "false"}
            role="textbox"
            tabindex="0"
            aria-label={props.label}
            aria-readonly={props.editable ? "false" : "true"}
            aria-multiline={props.plain ? "false" : "true"}
            data-field={props.field}
            data-placeholder={props.placeholder}
            spellcheck="true"
            onFocus={(event) => props.onFocus(event.currentTarget)}
            onInput={(event) => props.onInput(readValue(event.currentTarget), event.currentTarget)}
            onKeyDown={(event) => props.onKeyDown(event, event.currentTarget)}
            onKeyUp={(event) => {
              if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
                props.onSelection(event.currentTarget);
              }
            }}
            onMouseUp={(event) => props.onSelection(event.currentTarget)}
          />
        </Show>
      }
    >
      <div class="inline-source-field">
        <p class="inline-source-notice">Advanced Markdown stays in source format.</p>
        <textarea
          class="inline-markdown-source"
          aria-label={props.label}
          data-field={props.field}
          rows={Math.min(12, Math.max(4, props.value.split("\n").length))}
          value={props.value}
          readonly={!props.editable}
          onFocus={(event) => props.editable && props.onFocus(event.currentTarget)}
          onInput={(event) => props.onInput(event.currentTarget.value, event.currentTarget)}
          onKeyDown={(event) => props.onKeyDown(event, event.currentTarget)}
        />
      </div>
    </Show>
  );
}

export function TicketWorkspace(props: TicketWorkspaceProps) {
  const [editing, setEditing] = createSignal(false);
  const [draftTitle, setDraftTitle] = createSignal(props.current.ticket.title);
  const [draftDescription, setDraftDescription] = createSignal(props.current.ticket.description);
  const [draftSummary, setDraftSummary] = createSignal("");
  const [draftAcceptance, setDraftAcceptance] = createSignal<DraftBlock[]>([createDraftBlock("")]);
  const [draftNonGoals, setDraftNonGoals] = createSignal<DraftBlock[]>([createDraftBlock("")]);
  const [selectionToolbar, setSelectionToolbar] = createSignal<SelectionToolbar>();
  const [slashMenu, setSlashMenu] = createSignal<SlashMenu>();
  const [slashIndex, setSlashIndex] = createSignal(0);
  const filteredSlashBlocks = () => filterDocumentBlocks(slashBlocks, slashMenu()?.query ?? "");
  const [linkEditing, setLinkEditing] = createSignal(false);
  const [editorError, setEditorError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let baseVersion = props.current.ticket.version;
  let baseDocumentID: string | null = props.current.documentRevisions[0]?.id ?? null;
  let baseRequirementRevisionID: string | null = props.latestRevision?.id ?? null;
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const proposal = () =>
    props.current.proposal?.base.version === props.current.ticket.version
      ? props.current.proposal
      : undefined;
  const separateSummary = () =>
    Boolean((props.latestRevision || proposal()) && draftSummary() !== draftDescription());
  const [historyRevisionID, setHistoryRevisionID] = createSignal<string>();
  const versions = () => [
    ...props.current.documentRevisions,
    ...props.current.revisions.filter(
      (revision) =>
        !props.current.documentRevisions.some(
          (document) =>
            document.requirementRevisionId === revision.id &&
            document.canonicalContent === revision.canonicalContent,
        ),
    ),
  ];
  const historicalRevision = () =>
    versions().find((revision) => revision.id === historyRevisionID());
  const currentDocument = () => props.current.documentRevisions[0];
  const [dismissedDocumentID, setDismissedDocumentID] = createSignal<string>();
  const implementationRevision = () =>
    props.current.revisions.find(
      (revision) =>
        revision.approvalId === props.change?.requirementApprovalId && revision.approvalId,
    );
  const documentNotice = () =>
    Boolean(props.change) &&
    currentDocument() &&
    Boolean(implementationRevision()?.approvedAt) &&
    Date.parse(currentDocument()?.createdAt ?? "") >
      Date.parse(implementationRevision()?.approvedAt ?? "") &&
    currentDocument()?.id !== dismissedDocumentID();
  function dismissDocumentNotice() {
    const id = currentDocument()?.id;
    setDismissedDocumentID(id);
    try {
      if (id) sessionStorage.setItem(`document-notice:${props.current.ticket.id}`, id);
    } catch {
      // Dismissal still works for this view when browser storage is unavailable.
    }
  }
  createEffect(
    () => props.current.ticket.id,
    (ticketID, previousID) => {
      if (ticketID === previousID) return;
      setHistoryOpen(false);
      setHistoryRevisionID(undefined);
      setDismissedDocumentID(undefined);
      try {
        setDismissedDocumentID(
          sessionStorage.getItem(`document-notice:${props.current.ticket.id}`) ?? undefined,
        );
      } catch {
        // Storage availability does not govern document access.
      }
    },
  );
  function closeHistory() {
    setHistoryOpen(false);
    setHistoryRevisionID(undefined);
  }
  let documentElement: HTMLElement | undefined;
  let requestDetailsElement: HTMLDetailsElement | undefined;
  let linkInput: HTMLInputElement | undefined;
  const [formattingElement, setFormattingElement] = createSignal<HTMLDivElement>();
  const [commandElement, setCommandElement] = createSignal<HTMLDivElement>();
  const [popoverShelfHeight, setPopoverShelfHeight] = createSignal(0);
  let shelfElement: HTMLElement | undefined;
  const acceptanceElements = new Map<number, HTMLElement>();
  const nonGoalElements = new Map<number, HTMLElement>();
  const editors = new WeakMap<HTMLElement, DocumentEditor>();
  let draftKey: string | undefined;

  function retainDraft() {
    if (!draftKey) return;
    if (editing())
      props.drafts.set(draftKey, {
        title: draftTitle(),
        description: draftDescription(),
        expectedVersion: baseVersion,
        expectedDocumentId: baseDocumentID,
        requirementRevisionId: baseRequirementRevisionID,
        ...(proposal() ? { proposalEntryId: proposal()?.id } : {}),
        requirement: {
          summary: draftSummary(),
          acceptanceCriteria: draftAcceptance().map((block) => block.value()),
          nonGoals: draftNonGoals().map((block) => block.value()),
        },
      });
    else props.drafts.delete(draftKey);
    try {
      const draft = props.drafts.get(draftKey);
      if (draft) localStorage.setItem(props.storageKey, JSON.stringify(draft));
      else localStorage.removeItem(props.storageKey);
    } catch {
      /* In-memory draft remains available if browser storage is unavailable. */
    }
  }
  onCleanup(() => {
    clearTimeout(autosaveTimer);
    retainDraft();
  });

  const canEditSpecification = () =>
    !props.current.ticket.trashedAt &&
    !props.current.ticket.convertedToEpicId &&
    props.current.ticket.state !== "cancelled";
  const effectiveStatus = () =>
    ticketBoardStatus({
      ticketState: props.current.ticket.state,
      changeState: props.change?.state,
      verificationState: props.change?.verificationState,
      buildTurnState: props.buildInProgress ? "running" : props.change?.buildTurnState,
      buildTurnPurpose: props.change?.buildTurnPurpose,
      implementationState: props.change?.implementationState,
    });
  const implementationBusy = () =>
    props.buildInProgress ||
    ["pending", "dispatching", "running"].includes(props.change?.buildTurnState ?? "") ||
    ["starting", "working"].includes(props.change?.implementationState ?? "");
  const implementationPreparing = () =>
    props.change?.buildTurnPurpose !== "review" &&
    props.change?.buildTurnState !== "running" &&
    props.change?.implementationState !== "working" &&
    (["branch-pending", "starting"].includes(props.change?.state ?? "") ||
      props.change?.buildTurnState === "pending" ||
      props.change?.implementationState === "starting");
  const canDeliver = () =>
    !props.current.ticket.trashedAt &&
    props.canDevelop &&
    props.change?.state === "active" &&
    props.change.implementationState === "committed" &&
    !implementationBusy() &&
    props.delivery?.verificationState === "succeeded" &&
    props.delivery?.reviewState === "passed" &&
    !props.delivery.approvedAt;
  const nextRevisionOrdinal = () =>
    (currentDocument()?.ordinal ?? props.latestRevision?.ordinal ?? 0) + 1;
  const originalRequirement = (): RequirementContent =>
    (currentDocument() ? parseRequirement(currentDocument()!) : props.latestRequirement) ?? {
      summary: props.current.ticket.description,
      acceptanceCriteria: [],
      nonGoals: [],
    };
  const currentRequirement = (): RequirementContent =>
    normalizedRequirement({
      summary: draftSummary(),
      acceptanceCriteria: draftAcceptance().map((block) => block.value()),
      nonGoals: draftNonGoals().map((block) => block.value()),
    });
  const planningChanged = () =>
    draftTitle().trim() !== props.current.ticket.title ||
    draftDescription().trim() !== props.current.ticket.description;
  const specificationChanged = () =>
    canEditSpecification() && !sameRequirement(currentRequirement(), originalRequirement());
  const hasChanges = () => planningChanged() || specificationChanged();

  function resetDrafts() {
    const requirement = proposal()?.requirement ?? originalRequirement();
    setDraftTitle(proposal()?.ticket.title ?? props.current.ticket.title);
    setDraftDescription(proposal()?.ticket.description ?? props.current.ticket.description);
    setDraftSummary(requirement.summary);
    setDraftAcceptance(
      (requirement.acceptanceCriteria.length ? requirement.acceptanceCriteria : [""]).map(
        createDraftBlock,
      ),
    );
    setDraftNonGoals(
      (requirement.nonGoals.length ? requirement.nonGoals : [""]).map(createDraftBlock),
    );
    setEditorError("");
  }

  createEffect(
    () => props.current.ticket.id,
    (key) => {
      if (key === draftKey) return;
      retainDraft();
      draftKey = key;
      let draft = props.drafts.get(key);
      if (!draft) {
        try {
          const value = JSON.parse(
            localStorage.getItem(props.storageKey) ?? "null",
          ) as TicketDraft | null;
          if (
            value &&
            typeof value.title === "string" &&
            typeof value.description === "string" &&
            value.requirement &&
            Array.isArray(value.requirement.acceptanceCriteria) &&
            Array.isArray(value.requirement.nonGoals)
          )
            draft = value;
        } catch {
          /* Ignore invalid user-local draft storage without affecting saved work. */
        }
      }
      baseVersion = draft?.expectedVersion ?? props.current.ticket.version;
      baseDocumentID =
        draft?.expectedDocumentId === undefined
          ? (currentDocument()?.id ?? null)
          : draft.expectedDocumentId;
      baseRequirementRevisionID =
        draft?.requirementRevisionId === undefined
          ? (props.latestRevision?.id ?? null)
          : draft.requirementRevisionId;
      setEditing(!!draft);
      if (draft) {
        setDraftTitle(draft.title);
        setDraftDescription(draft.description);
        setDraftSummary(draft.requirement.summary);
        setDraftAcceptance(draft.requirement.acceptanceCriteria.map(createDraftBlock));
        setDraftNonGoals(draft.requirement.nonGoals.map(createDraftBlock));
      } else resetDrafts();
      if (draft && draft.proposalEntryId !== proposal()?.id) {
        props.drafts.delete(key);
        setEditing(false);
        resetDrafts();
      }
      if (draft && !proposal()) onSettled(scheduleAutosave);
      setSelectionToolbar(undefined);
      setSlashMenu(undefined);
    },
  );

  createEffect(
    () => ({ ticketID: props.current.ticket.id, proposalID: proposal()?.id }),
    (current, previous) => {
      // The Ticket effect owns initial restoration. Solid 2 batches its draft
      // writes, so these effects must not replace them during the same settle.
      if (
        !previous ||
        current.ticketID !== previous.ticketID ||
        current.proposalID === previous.proposalID
      )
        return;
      const retained = draftKey ? props.drafts.get(draftKey) : undefined;
      if (retained && retained.proposalEntryId === proposal()?.id) return;
      if (editing() && !proposal()) return;
      clearTimeout(autosaveTimer);
      setEditing(false);
      resetDrafts();
    },
  );

  createEffect(
    () => ({ ticketID: props.current.ticket.id, version: props.current.ticket.version }),
    (current, previous) => {
      if (
        !previous ||
        current.ticketID !== previous.ticketID ||
        current.version === previous.version
      )
        return;
      if (saving() || (editing() && hasChanges())) return;
      baseVersion = props.current.ticket.version;
      baseDocumentID = currentDocument()?.id ?? null;
      baseRequirementRevisionID = props.latestRevision?.id ?? null;
      resetDrafts();
    },
  );

  function scheduleAutosave() {
    retainDraft();
    clearTimeout(autosaveTimer);
    if (proposal()) return;
    autosaveTimer = setTimeout(() => void saveChanges(), 650);
  }

  function beginEditing() {
    setEditing(true);
    setEditorError("");
  }

  function cancelEditing() {
    retainDraft();
    setSelectionToolbar(undefined);
    setSlashMenu(undefined);
    setLinkEditing(false);
    queueMicrotask(() => documentElement?.focus());
  }

  function placePopover(element: HTMLElement | undefined, anchor: Range, preferBelow: boolean) {
    const documentRoot = documentElement;
    const root = documentRoot?.closest(".ticket-editor-frame")?.getBoundingClientRect();
    const viewport = documentElement?.closest(".ticket-workspace")?.getBoundingClientRect();
    if (!element?.isConnected || !documentRoot || !root || !viewport) return;
    const gap = Number.parseFloat(getComputedStyle(element).getPropertyValue("--space-2"));
    const anchorBounds = anchor.getBoundingClientRect();
    const bounds = {
      left: Math.max(viewport.left, 0) + gap,
      right: Math.min(viewport.right, innerWidth) - gap,
      top: Math.max(viewport.top, 0) + gap,
      bottom: Math.min(viewport.bottom, innerHeight) - gap,
    };
    if (preferBelow)
      element.style.maxHeight = `${editorCommandHeight(anchorBounds, bounds, gap, Number.parseFloat(getComputedStyle(element).getPropertyValue("--space-12")) * 2)}px`;
    const size = element.getBoundingClientRect();
    const position = editorPopoverPosition({
      anchor: anchorBounds,
      bounds,
      width: size.width,
      height: size.height,
      gap,
      preferBelow,
      // Slash commands stay at the insertion point. Selection formatting still
      // protects adjacent text instead of covering the passage being edited.
      avoid: preferBelow ? [] : editorTextRectangles(documentRoot, viewport),
    });
    if (!position || shelfElement === element) {
      // Reserve real layout space until this control closes. Re-evaluating the reduced
      // viewport must not alternate between floating and reserved placement.
      shelfElement = element;
      setPopoverShelfHeight(size.height + 2 * gap);
      const left = Math.max(bounds.left, Math.min(anchorBounds.left, bounds.right - size.width));
      element.style.left = `${left - root.left}px`;
      element.style.top = `${gap}px`;
      element.setAttribute("data-placement", "reserved");
    } else {
      element.style.left = `${position.left - root.left}px`;
      element.style.top = `${position.top - root.top}px`;
      element.setAttribute("data-placement", "floating");
    }
    element.setAttribute("data-positioned", "true");
  }

  createEffect(
    () => ({
      toolbar: selectionToolbar(),
      menu: slashMenu(),
      link: linkEditing(),
      formatting: formattingElement(),
      command: commandElement(),
    }),
    (state) => {
      if (!state.toolbar && !state.menu) {
        shelfElement = undefined;
        setPopoverShelfHeight(0);
        return;
      }
      const activeFormatting = state.toolbar ? state.formatting : undefined;
      const activeCommand = state.menu ? state.command : undefined;
      if (shelfElement && shelfElement !== activeFormatting && shelfElement !== activeCommand) {
        shelfElement = undefined;
        setPopoverShelfHeight(0);
      }
      let disposed = false;
      const position = () => {
        if (disposed) return;
        if (state.toolbar) placePopover(state.formatting, state.toolbar.range, false);
        if (state.menu) placePopover(state.command, state.menu.range, true);
      };
      const viewport = documentElement?.closest(".ticket-workspace");
      const observer = new ResizeObserver(position);
      if (state.toolbar && state.formatting) observer.observe(state.formatting);
      if (state.menu && state.command) observer.observe(state.command);
      if (viewport) observer.observe(viewport);
      viewport?.addEventListener("scroll", position);
      window.addEventListener("resize", position);
      queueMicrotask(position);
      return () => {
        disposed = true;
        observer.disconnect();
        viewport?.removeEventListener("scroll", position);
        window.removeEventListener("resize", position);
      };
    },
  );

  function updateSelectionToolbar(element: HTMLElement) {
    if (element.getAttribute("contenteditable") !== "true") {
      setSelectionToolbar(undefined);
      return;
    }
    const selection = window.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed ||
      !element.contains(selection.anchorNode)
    ) {
      if (!linkEditing()) setSelectionToolbar(undefined);
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    setSelectionToolbar({ element, range });
    setSlashMenu(undefined);
  }

  function restoreSelection(range: Range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function syncSurface(element: HTMLElement) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatBackColor" }));
  }

  function applyFormat(command: "bold" | "italic") {
    const toolbar = selectionToolbar();
    if (!toolbar) return;
    editors.get(toolbar.element)?.format(command, toolbar.range);
    setSelectionToolbar(undefined);
  }

  function startLinkEditing() {
    setLinkEditing(true);
    queueMicrotask(() => linkInput?.focus({ preventScroll: true }));
  }

  function applyLink() {
    const toolbar = selectionToolbar();
    const value = linkInput?.value.trim();
    if (!toolbar || !value) return;
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported protocol");
    } catch {
      setEditorError("Enter a valid web address.");
      return;
    }
    editors.get(toolbar.element)?.link(url, toolbar.range);
    setLinkEditing(false);
    setSelectionToolbar(undefined);
  }

  function slashRange(element: HTMLElement) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    if (
      container.nodeType !== Node.TEXT_NODE ||
      !element.contains(container) ||
      range.startOffset < 1
    ) {
      return;
    }
    const token = documentSlash((container.textContent ?? "").slice(0, range.startOffset));
    if (token) return { range: range.cloneRange(), ...token };
  }

  function updateSlashMenu(element: HTMLElement) {
    const command = slashRange(element);
    if (!command) {
      setSlashMenu(undefined);
      return;
    }
    setSlashIndex(0);
    setSlashMenu({ element, ...command });
    setSelectionToolbar(undefined);
  }

  function removeSlash(menu: SlashMenu) {
    const handle = editors.get(menu.element);
    if (handle) {
      handle.removeSlash();
      return;
    }
    const container = menu.range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || menu.range.startOffset < 1) return;
    const text = container as Text;
    const nextOffset = menu.range.startOffset - menu.length;
    if (text.data.at(nextOffset) !== "/") return;
    text.deleteData(nextOffset, menu.length);
    menu.range.setStart(text, nextOffset);
    menu.range.collapse(true);
    restoreSelection(menu.range);
    syncSurface(menu.element);
  }

  function insertSpecificationBlock(block: SlashBlock) {
    const menu = slashMenu();
    if (!menu) return;
    removeSlash(menu);
    setSlashMenu(undefined);
    if (block !== "acceptance" && block !== "non-goal") {
      editors.get(menu.element)?.format(block);
      return;
    }
    if (block === "acceptance") {
      const nextIndex = draftAcceptance().length;
      setDraftAcceptance((items) => [...items, createDraftBlock("")]);
      queueMicrotask(() => acceptanceElements.get(nextIndex)?.focus());
    } else {
      const nextIndex = draftNonGoals().length;
      setDraftNonGoals((items) => [...items, createDraftBlock("")]);
      queueMicrotask(() => nonGoalElements.get(nextIndex)?.focus());
    }
  }

  function editorKeyDown(event: KeyboardEvent, element: HTMLElement) {
    const menu = slashMenu();
    if (menu?.element === element) {
      const options = filteredSlashBlocks();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!options.length) return;
        setSlashIndex((index) =>
          event.key === "ArrowDown"
            ? (index + 1) % options.length
            : (index - 1 + options.length) % options.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const block = options[slashIndex()];
        if (block) insertSpecificationBlock(block.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenu(undefined);
        return;
      }
    }
    if (element.getAttribute("data-field") === "title" && event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && hasChanges()) {
      event.preventDefault();
      void saveChanges();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
  }

  function richTextHandlers(options: {
    field: EditorField;
    slash?: boolean;
    update(value: string): void;
  }) {
    return {
      onFocus: () => beginEditing(),
      onInput: (value: string, element: HTMLElement) => {
        // Autosave can acknowledge the previous draft while the field stays focused.
        // Every new edit must regain draft protection before a server revision arrives.
        beginEditing();
        options.update(value);
        // Solid 2 commits signal writes at the microtask boundary. Persist the new
        // draft after that commit rather than reading the previous keystroke.
        onSettled(() => {
          scheduleAutosave();
          if (options.slash) updateSlashMenu(element);
        });
      },
      onKeyDown: editorKeyDown,
      onSelection: updateSelectionToolbar,
      onEditor: (element: HTMLElement, handle: DocumentEditor) => editors.set(element, handle),
    };
  }

  async function saveChanges() {
    if (saving() || proposal() || !hasChanges()) return;
    const key = draftKey;
    const ticketID = props.current.ticket.id;
    setEditorError("");
    const title = draftTitle().trim();
    if (!title) {
      setEditorError("A ticket title is required.");
      return;
    }
    const requirement = currentRequirement();
    const snapshot = { title, description: draftDescription().trim(), requirement };
    setSaving(true);
    let saved: TicketDocumentSave | undefined;
    try {
      saved = await props.onSaveDocument({
        ...snapshot,
        expectedVersion: baseVersion,
        expectedDocumentId: baseDocumentID,
        requirementRevisionId: baseRequirementRevisionID,
      });
    } finally {
      setSaving(false);
    }
    if (!saved) {
      setEditorError(
        "Could not save. Your draft is retained; check the connection or changes made elsewhere.",
      );
      retainDraft();
      return;
    }
    if (props.current.ticket.id !== ticketID) return;
    baseVersion = saved.ticketVersion;
    baseDocumentID = saved.id;
    baseRequirementRevisionID = saved.requirementRevisionId;
    if (
      JSON.stringify(snapshot) !==
      JSON.stringify({
        title: draftTitle().trim(),
        description: draftDescription().trim(),
        requirement: currentRequirement(),
      })
    ) {
      scheduleAutosave();
      return;
    }
    if (key) props.drafts.delete(key);
    if (draftKey !== key) return;
    setEditing(false);
    retainDraft();
  }

  async function confirmProposal() {
    clearTimeout(autosaveTimer);
    const ticketID = props.current.ticket.id;
    const parsed = ticketDocumentInput.safeParse({
      commandId: crypto.randomUUID(),
      expectedVersion: proposal()?.base.version,
      expectedDocumentId: proposal()?.base.documentId,
      requirementRevisionId: proposal()?.base.revisionId,
      title: draftTitle().trim(),
      description: draftDescription().trim(),
      requirement: currentRequirement(),
    });
    if (!parsed.success) {
      setEditorError("Give the Ticket a title and keep its content within the supported limits.");
      return;
    }
    setSaving(true);
    const snapshot = {
      title: parsed.data.title,
      description: parsed.data.description,
      requirement: parsed.data.requirement,
    };
    try {
      const saved = await props.onConfirmRequirements({
        title: parsed.data.title,
        description: parsed.data.description,
        requirement: currentRequirement(),
      });
      if (saved && props.current.ticket.id === ticketID) {
        baseVersion = saved.ticketVersion;
        baseDocumentID = saved.id;
        baseRequirementRevisionID = saved.requirementRevisionId;
        if (
          JSON.stringify(snapshot) !==
          JSON.stringify({
            title: draftTitle().trim(),
            description: draftDescription().trim(),
            requirement: currentRequirement(),
          })
        ) {
          scheduleAutosave();
        } else {
          setEditing(false);
          retainDraft();
        }
      }
    } finally {
      setSaving(false);
    }
  }

  const canImplement = () =>
    Boolean(
      !props.current.ticket.trashedAt &&
        !props.current.ticket.convertedToEpicId &&
        props.current.ticket.state === "ready" &&
        props.latestRevision &&
        !props.change &&
        !proposal(),
    );
  const implementationDisabledReason = () => {
    if (props.pending) return "Finishing the current Ticket action.";
    if (hasChanges()) return "Waiting for your requirements to save.";
    if (currentDocument() && currentDocument()?.requirementRevisionId !== props.latestRevision?.id)
      return "Complete the current requirements before starting implementation.";
    if (!props.implementationAvailable) return "Connect a Coding model in Settings first.";
    if (props.dependencies.prerequisites.some((prerequisite) => !prerequisite.delivered))
      return "Deliver the prerequisite Tickets first.";
    return undefined;
  };
  const implementationDisabled = () => Boolean(implementationDisabledReason());

  return (
    <div class={`ticket-layout${historyOpen() ? " has-inspector" : ""}`}>
      <div class="ticket-editor-frame">
        <Show when={popoverShelfHeight()}>
          {(height) => (
            <div
              class="editor-popover-shelf"
              style={{ height: `${height()}px` }}
              aria-hidden="true"
            />
          )}
        </Show>
        <div class="ticket-workspace">
          <Show when={historicalRevision()}>
            {(revision) => (
              <RequirementDocument
                title={revision().title ?? props.current.ticket.title}
                description={revision().description}
                content={parseRequirement(revision())}
                ordinal={revision().ordinal}
              />
            )}
          </Show>
          <article
            class="ticket-document"
            hidden={Boolean(historicalRevision())}
            aria-label={proposal() ? "Elaborated requirements" : "Ticket document"}
            ref={documentElement}
            tabindex="-1"
          >
            <header class="ticket-document-heading">
              <div class="ticket-status-row">
                <Show when={props.current.proposal && !proposal()}>
                  <span class="ticket-document-notice" role="status">
                    The Ticket changed. Your current text is kept; clarify again for a new proposal.
                  </span>
                </Show>
                <div class="ticket-status-context">
                  <span>{props.ticketReference}</span>
                  <span>{effectiveStatus()}</span>
                  <Show
                    when={
                      !props.change &&
                      props.current.ticket.state === "ready" &&
                      props.latestRevision
                    }
                  >
                    {(revision) => (
                      <span>
                        {revision().approvalId ? "Implementation scope" : "Ready to implement"}
                      </span>
                    )}
                  </Show>
                </div>
                <div class="ticket-header-actions">
                  <Show when={props.canDevelop && sourceReviewURL(props.delivery?.pullRequestUrl)}>
                    {(href) => (
                      <a
                        class="quiet-button"
                        aria-label="Review source changes"
                        href={href()}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Review changes
                      </a>
                    )}
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.trashedAt &&
                      props.change &&
                      props.canDevelop &&
                      !["cancelled", "cancelling", "delivered"].includes(props.change.state)
                    }
                  >
                    <button type="button" class="quiet-button" onClick={props.onOpenIDE}>
                      Open IDE
                    </button>
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.trashedAt &&
                      props.change?.state === "active" &&
                      props.change.implementationState === "committed" &&
                      !implementationBusy()
                    }
                  >
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={props.pending}
                      onClick={props.onRequestChanges}
                    >
                      Request changes
                    </button>
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.trashedAt &&
                      !props.current.ticket.convertedToEpicId &&
                      ["inbox", "backlog"].includes(props.current.ticket.state) &&
                      !props.change &&
                      !proposal()
                    }
                  >
                    <button
                      type="button"
                      class="primary-button"
                      disabled={props.pending || saving() || hasChanges()}
                      onClick={props.onWriteRequirements}
                    >
                      Write requirements
                    </button>
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.trashedAt &&
                      !props.current.ticket.convertedToEpicId &&
                      !props.latestRevision?.approvalId &&
                      !props.change &&
                      !proposal()
                    }
                  >
                    <Show
                      when={!props.clarificationAction.status}
                      fallback={
                        <span class="clarification-status" role="status">
                          {props.clarificationAction.label}
                        </span>
                      }
                    >
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={hasChanges()}
                        onClick={props.onInterview}
                      >
                        {props.clarificationAction.label}
                      </button>
                    </Show>
                  </Show>
                  <Show when={props.current.ticket.convertedToEpicId}>
                    <button
                      type="button"
                      class="quiet-button"
                      onClick={() => {
                        const id = props.current.ticket.convertedToEpicId;
                        if (id) props.onOpenEpic(id);
                      }}
                    >
                      Open Epic
                    </button>
                  </Show>
                  <Show when={proposal()}>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={
                        props.pending ||
                        saving() ||
                        proposal()?.base.version !== props.current.ticket.version
                      }
                      onClick={() => void confirmProposal()}
                    >
                      Confirm answers
                    </button>
                  </Show>
                  <Show when={props.current.ticket.trashedAt}>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={props.pending || Boolean(props.current.ticket.trashStopPending)}
                      onClick={props.onRestore}
                    >
                      Restore
                    </button>
                  </Show>
                  <Show when={canDeliver()}>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={props.pending}
                      onClick={() => props.change && props.onApproveDelivery(props.change.id)}
                    >
                      Deliver
                    </button>
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.trashedAt &&
                      props.canDevelop &&
                      props.delivery?.checksStopId &&
                      props.onResumeChecks
                    }
                  >
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={props.pending}
                      onClick={() => props.change && props.onResumeChecks?.(props.change.id)}
                    >
                      Resume checks
                    </button>
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.trashedAt &&
                      props.change?.state === "active" &&
                      !implementationBusy() &&
                      !props.codingPause &&
                      ["incomplete", "failed", "stopped"].includes(
                        props.delivery?.reviewState ?? "",
                      ) &&
                      props.onRetryReview
                    }
                  >
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={props.pending}
                      onClick={() => props.change && props.onRetryReview?.(props.change.id)}
                    >
                      Retry review
                    </button>
                  </Show>
                  <Show
                    when={!props.current.ticket.trashedAt && props.change?.state === "delivered"}
                  >
                    <button
                      type="button"
                      class="primary-button"
                      disabled={props.pending || hasChanges()}
                      onClick={props.onFollowUp}
                    >
                      Create follow-up
                    </button>
                  </Show>
                  <Show when={canImplement() && !props.codingOptionsOpen}>
                    <button
                      type="button"
                      class="primary-button"
                      disabled={implementationDisabled()}
                      title={implementationDisabledReason()}
                      onClick={() =>
                        props.latestRevision && props.onImplement(props.latestRevision.id)
                      }
                    >
                      Implement
                    </button>
                  </Show>
                  <Show
                    when={
                      !props.current.ticket.convertedToEpicId ||
                      props.current.revisions.length ||
                      props.current.documentRevisions.length
                    }
                  >
                    <TicketSecondaryActions
                      onCodingOptions={
                        props.canDevelop && canImplement()
                          ? () =>
                              props.latestRevision && props.onCodingOptions(props.latestRevision.id)
                          : undefined
                      }
                      codingOptionsDisabled={implementationDisabled()}
                      converted={Boolean(props.current.ticket.convertedToEpicId)}
                      epics={props.epics}
                      epicID={props.current.ticket.epicId}
                      pending={props.pending}
                      pullRequestUrl={props.delivery?.pullRequestUrl}
                      failure={props.change?.failure}
                      cleanupError={props.delivery?.cleanupError}
                      canStop={implementationBusy()}
                      onAssignEpic={props.onAssignEpic}
                      onStop={props.onStopImplementation}
                      dependencies={props.dependencies}
                      trashed={Boolean(props.current.ticket.trashedAt)}
                      onTrash={props.onTrash}
                      historyAvailable={Boolean(
                        props.current.revisions.length || props.current.documentRevisions.length,
                      )}
                      historyOpen={historyOpen()}
                      onHistory={() => (historyOpen() ? closeHistory() : setHistoryOpen(true))}
                    />
                  </Show>
                </div>
              </div>
              <Show when={props.computeWait && !props.codingPause}>
                <p class="agent-activity-notice" role="status">
                  Waiting for execution capacity. Work starts automatically when space is available.
                  Source editing remains available.
                </p>
              </Show>
              <TicketChecks
                details={props.delivery}
                building={implementationBusy() && !props.computeWait && !props.codingPause}
                preparing={implementationPreparing()}
                unsubmitted={
                  props.change?.state === "active" &&
                  ((props.change.implementationState !== undefined &&
                    props.change.implementationState !== "committed") ||
                    ["failed", "stopped", "uncertain"].includes(props.change.buildTurnState ?? ""))
                }
              />
              <Show when={props.codingPause}>
                <div class="agent-activity-notice coding-pause-notice" role="status">
                  <span>
                    {props.codingPause?.reason === "accounting-incomplete"
                      ? "Coding paused because consumption or pricing is incomplete."
                      : "Coding paused at its allowance."}{" "}
                    Existing code is retained.
                  </span>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={
                      props.pending ||
                      ["dispatching", "running"].includes(props.change?.buildTurnState ?? "")
                    }
                    onClick={() => props.onResumeCoding?.()}
                  >
                    Resume implementation
                  </button>
                </div>
              </Show>
              <Show when={props.current.origin}>
                {(origin) => (
                  <button
                    type="button"
                    class="ticket-related-link"
                    onClick={() => props.onOpenTicket(origin().id)}
                  >
                    Follow-up to {origin().title}
                  </button>
                )}
              </Show>
              <For each={props.current.followUps}>
                {(ticket) => (
                  <button
                    type="button"
                    class="ticket-related-link"
                    onClick={() => props.onOpenTicket(ticket.id)}
                  >
                    {ticket.title}
                  </button>
                )}
              </For>
              <Show when={documentNotice()}>
                <div class="ticket-document-notice" role="status">
                  <button
                    type="button"
                    onClick={() => {
                      setHistoryOpen(true);
                      setHistoryRevisionID(currentDocument()?.id);
                    }}
                  >
                    Document updated since implementation
                  </button>
                  <button
                    type="button"
                    class="bare-icon"
                    aria-label="Dismiss document update"
                    onClick={dismissDocumentNotice}
                  >
                    ×
                  </button>
                </div>
              </Show>
              <RichTextSurface
                value={draftTitle()}
                label="Ticket title"
                field="title"
                editable={canEditSpecification()}
                plain={true}
                placeholder="Untitled ticket"
                class="ticket-inline-title"
                {...richTextHandlers({ field: "title", update: setDraftTitle })}
              />
              <details
                class="ticket-request-details"
                ref={requestDetailsElement}
                open={
                  !separateSummary() ||
                  Boolean(requestDetailsElement?.contains(document.activeElement))
                }
              >
                <summary hidden={!separateSummary()}>Request details</summary>
                {/* Keep the editor mounted and never fold focused text when a proposal arrives. */}
                <RichTextSurface
                  value={draftDescription()}
                  label="Ticket description"
                  field="description"
                  editable={canEditSpecification()}
                  placeholder="Add planning context"
                  class="ticket-inline-description markdown-body"
                  {...richTextHandlers({
                    field: "description",
                    slash: true,
                    update: setDraftDescription,
                  })}
                />
              </details>
              <Show when={separateSummary()}>
                <RichTextSurface
                  value={draftSummary()}
                  label="Specification summary"
                  field="summary"
                  editable={canEditSpecification()}
                  placeholder="Describe the intended product change. Type / for blocks."
                  class="ticket-inline-description ticket-specification-summary markdown-body"
                  {...richTextHandlers({ field: "summary", slash: true, update: setDraftSummary })}
                />
              </Show>
            </header>

            <TicketDependencies {...props.dependencies} />

            <Show
              when={props.latestRevision || proposal() || props.current.ticket.state === "ready"}
            >
              <section class="spec-section revision-section" aria-label="Specification">
                <div
                  class={`specification-document ${canEditSpecification() ? "editable" : "locked"}`}
                >
                  <div class="specification-block">
                    <h4>Acceptance criteria</h4>
                    <div class="criteria-list specification-block-list">
                      <For each={draftAcceptance()}>
                        {(criterion, index) => (
                          <div class="specification-list-item acceptance-item">
                            <span class="requirement-marker" aria-hidden="true">
                              ·
                            </span>
                            <RichTextSurface
                              value={criterion.value()}
                              label={`Acceptance criterion ${index() + 1}`}
                              field="acceptance"
                              editable={canEditSpecification()}
                              placeholder="Add a verifiable outcome"
                              class="specification-rich-text markdown-body"
                              onElement={(element) => acceptanceElements.set(index(), element)}
                              {...richTextHandlers({
                                field: "acceptance",
                                slash: true,
                                update: criterion.setValue,
                              })}
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                  <Show when={draftNonGoals().some((block) => block.value().trim()) || editing()}>
                    <div class="specification-block">
                      <h4>Out of scope</h4>
                      <div class="plain-list specification-block-list">
                        <For each={draftNonGoals()}>
                          {(nonGoal, index) => (
                            <div class="specification-list-item non-goal-item">
                              <span aria-hidden="true">·</span>
                              <RichTextSurface
                                value={nonGoal.value()}
                                label={`Non-goal ${index() + 1}`}
                                field="non-goal"
                                editable={canEditSpecification()}
                                placeholder="Add an explicit exclusion"
                                class="specification-rich-text markdown-body"
                                onElement={(element) => nonGoalElements.set(index(), element)}
                                {...richTextHandlers({
                                  field: "non-goal",
                                  slash: true,
                                  update: nonGoal.setValue,
                                })}
                              />
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>
              </section>
            </Show>

            <Show when={saving() || (editing() && hasChanges())}>
              <div class="ticket-editor-actions">
                <span role="status">
                  {saving()
                    ? "Saving…"
                    : editorError()
                      ? "Draft retained"
                      : "Changes will save automatically"}
                </span>
              </div>
            </Show>
            <Show when={editorError()}>
              <p class="inline-error" role="alert">
                {editorError()}
              </p>
            </Show>
          </article>
        </div>

        <Show when={selectionToolbar()}>
          {(_toolbar) => (
            <div
              ref={setFormattingElement}
              class="selection-toolbar"
              role="toolbar"
              aria-label="Text formatting"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                const toolbar = selectionToolbar();
                setSelectionToolbar(undefined);
                setLinkEditing(false);
                if (toolbar) {
                  toolbar.element.focus({ preventScroll: true });
                  restoreSelection(toolbar.range);
                }
              }}
            >
              <Show
                when={linkEditing()}
                fallback={
                  <>
                    <button
                      type="button"
                      aria-label="Bold"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => applyFormat("bold")}
                    >
                      B
                    </button>
                    <button
                      type="button"
                      class="italic"
                      aria-label="Italic"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => applyFormat("italic")}
                    >
                      I
                    </button>
                    <button type="button" onClick={startLinkEditing}>
                      Link
                    </button>
                  </>
                }
              >
                <input ref={linkInput} aria-label="Link URL" placeholder="https://" />
                <button type="button" onClick={applyLink}>
                  Apply
                </button>
              </Show>
            </div>
          )}
        </Show>

        <Show when={slashMenu()}>
          {(_menu) => (
            <div
              ref={setCommandElement}
              class="specification-command-menu caret-command-menu"
              role="menu"
              aria-label="Specification blocks"
            >
              <For each={filteredSlashBlocks()}>
                {(block, index) => (
                  <button
                    type="button"
                    role="menuitem"
                    class={slashIndex() === index() ? "active" : undefined}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => insertSpecificationBlock(block.id)}
                  >
                    <span>{block.label}</span>
                  </button>
                )}
              </For>
              <Show when={!filteredSlashBlocks().length}>
                <small>No matching blocks</small>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <Show when={historyOpen()}>
        <VersionHistory
          opener={
            documentElement?.querySelector<HTMLElement>('[aria-label="Ticket actions"]') ??
            undefined
          }
          label="Specification history"
          selectedID={historyRevisionID()}
          versions={versions().map((revision) => ({
            id: revision.id,
            label: `Version ${versions().length - versions().indexOf(revision)}`,
            author: revision.author ?? undefined,
            createdAt: revision.createdAt,
            state: `${revision.id === (currentDocument()?.id ?? props.latestRevision?.id) ? "Current · " : "Earlier · "}${revision.approvalId ? "Implementation scope" : revision.authorKind === "ai" ? "AI elaboration" : "Human edit"}`,
          }))}
          onSelect={setHistoryRevisionID}
          onClose={closeHistory}
        />
      </Show>
    </div>
  );
}
