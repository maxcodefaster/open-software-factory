import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { withoutRepeatedTitle } from "#knowledge-domain/document-merge";
import type { knowledgeIcons } from "#knowledge-domain/page-tree";
import { plainErrorMessage } from "../command-error";
import { createWorkspaceNavigation, WorkspaceNavigationToggle } from "../ui/workspace-navigation";
import type {
  KnowledgeGeneration,
  KnowledgePage,
  KnowledgePageOutline,
  KnowledgeRevision,
  KnowledgeSave,
  KnowledgeSearchResult,
  OpenRepositoryDocument,
  RepositoryDocument,
} from "./contracts";
import {
  acknowledgeDraft,
  draftDirty,
  draftFrom,
  type KnowledgeDraft,
  type KnowledgeSubmission,
  pageSnapshot,
  readDraft,
  reconcileDraft,
} from "./draft";
import { WikiNavigationResize } from "./navigation-resize";
import { KnowledgeTree, type PageMove } from "./page-tree";
import { WikiSearch } from "./wiki-search";
import { WorkspaceDocument } from "./workspace-document";
import { WorkspaceEmptyState, WorkspaceGenerationBanner } from "./workspace-generation";
import { WorkspaceHistoricalRevision, WorkspaceVersionHistoryPanel } from "./workspace-history";

