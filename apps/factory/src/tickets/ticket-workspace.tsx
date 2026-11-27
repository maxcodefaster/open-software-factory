import { createEffect, createMemo, createSignal, For, onSettled } from "solid-js";
import type { DocumentEditor } from "../editor/client";
import type { ReviewActions } from "../review/panel";
import { documentChangedSinceImplementation } from "./ticket-document-notice";
import { TicketChapterNavigation } from "./ticket-planning";
import { createTicketWorkspaceActions } from "./ticket-workspace-actions";
import { createTicketDraft } from "./ticket-workspace-draft";
import {
  TicketDocumentHeader,
  TicketHistoricalDocument,
  TicketReviewSection,
  TicketSaveErrorBanner,
  TicketSpecificationSection,
  TicketTechnicalSection,
  TicketVersionHistoryDrawer,
} from "./ticket-workspace-sections";
import { createTicketEditorPopovers, TicketEditorPopovers } from "./ticket-workspace-slash";
import {
  canEditTicketSpecification,
  type RichTextHandlerOptions,
  type RichTextHandlers,
  type TicketWorkspaceProps,
} from "./ticket-workspace-types";

export type { TicketWorkspaceProps } from "./client";

export function TicketWorkspace(props: TicketWorkspaceProps) {
  // A Ticket owns its editor and draft lifetime. Keying the item preserves the
  // same editor for server revisions, but never rebinds an old editor to another
  // Ticket. The item accessor also fences late work to its original Ticket.
  return (
    <For each={[props.current]} keyed={(current) => current.ticket.id}>
      {(current) => <TicketDocument {...props} current={current()} />}
    </For>
  );
}

