import { createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type { RequirementContent } from "#requirement-domain/content";
import { ticketDocumentInput } from "#requirement-domain/document";
import type { TicketDocumentSave, TicketDraft } from "../change/contracts";
import {
  canEditTicketSpecification,
  createDraftBlock,
  normalizedRequirement,
  parseRequirement,
  sameRequirement,
  type TicketWorkspaceProps,
} from "./ticket-workspace-types";

export type DraftSaveState =
  | { kind: "pristine"; saved: boolean; error?: string | undefined }
  | { kind: "dirty"; error?: string | undefined }
  | { kind: "saving"; wasEditing: boolean }
  | { kind: "conflict"; error: string };

export function createTicketDraft(options: {
  props: TicketWorkspaceProps;
  onResetPopovers: () => void;
}) {
  const ownerTicketID = untrack(() => options.props.current.ticket.id);
  const ownerDrafts = untrack(() => options.props.drafts);
  let disposed = false;
  let retainedOnDispose: TicketDraft | undefined;
  const ownsEditor = () => !disposed && options.props.current.ticket.id === ownerTicketID;
  const canEditSpecification = () => canEditTicketSpecification(options.props.current.ticket);

  const [saveState, setSaveState] = createSignal<DraftSaveState>({
    kind: "pristine",
    saved: false,
  });
  const editing = () => {
    const state = saveState();
    return (
      state.kind === "dirty" ||
      state.kind === "conflict" ||
      (state.kind === "saving" && state.wasEditing)
    );
  };
  const saving = () => saveState().kind === "saving";
  const conflict = () => saveState().kind === "conflict";
  const savedDocument = () => {
    const state = saveState();
    return state.kind === "pristine" && state.saved;
  };
  const editorError = () => {
    const state = saveState();
    return state.kind === "saving" ? "" : (state.error ?? "");
  };
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let baseVersion = untrack(() => options.props.current.ticket.version);
  let baseDocumentID: string | null = untrack(
    () => options.props.current.documentRevisions[0]?.id ?? null,
  );
  let baseRequirementRevisionID: string | null = untrack(
    () => options.props.latestRevision?.id ?? null,
  );
  let draftKey: string | undefined;
  let draftStorageKey: string | undefined;

  const proposal = () =>
    options.props.current.proposal?.base.version === options.props.current.ticket.version
      ? options.props.current.proposal
      : undefined;
  const currentDocument = () => options.props.current.documentRevisions[0];
  const originalRequirement = (): RequirementContent => {
    const document = currentDocument();
    return (
      (document ? parseRequirement(document) : options.props.latestRequirement) ?? {
        summary: options.props.current.ticket.description,
        acceptanceCriteria: [],
        nonGoals: [],
      }
    );
  };
  const draftSource = () => ({
    requirement: proposal()?.requirement ?? originalRequirement(),
    title: proposal()?.ticket.title ?? options.props.current.ticket.title,
    description: proposal()?.ticket.description ?? options.props.current.ticket.description,
  });

  // Saved hydration is the default, not an edit. Only input or a genuinely changed
  // restored draft freezes it; an exact save ACK can stay ahead of a delayed read.
  function draftSignal<T>(value: (source: ReturnType<typeof draftSource>) => T) {
    return createSignal<T>((previous) => {
      const source = draftSource();
      const version = options.props.current.ticket.version;
      return previous !== undefined && (editing() || version < baseVersion)
        ? previous
        : value(source);
    });
  }

  const [draftTitle, setDraftTitle] = draftSignal((source) => source.title);
  const [draftDescription, setDraftDescription] = draftSignal((source) => source.description);
  const [draftSummary, setDraftSummary] = draftSignal((source) => source.requirement.summary);
  const [draftAcceptance, setDraftAcceptance] = draftSignal((source) =>
    (source.requirement.acceptanceCriteria.length
      ? source.requirement.acceptanceCriteria
      : [""]
    ).map(createDraftBlock),
  );
  const [draftNonGoals, setDraftNonGoals] = draftSignal((source) =>
    (source.requirement.nonGoals.length ? source.requirement.nonGoals : [""]).map(createDraftBlock),
  );

  const separateSummary = () =>
    Boolean((options.props.latestRevision || proposal()) && draftSummary() !== draftDescription());
  // Until requirements exist the description is the only visible summary, so the
  // requirement summary follows it. Later edits may deliberately diverge. The summary is
  // written with the description, so no effect relays one signal into the other.
  function updateDescription(description: string) {
    setDraftDescription(description);
    if (!options.props.latestRevision && !proposal()) setDraftSummary(description);
  }

  const currentRequirement = (): RequirementContent =>
    normalizedRequirement({
      summary: draftSummary(),
      acceptanceCriteria: draftAcceptance().map((block) => block.value()),
      nonGoals: draftNonGoals().map((block) => block.value()),
    });
  const planningChanged = () =>
    draftTitle().trim() !== options.props.current.ticket.title ||
    draftDescription().trim() !== options.props.current.ticket.description;
  const specificationChanged = () =>
    canEditSpecification() && !sameRequirement(currentRequirement(), originalRequirement());
  const hasChanges = () => planningChanged() || specificationChanged();

  function resetDrafts(source = draftSource()) {
    const requirement = source.requirement;
    setDraftTitle(source.title);
    setDraftDescription(source.description);
    setDraftSummary(requirement.summary);
    setDraftAcceptance(
      (requirement.acceptanceCriteria.length ? requirement.acceptanceCriteria : [""]).map(
        createDraftBlock,
      ),
    );
    setDraftNonGoals(
      (requirement.nonGoals.length ? requirement.nonGoals : [""]).map(createDraftBlock),
    );
    setSaveState((prev) =>
      prev.kind === "pristine"
        ? { kind: "pristine", saved: prev.saved }
        : prev.kind === "dirty"
          ? { kind: "dirty" }
          : prev,
    );
  }

  function retainDraft() {
    if (!draftKey) return;
    if (editing())
      options.props.drafts.set(draftKey, {
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
    else options.props.drafts.delete(draftKey);
    try {
      const draft = options.props.drafts.get(draftKey);
      if (draftStorageKey) {
        if (draft) localStorage.setItem(draftStorageKey, JSON.stringify(draft));
        else localStorage.removeItem(draftStorageKey);
      }
    } catch {
      /* In-memory draft remains available if browser storage is unavailable. */
    }
  }

  onCleanup(() => {
    disposed = true;
    clearTimeout(autosaveTimer);
    retainDraft();
    retainedOnDispose = ownerDrafts.get(ownerTicketID);
  });

  createEffect(
    () => ({
      key: options.props.current.ticket.id,
      version: options.props.current.ticket.version,
      documentID: currentDocument()?.id ?? null,
      documents: options.props.current.documentRevisions,
      revisionID: options.props.latestRevision?.id ?? null,
      storageKey: options.props.storageKey,
      drafts: options.props.drafts,
      proposalID: proposal()?.id,
      source: draftSource(),
    }),
    ({
      key,
      version,
      documentID,
      documents,
      revisionID,
      storageKey,
      drafts,
      proposalID,
      source,
    }) => {
      if (key === draftKey) return;
      // Persist the previous local draft once, not as a keystroke subscription.
      untrack(retainDraft);
      draftKey = key;
      draftStorageKey = storageKey;
      let draft = drafts.get(key);
      if (!draft) {
        try {
          const value = JSON.parse(
            localStorage.getItem(storageKey) ?? "null",
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
      // Older clients retained unchanged focused text. Compare it with its exact
      // saved base, not just today's document, before calling it a human edit.
      const savedBase =
        !proposalID && !draft?.proposalEntryId
          ? documents.find((revision) => revision.id === draft?.expectedDocumentId)
          : undefined;
      const savedRequirement = savedBase && parseRequirement(savedBase);
      const unchangedBase = Boolean(
        draft &&
          savedBase &&
          savedRequirement &&
          draft.title.trim() === savedBase.title &&
          draft.description.trim() === savedBase.description &&
          sameRequirement(draft.requirement, savedRequirement),
      );
      if (unchangedBase) {
        drafts.delete(key);
        draft = undefined;
        onSettled(retainDraft);
      }
      baseVersion = draft?.expectedVersion ?? version;
      baseDocumentID =
        draft?.expectedDocumentId === undefined ? documentID : draft.expectedDocumentId;
      baseRequirementRevisionID =
        draft?.requirementRevisionId === undefined ? revisionID : draft.requirementRevisionId;
      const mismatchedProposal = Boolean(draft && draft.proposalEntryId !== proposalID);
      if (mismatchedProposal) {
        drafts.delete(key);
        setSaveState({ kind: "pristine", saved: false });
        resetDrafts(source);
      } else {
        const isDirty = Boolean(
          draft &&
            (draft.title.trim() !== source.title ||
              draft.description.trim() !== source.description ||
              !sameRequirement(draft.requirement, source.requirement)),
        );
        setSaveState(isDirty ? { kind: "dirty" } : { kind: "pristine", saved: false });
        if (draft) {
          setDraftTitle(draft.title);
          setDraftDescription(draft.description);
          setDraftSummary(draft.requirement.summary);
          setDraftAcceptance(draft.requirement.acceptanceCriteria.map(createDraftBlock));
          setDraftNonGoals(draft.requirement.nonGoals.map(createDraftBlock));
        }
      }
      if (draft && !mismatchedProposal && !proposalID) onSettled(scheduleAutosave);
      options.onResetPopovers();
    },
  );

  createEffect(
    () => ({
      ticketID: options.props.current.ticket.id,
      proposalID: proposal()?.id,
      drafts: options.props.drafts,
      source: draftSource(),
    }),
    (current, previous) => {
      // The Ticket effect owns initial restoration. Solid 2 batches its draft
      // writes, so these effects must not replace them during the same settle.
      if (
        !previous ||
        current.ticketID !== previous.ticketID ||
        current.proposalID === previous.proposalID
      )
        return;
      const retained = draftKey ? current.drafts.get(draftKey) : undefined;
      if (retained && retained.proposalEntryId === current.proposalID) return;
      if (untrack(editing) && !current.proposalID) return;
      clearTimeout(autosaveTimer);
      setSaveState({ kind: "pristine", saved: false });
      resetDrafts(current.source);
    },
  );

  createEffect(
    () => ({
      ticketID: options.props.current.ticket.id,
      version: options.props.current.ticket.version,
      documentID: currentDocument()?.id ?? null,
      revisionID: options.props.latestRevision?.id ?? null,
      source: draftSource(),
    }),
    (current, previous) => {
      if (
        !previous ||
        current.ticketID !== previous.ticketID ||
        current.version === previous.version
      )
        return;
      if (untrack(() => saving() || conflict() || (editing() && hasChanges()))) return;
      baseVersion = current.version;
      baseDocumentID = current.documentID;
      baseRequirementRevisionID = current.revisionID;
    },
  );

  function scheduleAutosave() {
    if (!ownsEditor()) return;
    retainDraft();
    clearTimeout(autosaveTimer);
    if (proposal() || conflict()) return;
    autosaveTimer = setTimeout(() => void saveChanges(), 650);
  }

  // A save is stale when the saved Ticket moved on after this draft's base. The draft is kept
  // either way; the person chooses whether it replaces the newer version or is dropped.
  function rebaseOnSaved(next: DraftSaveState) {
    baseVersion = options.props.current.ticket.version;
    baseDocumentID = currentDocument()?.id ?? null;
    baseRequirementRevisionID = options.props.latestRevision?.id ?? null;
    setSaveState(next);
  }

  function keepMyDraft() {
    rebaseOnSaved({ kind: "dirty" });
    // Solid 2 commits the conflict reset after this event. Let the save guard
    // observe that reset before saving the retained draft against its new base.
    onSettled(() => void saveChanges());
  }

  function useSavedVersion() {
    clearTimeout(autosaveTimer);
    rebaseOnSaved({ kind: "pristine", saved: false });
    if (draftKey) options.props.drafts.delete(draftKey);
    resetDrafts();
    retainDraft();
  }

  function beginEditing() {
    setSaveState((prev) => {
      // A stale draft stays blocked until the person chooses, so its recovery must stay visible.
      if (prev.kind === "conflict") return prev;
      if (prev.kind === "saving") return { kind: "saving", wasEditing: true };
      return { kind: "dirty" };
    });
  }

  async function saveChanges() {
    if (!ownsEditor() || saving() || proposal() || conflict() || !hasChanges()) return;
    const key = draftKey;
    const ticketID = options.props.current.ticket.id;
    const title = draftTitle().trim();
    if (!title) {
      setSaveState({ kind: "dirty", error: "A ticket title is required." });
      return;
    }
    const requirement = currentRequirement();
    const snapshot = { title, description: draftDescription().trim(), requirement };
    const storageKey = draftStorageKey;
    const input = {
      ...snapshot,
      expectedVersion: baseVersion,
      expectedDocumentId: baseDocumentID,
      requirementRevisionId: baseRequirementRevisionID,
    };
    const wasEditing = editing();
    setSaveState({ kind: "saving", wasEditing });
    let saved: TicketDocumentSave | undefined;
    let threw = false;
    try {
      saved = await options.props.onSaveDocument(input, ticketID);
    } catch (cause) {
      threw = true;
      throw cause;
    } finally {
      if (threw && ownsEditor())
        setSaveState(wasEditing ? { kind: "dirty" } : { kind: "pristine", saved: false });
    }
    if (!ownsEditor()) {
      // Admitted saves may settle into their retained draft. Never reschedule a
      // disposed editor or replace a reopened editor's draft.
      const retained = ownerDrafts.get(ticketID);
      if (
        saved &&
        retained === retainedOnDispose &&
        retained?.expectedVersion === input.expectedVersion &&
        retained.expectedDocumentId === input.expectedDocumentId &&
        retained.requirementRevisionId === input.requirementRevisionId
      ) {
        const unchanged =
          JSON.stringify(snapshot) ===
          JSON.stringify({
            title: retained.title.trim(),
            description: retained.description.trim(),
            requirement: normalizedRequirement(retained.requirement),
          });
        const next = unchanged
          ? undefined
          : {
              ...retained,
              expectedVersion: saved.ticketVersion,
              expectedDocumentId: saved.id,
              requirementRevisionId: saved.requirementRevisionId,
            };
        if (next) ownerDrafts.set(ticketID, next);
        else ownerDrafts.delete(ticketID);
        try {
          if (storageKey) {
            if (next) localStorage.setItem(storageKey, JSON.stringify(next));
            else localStorage.removeItem(storageKey);
          }
        } catch {
          /* The original Ticket's draft remains retained in memory. */
        }
      }
      return;
    }
    if (!saved) {
      const stale =
        baseVersion !== options.props.current.ticket.version ||
        baseDocumentID !== (currentDocument()?.id ?? null);
      setSaveState(
        stale
          ? {
              kind: "conflict",
              error: "This Ticket was changed after you started editing. Your draft is retained.",
            }
          : {
              kind: "dirty",
              error: "Could not save. Your draft is retained; check the connection and retry.",
            },
      );
      retainDraft();
      return;
    }
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
      setSaveState({ kind: "dirty" });
      scheduleAutosave();
      return;
    }
    if (key) options.props.drafts.delete(key);
    if (draftKey !== key) return;
    setSaveState({ kind: "pristine", saved: true });
    retainDraft();
  }

  async function confirmProposal() {
    if (!ownsEditor()) return;
    clearTimeout(autosaveTimer);
    const ticketID = options.props.current.ticket.id;
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
      const message = "Give the Ticket a title and keep its content within the supported limits.";
      setSaveState((prev) =>
        prev.kind === "dirty"
          ? { kind: "dirty", error: message }
          : prev.kind === "pristine"
            ? { kind: "pristine", saved: prev.saved, error: message }
            : prev,
      );
      return;
    }
    const wasEditing = editing();
    setSaveState({ kind: "saving", wasEditing });
    const snapshot = {
      title: parsed.data.title,
      description: parsed.data.description,
      requirement: parsed.data.requirement,
    };
    let settled = false;
    try {
      const saved = await options.props.onConfirmRequirements(
        {
          title: parsed.data.title,
          description: parsed.data.description,
          requirement: currentRequirement(),
        },
        ticketID,
      );
      if (saved && options.props.current.ticket.id === ticketID) {
        baseVersion = saved.ticketVersion;
        baseDocumentID = saved.id;
        baseRequirementRevisionID = saved.requirementRevisionId;
        settled = true;
        if (
          JSON.stringify(snapshot) !==
          JSON.stringify({
            title: draftTitle().trim(),
            description: draftDescription().trim(),
            requirement: currentRequirement(),
          })
        ) {
          setSaveState({ kind: "dirty" });
          scheduleAutosave();
        } else {
          setSaveState({ kind: "pristine", saved: true });
          retainDraft();
        }
      }
    } finally {
      if (!settled && ownsEditor())
        setSaveState(wasEditing ? { kind: "dirty" } : { kind: "pristine", saved: false });
    }
  }

  function appendAcceptance() {
    const nextIndex = draftAcceptance().length;
    setDraftAcceptance((items) => [...items, createDraftBlock("")]);
    return nextIndex;
  }

  function appendNonGoal() {
    const nextIndex = draftNonGoals().length;
    setDraftNonGoals((items) => [...items, createDraftBlock("")]);
    return nextIndex;
  }

  return {
    ownsEditor,
    saveState,
    editing,
    editorError,
    conflict,
    saving,
    savedDocument,
    proposal,
    currentDocument,
    separateSummary,
    hasChanges,
    title: draftTitle,
    setTitle: setDraftTitle,
    description: draftDescription,
    setDescription: setDraftDescription,
    summary: draftSummary,
    setSummary: setDraftSummary,
    acceptance: draftAcceptance,
    nonGoals: draftNonGoals,
    updateDescription,
    retainDraft,
    scheduleAutosave,
    keepMyDraft,
    useSavedVersion,
    beginEditing,
    saveChanges,
    confirmProposal,
    appendAcceptance,
    appendNonGoal,
  };
}

export type TicketDraftController = ReturnType<typeof createTicketDraft>;
