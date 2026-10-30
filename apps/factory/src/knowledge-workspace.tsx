import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { withoutRepeatedTitle } from "../../../packages/knowledge-domain/src/document-merge";
import type { knowledgeIcons } from "../../../packages/knowledge-domain/src/page-tree";
import type {
  KnowledgeGeneration,
  KnowledgePage,
  KnowledgePageOutline,
  KnowledgeRevision,
  KnowledgeSave,
  KnowledgeSearchResult,
  OpenRepositoryDocument,
  RepositoryDocument,
} from "./api-contracts";
import { Icon } from "./icon";
import {
  draftDirty,
  draftFrom,
  type KnowledgeDraft,
  pageSnapshot,
  readDraft,
  reconcileDraft,
} from "./knowledge/draft";
import { WikiNavigationResize } from "./knowledge/navigation-resize";
import { PageOrganization } from "./knowledge/page-organization";
import { KnowledgeTree, type PageMove } from "./knowledge/page-tree";
import { repositoryLink } from "./knowledge/source-link";
import { WikiSearch } from "./knowledge/wiki-search";
import { MarkdownEditor } from "./markdown-editor";
import { MarkdownReader } from "./markdown-reader";
import { bindPopoverKeyboard } from "./popover-keyboard";
import { SaveFeedback } from "./ui/feedback";
import { WorkspaceActionBar } from "./ui/workspace-actions";
import { createWorkspaceNavigation, WorkspaceNavigationToggle } from "./ui/workspace-navigation";
import { VersionHistory } from "./version-history";