function TicketDocument(props: TicketWorkspaceProps) {
  let documentElement: HTMLElement | undefined;
  const [chapterRoot, setChapterRoot] = createSignal<HTMLElement>();
  const [technicalEditing, setTechnicalEditing] = createSignal<() => boolean>();
  const technicalDirty = () => technicalEditing()?.() ?? false;
  const technical = createMemo(() => props.current.technicalDesigns?.[0]);
  const showTechnical = () => props.canDevelop && Boolean(technical());

  const [openReviewThreads, setOpenReviewThreads] = createSignal<number>();
  const [reviewActionSource, setReviewActionSource] =
    createSignal<() => ReviewActions | undefined>();
  const reviewActions = () => reviewActionSource()?.();
  const reviewScope = createMemo(() => props.change?.id);
  createEffect(reviewScope, () => setOpenReviewThreads(undefined));

  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [historyRevisionID, setHistoryRevisionID] = createSignal<string>();
  const [dismissedDocumentID, setDismissedDocumentID] = createSignal<string>();
  const acceptanceElements = new Map<number, HTMLElement>();
  const nonGoalElements = new Map<number, HTMLElement>();
  const registerBlockElement =
    (elements: Map<number, HTMLElement>, index: number) => (element: HTMLElement) =>
      elements.set(index, element);

  const canEditSpecification = () => canEditTicketSpecification(props.current.ticket);
  let resetPopovers = () => {};
  const draft = createTicketDraft({
    props,
    onResetPopovers: () => resetPopovers(),
  });

  const specificationVisible = () =>
    Boolean(canEditSpecification() || props.latestRevision || draft.proposal());

  function cancelEditing() {
    draft.retainDraft();
    popovers.clearPopovers();
    queueMicrotask(() => documentElement?.focus());
  }

  const popovers = createTicketEditorPopovers({
    documentElement: () => documentElement,
    specificationVisible,
    hasChanges: draft.hasChanges,
    onSaveChanges: () => void draft.saveChanges(),
    onCancelEditing: cancelEditing,
    onAppendAcceptance: () => {
      const nextIndex = draft.appendAcceptance();
      queueMicrotask(() => acceptanceElements.get(nextIndex)?.focus());
    },
    onAppendNonGoal: () => {
      const nextIndex = draft.appendNonGoal();
      queueMicrotask(() => nonGoalElements.get(nextIndex)?.focus());
    },
  });
  resetPopovers = popovers.resetTicketPopovers;

  const actions = createTicketWorkspaceActions({
    props,
    proposal: draft.proposal,
    currentDocument: draft.currentDocument,
    hasChanges: draft.hasChanges,
    saving: draft.saving,
    technical,
    technicalDirty,
    openReviewThreads,
    reviewActions,
    onConfirmProposal: draft.confirmProposal,
  });

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
  const implementationRevision = () =>
    props.current.revisions.find(
      (revision) =>
        revision.approvalId === props.change?.requirementApprovalId && revision.approvalId,
    );
  const documentNotice = () =>
    Boolean(props.change) &&
    documentChangedSinceImplementation(props.current.documentRevisions, implementationRevision()) &&
    draft.currentDocument()?.id !== dismissedDocumentID();

  function dismissDocumentNotice() {
    const id = draft.currentDocument()?.id;
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
        setDismissedDocumentID(sessionStorage.getItem(`document-notice:${ticketID}`) ?? undefined);
      } catch {
        // Storage availability does not govern document access.
      }
    },
  );

  function closeHistory() {
    setHistoryOpen(false);
    setHistoryRevisionID(undefined);
  }

  function richTextHandlers(options: RichTextHandlerOptions): RichTextHandlers {
    return {
      onInput: (value: string, element: HTMLElement) => {
        if (!draft.ownsEditor()) return;
        // Autosave can acknowledge the previous draft while the field stays focused.
        // Every new edit must regain draft protection before a server revision arrives.
        draft.beginEditing();
        options.update(value);
        // Solid 2 commits signal writes at the microtask boundary. Persist the new
        // draft after that commit rather than reading the previous keystroke.
        onSettled(() => {
          if (!draft.ownsEditor()) return;
          draft.scheduleAutosave();
          if (options.slash) popovers.updateSlashMenu(element);
        });
      },
      onKeyDown: popovers.editorKeyDown,
      onSelection: popovers.updateSelectionToolbar,
      onEditor: (element: HTMLElement, handle: DocumentEditor) =>
        popovers.registerEditor(element, handle),
    };
  }

  return (
    <div class={`ticket-layout${historyOpen() ? " has-inspector" : ""}`}>
      <div class="ticket-editor-frame">
        <div class="ticket-workspace">
          <TicketHistoricalDocument
            revision={historicalRevision()}
            fallbackTitle={props.current.ticket.title}
            versions={versions()}
          />
          <article
            class={`ticket-document ticket-planning-document${props.change ? " has-review" : ""}`}
            hidden={Boolean(historicalRevision())}
            aria-label={draft.proposal() ? "Elaborated requirements" : "Ticket document"}
            ref={(element) => {
              documentElement = element;
              setChapterRoot(element);
            }}
            tabindex="-1"
          >
            <TicketDocumentHeader
              workspace={props}
              draft={draft}
              actions={actions}
              reviewActions={reviewActions()}
              openReviewThreads={openReviewThreads()}
              technical={technical()}
              technicalDirty={technicalDirty()}
              historyOpen={historyOpen()}
              documentNotice={documentNotice()}
              implementationRevision={implementationRevision()}
              richTextHandlers={richTextHandlers}
              onToggleHistory={() => (historyOpen() ? closeHistory() : setHistoryOpen(true))}
              onOpenCurrentHistory={() => {
                setHistoryOpen(true);
                setHistoryRevisionID(draft.currentDocument()?.id);
              }}
              onDismissDocumentNotice={dismissDocumentNotice}
            />

            <TicketSaveErrorBanner draft={draft} />

            <div class="ticket-reading-layout">
              <TicketChapterNavigation
                root={chapterRoot()}
                technical={showTechnical()}
                validation={Boolean(props.canDevelop && technical())}
                architecture={Boolean(props.canDevelop && technical()?.content.diagrams.length)}
                review={Boolean(props.change && props.userID)}
              />
              <div class="ticket-chapter-body">
                <TicketReviewSection
                  workspace={props}
                  onThreadCount={setOpenReviewThreads}
                  onActions={(read) => setReviewActionSource(() => read)}
                />
                <TicketSpecificationSection
                  workspace={props}
                  draft={draft}
                  canEditSpecification={canEditSpecification()}
                  specificationVisible={specificationVisible()}
                  richTextHandlers={richTextHandlers}
                  onRegisterAcceptance={(index) => registerBlockElement(acceptanceElements, index)}
                  onRegisterNonGoal={(index) => registerBlockElement(nonGoalElements, index)}
                />
                <TicketTechnicalSection
                  workspace={props}
                  show={showTechnical()}
                  technical={technical()}
                  onEditing={(read) => setTechnicalEditing(() => read)}
                />
              </div>
            </div>
          </article>
        </div>

        <TicketEditorPopovers controller={popovers} />
      </div>
      <TicketVersionHistoryDrawer
        open={historyOpen()}
        documentElement={() => documentElement}
        selectedID={historyRevisionID()}
        versions={versions()}
        currentRevisionID={draft.currentDocument()?.id ?? props.latestRevision?.id}
        onSelect={setHistoryRevisionID}
        onClose={closeHistory}
      />
    </div>
  );
}