export function KnowledgeWorkspace(props: {
  pages: KnowledgePageOutline[];
  selectedPage?: KnowledgePage | undefined;
  loading: boolean;
  documents: RepositoryDocument[];
  openDocument?: OpenRepositoryDocument | undefined;
  generation?: KnowledgeGeneration | undefined;
  revisions: KnowledgeRevision[];
  searchResults: KnowledgeSearchResult[];
  searchQuery: string;
  pending: boolean;
  projectID: string;
  userID: string;
  repositoryURL: string;
  canDevelop: boolean;
  drafts: Map<string, KnowledgeDraft>;
  onSelectPage(pageID: string): void;
  onOpenDocument(path: string): void;
  onLoadDocuments?: (() => Promise<void>) | undefined;
  onGenerate(): void;
  onSearch(query: string): Promise<"found" | "failed" | "superseded">;
  onSavePage(
    pageId: string,
    expectedVersion: number,
    title: string,
    body: string,
  ): Promise<KnowledgeSave>;
  onHistory(pageID: string): Promise<void>;
  onSources(pageID: string): Promise<Array<{ path: string; commitSha: string }>>;
  onArchive(): void;
  onMove(move: PageMove): Promise<void>;
  onIcon(icon: (typeof knowledgeIcons)[number]): Promise<void>;
  onOpenIDE(): void;
  onRestore(pageID: string, revisionID: string, expectedVersion: number): Promise<KnowledgeSave>;
}) {
  const draftStore = untrack(() => props.drafts);
  const hasPublishedPages = () => props.pages.some((page) => page.state === "active");
  const documentKey = () =>
    `${props.userID}:${props.projectID}:${props.openDocument ? `document:${props.openDocument.path}` : `page:${props.selectedPage?.id ?? "none"}`}`;
  const [editing, setEditing] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  let workspace: HTMLDivElement | undefined;
  let navigationRoot: HTMLDivElement | undefined;
  let sidebar: HTMLElement | undefined;
  const navigation = createWorkspaceNavigation({
    root: () => navigationRoot,
    panel: () => sidebar,
    breakpoint: 760,
  });
  const navigationTitle = () => (
    <WorkspaceNavigationToggle navigation={navigation} label="Browse Wiki pages" title="Pages" />
  );
  const [draft, setDraft] = createSignal<KnowledgeDraft>();
  const dirty = () => {
    const current = draft();
    return current ? draftDirty(current) : false;
  };
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveError, setSaveError] = createSignal("");
  const [linkNotice, setLinkNotice] = createSignal("");
  let pageMenu: HTMLDivElement | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  const submissions = new Map<string, KnowledgeSubmission>();
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [historyRevisionID, setHistoryRevisionID] = createSignal<string>();
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyError, setHistoryError] = createSignal("");
  const historicalRevision = () =>
    props.revisions.find((revision) => revision.id === historyRevisionID());
  const [restoreError, setRestoreError] = createSignal("");
  const [restoring, setRestoring] = createSignal(false);

  async function restoreRevision(revision: KnowledgeRevision) {
    const page = props.selectedPage;
    const key = draftKey;
    const current = draft();
    if (!page || !key || !current || draftDirty(current) || submissions.has(key)) return;
    const submission: KnowledgeSubmission = {
      kind: "restore",
      draft: current,
      target: {
        id: page.id,
        version: page.version + 1,
        title: revision.title,
        body: withoutRepeatedTitle(revision.body, revision.title),
      },
    };
    const history = historyRequest;
    submissions.set(key, submission);
    clearTimeout(autosaveTimer);
    setRestoring(true);
    setRestoreError("");
    try {
      const saved = await props.onRestore(page.id, revision.id, page.version);
      settleDraft(key, submission, saved);
      if (draftKey === key && historyRequest === history) closeHistory();
    } catch (cause) {
      if (draftKey === key)
        setRestoreError(
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Revision could not be restored.",
        );
    } finally {
      submissions.delete(key);
      if (draftKey === key) {
        setRestoring(false);
        scheduleSave();
      }
    }
  }

  let historyRequest = 0;
  function closeHistory() {
    historyRequest += 1;
    setHistoryOpen(false);
    setHistoryRevisionID(undefined);
    setHistoryLoading(false);
    setHistoryError("");
  }

  function navigateWiki(href: string) {
    const slug = /^#wiki\/([a-z0-9-]+)$/.exec(href)?.[1];
    if (!slug) return false;
    const page = props.pages.find((page) => page.slug === slug && page.state === "active");
    if (page) {
      setLinkNotice("");
      closeHistory();
      props.onSelectPage(page.id);
    } else setLinkNotice("That Wiki page is not available. It may have been archived or renamed.");
    return true;
  }

  async function openHistory() {
    if (historyOpen()) {
      closeHistory();
      return;
    }
    const page = props.selectedPage;
    if (!page) return;
    const request = ++historyRequest;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      await props.onHistory(page.id);
      if (historyRequest === request) setHistoryRevisionID(props.revisions[0]?.id);
    } catch {
      if (historyRequest === request)
        setHistoryError("History could not be loaded. Close and try again.");
    } finally {
      if (historyRequest === request) setHistoryLoading(false);
    }
  }

  let draftKey: string | undefined;
  function retainDraft(current = untrack(draft)) {
    if (!draftKey) return;
    storeDraft(draftKey, current);
  }

  function storeDraft(key: string, current: KnowledgeDraft | undefined) {
    if (current && draftDirty(current)) {
      draftStore.set(key, current);
      try {
        localStorage.setItem(`wiki-draft:${key}`, JSON.stringify(current));
      } catch {
        if (draftKey === key)
          setSaveError("Browser storage is unavailable. Keep this page open until it saves.");
      }
    } else {
      draftStore.delete(key);
      try {
        localStorage.removeItem(`wiki-draft:${key}`);
      } catch {
        /* Saved content is authoritative. */
      }
    }
  }

  onCleanup(() => {
    clearTimeout(autosaveTimer);
    retainDraft();
  });

  createEffect(
    () => ({
      key: documentKey(),
      incoming:
        props.selectedPage && !props.openDocument ? pageSnapshot(props.selectedPage) : undefined,
    }),
    ({ key, incoming }) => {
      if (key === draftKey) return;
      clearTimeout(autosaveTimer);
      retainDraft();
      closeHistory();
      draftKey = key;
      let retained = draftStore.get(key);
      try {
        retained ??= readDraft(key, localStorage);
      } catch {
        /* In-memory drafts remain available. */
      }
      const next = incoming;
      setDraft(next ? (retained ? reconcileDraft(retained, next) : draftFrom(next)) : undefined);
      setEditing(!!retained);
      setSaveState(submissions.get(key)?.kind === "save" ? "saving" : "idle");
      setSaveError("");
      setRestoring(submissions.get(key)?.kind === "restore");
      setRestoreError("");
      setLinkNotice("");
    },
  );

  createEffect(
    () =>
      props.selectedPage && !props.openDocument ? pageSnapshot(props.selectedPage) : undefined,
    (incoming) => {
      // Reconcile an observed server revision against one snapshot of local work.
      const current = untrack(draft);
      if (!incoming || current?.base.id !== incoming.id) return;
      const submitted = draftKey ? submissions.get(draftKey) : undefined;
      const ownWrite =
        submitted &&
        incoming.version === submitted.target.version &&
        incoming.title === submitted.target.title &&
        incoming.body === submitted.target.body;
      const next = ownWrite
        ? acknowledgeDraft(current, submitted, incoming)
        : reconcileDraft(current, incoming);
      if (next !== current) {
        setDraft(next);
      }
    },
  );

  function changeDraft(field: "title" | "body", value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  createEffect(
    () => draft(),
    (current) => {
      if (!current) return;
      retainDraft(current);
      // A failure requires explicit retry, not another observer-driven save.
      if (untrack(saveState) !== "failed") scheduleSave(current);
    },
  );

  function scheduleSave(current = untrack(draft)) {
    clearTimeout(autosaveTimer);
    if (
      !current ||
      current.conflict ||
      !draftDirty(current) ||
      !current.title.trim() ||
      !current.body.trim()
    )
      return;
    autosaveTimer = setTimeout(() => void save(), 750);
  }

  function beginEdit() {
    if (!props.selectedPage || props.openDocument) return;
    setEditing(true);
  }

  function stopEdit() {
    clearTimeout(autosaveTimer);
    const current = draft();
    if (
      current &&
      !current.conflict &&
      draftDirty(current) &&
      current.title.trim() &&
      current.body.trim() &&
      saveState() !== "failed"
    ) {
      void save();
    }
    setEditing(false);
  }

  function keepDraft() {
    const page = props.selectedPage;
    const current = draft();
    if (!page || !current) return;
    setDraft({ ...current, base: pageSnapshot(page), conflict: false });
    scheduleSave();
  }

  function useSavedPage() {
    const page = props.selectedPage;
    if (!page) return;
    setDraft(draftFrom(pageSnapshot(page)));
    retainDraft();
  }

  function settleDraft(key: string, submission: KnowledgeSubmission, saved: KnowledgeSave) {
    const current = draftKey === key ? draft() : draftStore.get(key);
    if (!current) return;
    const acknowledged = acknowledgeDraft(current, submission, {
      id: saved.id,
      version: saved.version,
      title: saved.title,
      body: withoutRepeatedTitle(saved.body, saved.title),
    });
    if (draftKey === key) {
      setDraft(acknowledged);
      setSaveState(current.base.version > saved.version ? "idle" : "saved");
    }
    storeDraft(key, acknowledged);
  }

  async function save() {
    const key = draftKey;
    const submitted = draft();
    if (
      !key ||
      !submitted ||
      props.openDocument ||
      submitted.conflict ||
      !draftDirty(submitted) ||
      submissions.has(key)
    )
      return;
    const submission: KnowledgeSubmission = {
      kind: "save",
      draft: submitted,
      target: {
        id: submitted.base.id,
        version: submitted.base.version + 1,
        title: submitted.title,
        body: submitted.body,
      },
    };
    submissions.set(key, submission);
    setSaveState("saving");
    setSaveError("");
    let failed = false;
    try {
      const saved = await props.onSavePage(
        submitted.base.id,
        submitted.base.version,
        submitted.title,
        submitted.body,
      );
      settleDraft(key, submission, saved);
    } catch (cause) {
      failed = true;
      if (draftKey === key) {
        setSaveState("failed");
        setSaveError(
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "Your changes could not be saved.",
        );
        const page = props.selectedPage;
        const current = draft();
        if (page && current) setDraft(reconcileDraft(current, pageSnapshot(page)));
        retainDraft();
      }
    } finally {
      submissions.delete(key);
      // Solid commits setters after this continuation. Do not inspect the old
      // "saving" snapshot and accidentally retry an unconfirmed write.
      if (draftKey === key && !failed) scheduleSave();
    }
  }

  return (
    <div ref={navigationRoot} class="wiki-workspace-container workspace-navigation-container">
      <div ref={workspace} class={`knowledge-workspace${historyOpen() ? " has-history" : ""}`}>
        <aside
          ref={sidebar}
          id={navigation.id}
          class="knowledge-navigation"
          aria-label="Wiki navigation"
          data-navigation-open={navigation.open() ? "true" : "false"}
        >
          <KnowledgeTree
            projectID={props.projectID}
            pages={props.pages}
            documents={props.canDevelop ? props.documents : []}
            canDevelop={props.canDevelop}
            onSearch={() => {
              navigation.close();
              setSearchOpen(true);
            }}
            selectedPageID={props.selectedPage?.id}
            selectedDocumentPath={props.openDocument?.path}
            search={false}
            snippet={() => undefined}
            onSelectPage={(id) => {
              props.onSelectPage(id);
              navigation.close(true);
            }}
            onOpenDocument={(path) => {
              props.onOpenDocument(path);
              navigation.close(true);
            }}
            onMove={props.onMove}
            onLoadDocuments={props.onLoadDocuments}
          />
        </aside>
        <WikiNavigationResize projectID={props.projectID} workspace={() => workspace} />
        <Show when={searchOpen()}>
          <WikiSearch
            query={props.searchQuery}
            results={props.searchResults}
            canDevelop={props.canDevelop}
            onSearch={props.onSearch}
            onClose={() => {
              setSearchOpen(false);
              navigation.close(true);
            }}
            onSelect={(result) => {
              if (result.kind === "page") props.onSelectPage(result.id);
              else if (props.canDevelop) props.onOpenDocument(result.path);
              setSearchOpen(false);
              navigation.close(true);
            }}
          />
        </Show>

        <div class="knowledge-content">
          <Show when={!props.selectedPage && !props.openDocument}>
            <div class="wiki-empty-navigation">{navigationTitle()}</div>
          </Show>
          <WorkspaceGenerationBanner
            generation={props.generation}
            loading={props.loading}
            hasPublishedPages={hasPublishedPages()}
            pending={props.pending}
            onGenerate={props.onGenerate}
          />
          <Show when={linkNotice()}>
            <p class="knowledge-link-notice" role="status">
              {linkNotice()}
            </p>
          </Show>
          <Show
            when={props.selectedPage || props.openDocument}
            fallback={
              <WorkspaceEmptyState
                loading={props.loading}
                hasPublishedPages={hasPublishedPages()}
                generation={props.generation}
                pending={props.pending}
                onGenerate={props.onGenerate}
              />
            }
          >
            <Show when={historicalRevision()}>
              {(revision) => (
                <WorkspaceHistoricalRevision
                  revision={revision()}
                  selectedPage={props.selectedPage}
                  pages={props.pages}
                  canDevelop={props.canDevelop}
                  repositoryURL={props.repositoryURL}
                  restoring={restoring()}
                  dirty={dirty()}
                  restoreError={restoreError()}
                  leading={navigationTitle()}
                  onNavigate={navigateWiki}
                  onRestore={(target) => void restoreRevision(target)}
                />
              )}
            </Show>
            <WorkspaceDocument
              documentKey={documentKey()}
              hidden={Boolean(historicalRevision())}
              projectID={props.projectID}
              pages={props.pages}
              selectedPage={props.selectedPage}
              openDocument={props.openDocument}
              generation={props.generation}
              pending={props.pending}
              canDevelop={props.canDevelop}
              repositoryURL={props.repositoryURL}
              editing={editing()}
              draft={draft()}
              dirty={dirty()}
              saveState={saveState()}
              saveError={saveError()}
              leading={navigationTitle()}
              onPageMenuRef={(element) => {
                pageMenu = element;
              }}
              onBeginEdit={beginEdit}
              onStopEdit={stopEdit}
              onChangeDraft={changeDraft}
              onSave={() => void save()}
              onKeepDraft={keepDraft}
              onUseSavedPage={useSavedPage}
              onOpenHistory={() => void openHistory()}
              onGenerate={props.onGenerate}
              onSources={props.onSources}
              onArchive={props.onArchive}
              onMove={props.onMove}
              onIcon={props.onIcon}
              onOpenIDE={props.onOpenIDE}
              onNavigate={navigateWiki}
            />
          </Show>
        </div>
        <Show when={historyOpen()}>
          <WorkspaceVersionHistoryPanel
            revisions={props.revisions}
            selectedPage={props.selectedPage}
            selectedID={historyRevisionID()}
            loading={historyLoading()}
            error={historyError()}
            opener={
              pageMenu?.querySelector<HTMLButtonElement>('button[aria-label="Page options"]') ??
              undefined
            }
            onSelect={setHistoryRevisionID}
            onClose={closeHistory}
          />
        </Show>
      </div>
    </div>
  );
}