export type { KnowledgeDraft } from "./knowledge/draft";

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
  onSearch(query: string): void;
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
  const [editing, setEditing] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [sources, setSources] = createSignal<Array<{ path: string; commitSha: string }>>();
  const [sourcesError, setSourcesError] = createSignal("");
  const [sourcesLoading, setSourcesLoading] = createSignal(false);
  let sourceRequest = 0;
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
  const draftTitle = () => draft()?.title ?? "";
  const draftBody = () => draft()?.body ?? "";
  const dirty = () => {
    const current = draft();
    return current ? draftDirty(current) : false;
  };
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveError, setSaveError] = createSignal("");
  const [compareOpen, setCompareOpen] = createSignal(false);
  const [pageMenuOpen, setPageMenuOpen] = createSignal(false);
  let pageMenu: HTMLDivElement | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  const savingKeys = new Set<string>();
  const submissions = new Map<string, KnowledgeDraft>();
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
    if (!page) return;
    setRestoring(true);
    setRestoreError("");
    try {
      const saved = await props.onRestore(page.id, revision.id, page.version);
      setDraft(
        draftFrom({
          id: saved.id,
          version: saved.version,
          title: saved.title,
          body: withoutRepeatedTitle(saved.body, saved.title),
        }),
      );
      closeHistory();
    } catch (cause) {
      setRestoreError(cause instanceof Error ? cause.message : "Revision could not be restored.");
    } finally {
      setRestoring(false);
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
      closeHistory();
      props.onSelectPage(page.id);
    }
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
    if (current && draftDirty(current)) {
      draftStore.set(draftKey, current);
      try {
        localStorage.setItem(`wiki-draft:${draftKey}`, JSON.stringify(current));
      } catch {
        setSaveError("Browser storage is unavailable. Keep this page open until it saves.");
      }
    } else {
      draftStore.delete(draftKey);
      try {
        localStorage.removeItem(`wiki-draft:${draftKey}`);
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
      key: `${props.userID}:${props.projectID}:${props.openDocument ? `document:${props.openDocument.path}` : `page:${props.selectedPage?.id ?? "none"}`}`,
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
      setSaveState("idle");
      setSaveError("");
      setCompareOpen(false);
      setPageMenuOpen(false);
      sourceRequest += 1;
      setSources(undefined);
      setSourcesError("");
      setSourcesLoading(false);
    },
  );
  createEffect(
    () => props.canDevelop,
    (develop) => {
      if (develop) return;
      sourceRequest += 1;
      setSources(undefined);
      setSourcesError("");
      setSourcesLoading(false);
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
      const ownSave =
        submitted &&
        incoming.version === submitted.base.version + 1 &&
        incoming.title === submitted.title &&
        incoming.body === submitted.body;
      const next = ownSave ? { ...current, base: incoming } : reconcileDraft(current, incoming);
      if (next !== current) {
        setDraft(next);
      }
    },
  );
  createEffect(
    () => pageMenuOpen(),
    (open) => {
      if (!open) return;
      const outside = (event: PointerEvent) => {
        if (event.target instanceof Node && !pageMenu?.contains(event.target))
          setPageMenuOpen(false);
      };
      const menu = pageMenu?.querySelector<HTMLElement>(".knowledge-page-menu");
      const opener = pageMenu?.querySelector<HTMLButtonElement>(
        'button[aria-label="Page options"]',
      );
      const dispose = menu
        ? bindPopoverKeyboard(menu, opener ?? undefined, () => setPageMenuOpen(false))
        : undefined;
      document.addEventListener("pointerdown", outside);
      return () => {
        document.removeEventListener("pointerdown", outside);
        dispose?.();
      };
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
  async function save() {
    const key = draftKey;
    const submitted = draft();
    if (
      !key ||
      !submitted ||
      props.openDocument ||
      submitted.conflict ||
      !draftDirty(submitted) ||
      savingKeys.has(key)
    )
      return;
    savingKeys.add(key);
    submissions.set(key, submitted);
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
      const current = draftKey === key ? draft() : draftStore.get(key);
      if (current) {
        if (current.base.version > saved.version) {
          if (draftKey === key) setSaveState("idle");
          return;
        }
        const acknowledged = {
          ...current,
          base: {
            id: saved.id,
            version: saved.version,
            title: saved.title,
            body: withoutRepeatedTitle(saved.body, saved.title),
          },
          conflict: false,
        };
        if (draftKey === key) {
          setDraft(acknowledged);
          setSaveState("saved");
          retainDraft(acknowledged);
        } else {
          if (draftDirty(acknowledged)) draftStore.set(key, acknowledged);
          else draftStore.delete(key);
          try {
            if (draftDirty(acknowledged))
              localStorage.setItem(`wiki-draft:${key}`, JSON.stringify(acknowledged));
            else localStorage.removeItem(`wiki-draft:${key}`);
          } catch {
            /* In-memory draft survives. */
          }
        }
      }
    } catch (cause) {
      failed = true;
      if (draftKey === key) {
        setSaveState("failed");
        setSaveError(
          cause instanceof Error
            ? cause.message
            : "Your changes could not be saved. Your draft is retained.",
        );
        const page = props.selectedPage;
        const current = draft();
        if (page && current) setDraft(reconcileDraft(current, pageSnapshot(page)));
        retainDraft();
      }
    } finally {
      savingKeys.delete(key);
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
          <Show when={["pending", "running", "failed"].includes(props.generation?.state ?? "")}>
            <div class="knowledge-generation">
              <Show when={["pending", "running"].includes(props.generation?.state ?? "")}>
                <div>
                  <span class={`generation-dot ${props.generation?.state}`} />
                  <small role="status">Updating Wiki…</small>
                </div>
              </Show>
              <Show when={props.generation?.failure}>
                {(failure) => (
                  <div class="knowledge-update-error">
                    <p role="alert">Update failed. Your saved pages are still available.</p>
                    <details>
                      <summary>Update details</summary>
                      <pre>{failure()}</pre>
                    </details>
                  </div>
                )}
              </Show>
              <Show when={props.generation?.state === "failed"}>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={
                    props.pending || ["pending", "running"].includes(props.generation?.state ?? "")
                  }
                  onClick={props.onGenerate}
                >
                  Retry update
                </button>
              </Show>
            </div>
          </Show>
        </aside>
        <WikiNavigationResize projectID={props.projectID} workspace={() => workspace} />
        <Show when={searchOpen()}>
          <WikiSearch
            query={props.searchQuery}
            results={props.searchResults}
            canDevelop={props.canDevelop}
            onSearch={props.onSearch}
            onClose={() => setSearchOpen(false)}
            onSelect={(result) => {
              if (result.kind === "page") props.onSelectPage(result.id);
              else if (props.canDevelop) props.onOpenDocument(result.path);
              setSearchOpen(false);
            }}
          />
        </Show>

        <main class="knowledge-content">
          <Show
            when={props.selectedPage || props.openDocument}
            fallback={
              <div class="empty-workspace">
                <div class="wiki-empty-navigation">{navigationTitle()}</div>
                <Icon name="knowledge" />
                <Show when={!props.loading} fallback={<p role="status">Loading Wiki…</p>}>
                  <Show
                    when={!props.pages.some((page) => page.state === "active")}
                    fallback={<p>Choose a Wiki page to read.</p>}
                  >
                    <p>
                      {["pending", "running"].includes(props.generation?.state ?? "")
                        ? "Project Knowledge is being generated."
                        : "Generate Project Knowledge from the current commit."}
                    </p>
                    <Show when={!["pending", "running"].includes(props.generation?.state ?? "")}>
                      <button
                        type="button"
                        class="workspace-action"
                        data-primary="true"
                        disabled={props.pending}
                        onClick={props.onGenerate}
                      >
                        Create Project Wiki
                      </button>
                    </Show>
                  </Show>
                </Show>
              </div>
            }
          >
            <Show when={historicalRevision()}>
              {(revision) => (
                <article
                  class="knowledge-document historical-document"
                  aria-label="Selected knowledge revision"
                >
                  <header class="knowledge-heading workspace-heading">
                    <div class="knowledge-title-row workspace-heading-title">
                      <Icon name={props.selectedPage?.icon ?? "knowledge"} />
                      <h2>{revision().title}</h2>
                    </div>
                    <WorkspaceActionBar label="Wiki revision actions" leading={navigationTitle()}>
                      <Show
                        when={
                          props.canDevelop &&
                          revision().kind === "generated" &&
                          revision().sourceCommitSha &&
                          repositoryLink(props.repositoryURL, revision().sourceCommitSha ?? "")
                        }
                      >
                        {(href) => (
                          <a
                            class="workspace-action"
                            href={href()}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View source change
                          </a>
                        )}
                      </Show>
                      <Show
                        when={
                          revision().kind !== "proposed" &&
                          revision().id !== props.selectedPage?.currentRevisionId
                        }
                      >
                        <button
                          type="button"
                          class="workspace-action"
                          data-primary="true"
                          disabled={restoring() || dirty()}
                          onClick={() => void restoreRevision(revision())}
                        >
                          Restore this version
                        </button>
                      </Show>
                    </WorkspaceActionBar>
                    <small class="workspace-heading-meta">
                      {revision().kind === "human"
                        ? (revision().author ?? "Human edit")
                        : "AI update"}{" "}
                      · {new Date(revision().createdAt).toLocaleString()}
                    </small>
                  </header>
                  <MarkdownReader
                    class="knowledge-article markdown-body"
                    label="Historical page"
                    scopeKey={revision().id}
                    onNavigate={navigateWiki}
                    wikiPages={props.pages.filter((page) => page.state === "active")}
                    value={withoutRepeatedTitle(revision().body, revision().title)}
                  />
                  <Show when={restoreError()}>
                    <p role="alert">{restoreError()}</p>
                  </Show>
                </article>
              )}
            </Show>
            <div class="knowledge-document" hidden={Boolean(historicalRevision())}>
              <header class="knowledge-heading workspace-heading">
                <div class="knowledge-title-row workspace-heading-title">
                  <Show
                    when={!props.openDocument && props.selectedPage}
                    fallback={<Icon name="ticket" />}
                  >
                    {(page) => (
                      <PageOrganization
                        page={page()}
                        pages={props.pages}
                        onMove={props.onMove}
                        onIcon={props.onIcon}
                      />
                    )}
                  </Show>
                  <Show
                    when={editing() && !props.openDocument}
                    fallback={
                      <h2 aria-label={props.openDocument?.title ?? draftTitle()}>
                        <Show when={!props.openDocument} fallback={props.openDocument?.title}>
                          <button
                            type="button"
                            class="knowledge-title-button"
                            aria-label="Edit Knowledge title"
                            onClick={beginEdit}
                          >
                            {draftTitle()}
                          </button>
                        </Show>
                      </h2>
                    }
                  >
                    <textarea
                      aria-label="Knowledge page title"
                      rows={1}
                      value={draftTitle()}
                      onInput={(event) => changeDraft("title", event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                    />
                  </Show>
                </div>
                <WorkspaceActionBar label="Wiki actions" leading={navigationTitle()}>
                  <div class="knowledge-page-actions" ref={pageMenu}>
                    <Show when={props.selectedPage && !props.openDocument}>
                      <button
                        type="button"
                        class="workspace-action workspace-menu-trigger"
                        aria-label="Page options"
                        aria-haspopup="menu"
                        aria-expanded={pageMenuOpen() ? "true" : "false"}
                        onClick={() => setPageMenuOpen((open) => !open)}
                      >
                        <Icon name="more" />
                      </button>
                      <Show when={pageMenuOpen()}>
                        <div class="knowledge-page-menu" role="menu" aria-label="Page options">
                          <Show when={!editing()}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setPageMenuOpen(false);
                                beginEdit();
                                requestAnimationFrame(() =>
                                  workspace
                                    ?.querySelector<HTMLTextAreaElement>(
                                      'textarea[aria-label="Knowledge page title"]',
                                    )
                                    ?.focus({ preventScroll: true }),
                                );
                              }}
                            >
                              <Icon name="file" />
                              Edit page
                            </button>
                          </Show>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPageMenuOpen(false);
                              void openHistory();
                            }}
                          >
                            <Icon name="history" />
                            History
                          </button>
                          <Show when={editing()}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setPageMenuOpen(false);
                                setEditing(false);
                              }}
                            >
                              <Icon name="knowledge" />
                              Read page
                            </button>
                          </Show>
                          <Show when={props.canDevelop}>
                            <button
                              type="button"
                              role="menuitem"
                              aria-disabled={sourcesLoading() ? "true" : undefined}
                              onClick={async () => {
                                if (sourcesLoading()) return;
                                const page = props.selectedPage;
                                if (!page) return;
                                const request = ++sourceRequest;
                                setSourcesLoading(true);
                                setSourcesError("");
                                try {
                                  const value = await props.onSources(page.id);
                                  if (request === sourceRequest && props.canDevelop)
                                    setSources(value);
                                } catch {
                                  if (request === sourceRequest)
                                    setSourcesError("Sources could not be loaded.");
                                } finally {
                                  if (request === sourceRequest) setSourcesLoading(false);
                                }
                              }}
                            >
                              <Icon name="link" />
                              {sourcesLoading() ? "Loading sources…" : "Sources"}
                            </button>
                            <Show when={sources()}>
                              {(items) => (
                                <div class="knowledge-menu-sources">
                                  <For each={items()}>
                                    {(citation) => (
                                      <a
                                        href={repositoryLink(
                                          props.repositoryURL,
                                          citation.commitSha,
                                          citation.path,
                                        )}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        {citation.path}
                                      </a>
                                    )}
                                  </For>
                                  <Show when={items().length === 0}>
                                    <small>No linked sources.</small>
                                  </Show>
                                </div>
                              )}
                            </Show>
                            <Show when={sourcesError()}>
                              <p role="alert">{sourcesError()}</p>
                            </Show>
                          </Show>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={props.pending || dirty()}
                            onClick={() => {
                              setPageMenuOpen(false);
                              props.onArchive();
                            }}
                          >
                            <Icon name="trash" />
                            Archive page
                          </button>
                        </div>
                      </Show>
                    </Show>
                  </div>
                  <Show when={draft()?.conflict}>
                    <button
                      type="button"
                      class="workspace-action"
                      onClick={() => setCompareOpen((open) => !open)}
                    >
                      Compare changes
                    </button>
                  </Show>
                  <Show
                    when={
                      props.openDocument &&
                      repositoryLink(
                        props.repositoryURL,
                        props.openDocument.commitSha,
                        props.openDocument.path,
                      )
                    }
                  >
                    {(href) => (
                      <a
                        class="workspace-action"
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View in Git
                      </a>
                    )}
                  </Show>
                  <Show when={props.openDocument && props.canDevelop}>
                    <button
                      type="button"
                      class="workspace-action"
                      data-primary="true"
                      onClick={props.onOpenIDE}
                    >
                      Open Project IDE
                    </button>
                  </Show>
                </WorkspaceActionBar>
                <Show when={!props.openDocument}>
                  <div class="workspace-heading-meta">
                    <SaveFeedback
                      state={
                        saveState() === "failed" || saveError()
                          ? "error"
                          : saveState() === "saving"
                            ? "saving"
                            : dirty()
                              ? "dirty"
                              : saveState() === "saved"
                                ? "saved"
                                : "idle"
                      }
                    />
                  </div>
                </Show>
              </header>
              <Show when={saveState() === "failed" || saveError()}>
                <div class="knowledge-save-error" role="alert">
                  <span>{saveError()} Your draft is retained.</span>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={saveState() === "saving"}
                    onClick={() => void save()}
                  >
                    Retry
                  </button>
                </div>
              </Show>
              <Show when={compareOpen() && draft()?.conflict}>
                <section class="knowledge-compare" aria-label="Compare changes">
                  <p>
                    This passage changed while you were editing. Choose a starting point; your draft
                    has not been overwritten.
                  </p>
                  <div>
                    <article>
                      <h3>Your draft</h3>
                      <pre>{draftBody()}</pre>
                    </article>
                    <article>
                      <h3>Saved page</h3>
                      <pre>
                        {withoutRepeatedTitle(
                          props.selectedPage?.currentBody ?? "",
                          props.selectedPage?.title ?? "",
                        )}
                      </pre>
                    </article>
                  </div>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => {
                      const page = props.selectedPage;
                      const current = draft();
                      if (!page || !current) return;
                      setDraft({ ...current, base: pageSnapshot(page), conflict: false });
                      setCompareOpen(false);
                      scheduleSave();
                    }}
                  >
                    Keep my draft
                  </button>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => {
                      const page = props.selectedPage;
                      if (!page) return;
                      setDraft(draftFrom(pageSnapshot(page)));
                      setCompareOpen(false);
                      retainDraft();
                    }}
                  >
                    Use saved page
                  </button>
                </section>
              </Show>
              <Show
                when={editing()}
                fallback={
                  <MarkdownReader
                    class="knowledge-article markdown-body"
                    label={props.openDocument ? "Repository document" : "Edit Knowledge body"}
                    scopeKey={`${props.projectID}:${props.openDocument?.path ?? props.selectedPage?.id}`}
                    onNavigate={props.openDocument ? undefined : navigateWiki}
                    wikiPages={
                      props.openDocument
                        ? undefined
                        : props.pages.filter((page) => page.state === "active")
                    }
                    onEdit={props.openDocument ? undefined : beginEdit}
                    value={
                      props.openDocument
                        ? withoutRepeatedTitle(props.openDocument.body, props.openDocument.title)
                        : draftBody()
                    }
                  />
                }
              >
                <MarkdownEditor
                  attachmentScopeKey={`wiki:${props.selectedPage?.id}`}
                  value={draftBody()}
                  onChange={(value) => changeDraft("body", value)}
                />
              </Show>
            </div>
          </Show>
        </main>
        <Show when={historyOpen()}>
          <div class="knowledge-version-panel">
            <Show when={historyError()}>
              <p role="alert">{historyError()}</p>
            </Show>
            <VersionHistory
              label="Knowledge history"
              selectedID={historyRevisionID()}
              loading={historyLoading()}
              versions={props.revisions.map((revision) => ({
                id: revision.id,
                label:
                  revision.id === props.selectedPage?.currentRevisionId
                    ? "Current version"
                    : revision.title,
                author: revision.kind === "human" ? (revision.author ?? "Human edit") : "AI",
                createdAt: revision.createdAt,
                state:
                  revision.kind === "proposed"
                    ? "Proposed"
                    : revision.kind === "human"
                      ? "Human edit"
                      : "AI update",
              }))}
              onSelect={setHistoryRevisionID}
              onClose={closeHistory}
              opener={
                pageMenu?.querySelector<HTMLButtonElement>('button[aria-label="Page options"]') ??
                undefined
              }
            />
          </div>
        </Show>
      </div>
    </div>
  );
}
