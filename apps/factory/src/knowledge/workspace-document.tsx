import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import { withoutRepeatedTitle } from "#knowledge-domain/document-merge";
import type { knowledgeIcons } from "#knowledge-domain/page-tree";
import { MarkdownEditor } from "../editor/markdown-editor";
import { MarkdownReader } from "../editor/markdown-reader";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { SaveFeedback } from "../ui/feedback";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import type {
  KnowledgeGeneration,
  KnowledgePage,
  KnowledgePageOutline,
  OpenRepositoryDocument,
} from "./contracts";
import type { KnowledgeDraft } from "./draft";
import { PageOrganization } from "./page-organization";
import type { PageMove } from "./page-tree";
import { repositoryLink } from "./source-link";

function sentence(text: string) {
  const value = text.trim();
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

export function WorkspaceDocument(props: {
  documentKey: string;
  hidden: boolean;
  projectID: string;
  pages: KnowledgePageOutline[];
  selectedPage?: KnowledgePage | undefined;
  openDocument?: OpenRepositoryDocument | undefined;
  generation?: KnowledgeGeneration | undefined;
  pending: boolean;
  canDevelop: boolean;
  repositoryURL: string;
  editing: boolean;
  draft?: KnowledgeDraft | undefined;
  dirty: boolean;
  saveState: "idle" | "saving" | "saved" | "failed";
  saveError: string;
  leading: JSX.Element;
  onPageMenuRef(element: HTMLDivElement): void;
  onBeginEdit(): void;
  onStopEdit(): void;
  onChangeDraft(field: "title" | "body", value: string): void;
  onSave(): void;
  onKeepDraft(): void;
  onUseSavedPage(): void;
  onOpenHistory(): void;
  onGenerate(): void;
  onSources(pageID: string): Promise<Array<{ path: string; commitSha: string }>>;
  onArchive(): void;
  onMove(move: PageMove): Promise<void>;
  onIcon(icon: (typeof knowledgeIcons)[number]): Promise<void>;
  onOpenIDE(): void;
  onNavigate(href: string): boolean;
}) {
  const [compareOpen, setCompareOpen] = createSignal(false);
  const [pageMenuOpen, setPageMenuOpen] = createSignal(false);
  const [sources, setSources] = createSignal<Array<{ path: string; commitSha: string }>>();
  const [sourcesError, setSourcesError] = createSignal("");
  const [sourcesLoading, setSourcesLoading] = createSignal(false);
  let sourceRequest = 0;
  let documentRoot: HTMLDivElement | undefined;
  let pageMenu: HTMLDivElement | undefined;

  const draftTitle = () => props.draft?.title ?? "";
  const draftBody = () => props.draft?.body ?? "";

  createEffect(
    () => props.documentKey,
    () => {
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

  async function loadSources() {
    if (sourcesLoading()) return;
    const page = props.selectedPage;
    if (!page) return;
    const request = ++sourceRequest;
    setSourcesLoading(true);
    setSourcesError("");
    try {
      const value = await props.onSources(page.id);
      if (request === sourceRequest && props.canDevelop) setSources(value);
    } catch {
      if (request === sourceRequest) setSourcesError("Sources could not be loaded.");
    } finally {
      if (request === sourceRequest) setSourcesLoading(false);
    }
  }

  return (
    <div ref={documentRoot} class="knowledge-document" hidden={props.hidden}>
      <header class="knowledge-heading workspace-heading">
        <div
          class="knowledge-title-row workspace-heading-title"
          data-long={(props.openDocument?.title ?? draftTitle()).length > 20 ? "true" : undefined}
        >
          <Show when={!props.openDocument && props.selectedPage} fallback={<Icon name="ticket" />}>
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
            when={props.editing && !props.openDocument}
            fallback={
              <h2 aria-label={props.openDocument?.title ?? draftTitle()}>
                <Show when={!props.openDocument} fallback={props.openDocument?.title}>
                  <button
                    type="button"
                    class="knowledge-title-button"
                    aria-label={`${draftTitle()}, edit Wiki title`}
                    title="Edit Wiki title"
                    onClick={props.onBeginEdit}
                  >
                    {draftTitle()}
                  </button>
                </Show>
              </h2>
            }
          >
            <textarea
              aria-label="Wiki page title"
              rows={1}
              value={draftTitle()}
              onInput={(event) => props.onChangeDraft("title", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
          </Show>
        </div>
        <WorkspaceActionBar label="Wiki actions" leading={props.leading}>
          <Show when={props.editing && !props.openDocument}>
            <button
              type="button"
              class="workspace-action"
              data-primary="true"
              onClick={props.onStopEdit}
            >
              Done editing
            </button>
          </Show>
          <Show when={props.draft?.conflict}>
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
              <a class="workspace-action" href={href()} target="_blank" rel="noopener noreferrer">
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
          <div
            class="knowledge-page-actions"
            ref={(element) => {
              pageMenu = element;
              props.onPageMenuRef(element);
            }}
          >
            <Show when={props.selectedPage && !props.openDocument}>
              <button
                type="button"
                class="workspace-action workspace-menu-trigger"
                aria-label="Page options"
                title="Page options"
                aria-haspopup="menu"
                aria-expanded={pageMenuOpen() ? "true" : "false"}
                onClick={() => setPageMenuOpen((open) => !open)}
              >
                <Icon name="more" />
              </button>
              <Show when={pageMenuOpen()}>
                <div class="knowledge-page-menu" role="menu" aria-label="Page options">
                  <Show when={!props.editing}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPageMenuOpen(false);
                        props.onBeginEdit();
                        requestAnimationFrame(() =>
                          documentRoot
                            ?.querySelector<HTMLTextAreaElement>(
                              'textarea[aria-label="Wiki page title"]',
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
                      props.onOpenHistory();
                    }}
                  >
                    <Icon name="history" />
                    History
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      props.pending ||
                      ["pending", "running"].includes(props.generation?.state ?? "")
                    }
                    title="Updates this Project's Wiki from its current source. Keeps saved pages and human edits."
                    onClick={() => {
                      setPageMenuOpen(false);
                      props.onGenerate();
                    }}
                  >
                    <Icon name="refresh" />
                    Update Project Wiki
                  </button>
                  <Show when={props.editing}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPageMenuOpen(false);
                        props.onStopEdit();
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
                      onClick={() => void loadSources()}
                    >
                      <Icon name="link" />
                      {sourcesLoading() ? "Loading sources…" : "Sources"}
                    </button>
                    <Show when={sources()}>
                      {(items) => (
                        <fieldset class="knowledge-menu-sources" aria-label="Sources">
                          <For each={items()}>
                            {(citation) => (
                              <a
                                role="menuitem"
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
                        </fieldset>
                      )}
                    </Show>
                    <Show when={sourcesError()}>
                      <fieldset class="knowledge-menu-sources" aria-label="Sources">
                        <p role="alert">{sourcesError()}</p>
                      </fieldset>
                    </Show>
                  </Show>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={props.pending || props.dirty}
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
        </WorkspaceActionBar>
        <Show when={!props.openDocument}>
          <div class="workspace-heading-meta knowledge-heading-meta">
            <Show when={props.editing}>
              <span class="knowledge-editing-badge">Editing</span>
            </Show>
            <SaveFeedback
              state={
                props.saveState === "failed" || props.saveError
                  ? "error"
                  : props.saveState === "saving"
                    ? "saving"
                    : props.dirty
                      ? "dirty"
                      : props.saveState === "saved"
                        ? "saved"
                        : "idle"
              }
            />
          </div>
        </Show>
      </header>
      <Show when={props.saveState === "failed" || props.saveError}>
        <div class="knowledge-save-error" role="alert">
          <span>{sentence(props.saveError || "Your changes could not be saved.")}</span>
          <button
            type="button"
            class="quiet-button"
            disabled={props.saveState === "saving"}
            onClick={props.onSave}
          >
            Retry
          </button>
        </div>
      </Show>
      <Show when={compareOpen() && props.draft?.conflict}>
        <section class="knowledge-compare" aria-label="Compare changes">
          <p>
            This passage changed while you were editing. Choose a starting point; your draft has not
            been overwritten.
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
              props.onKeepDraft();
              setCompareOpen(false);
            }}
          >
            Keep my draft
          </button>
          <button
            type="button"
            class="quiet-button"
            onClick={() => {
              props.onUseSavedPage();
              setCompareOpen(false);
            }}
          >
            Use saved page
          </button>
        </section>
      </Show>
      <Show
        when={props.editing}
        fallback={
          <MarkdownReader
            class="knowledge-article markdown-body"
            label={props.openDocument ? "Repository document" : "Edit Wiki body"}
            scopeKey={`${props.projectID}:${props.openDocument?.path ?? props.selectedPage?.id}`}
            onNavigate={props.openDocument ? undefined : props.onNavigate}
            wikiPages={
              props.openDocument ? undefined : props.pages.filter((page) => page.state === "active")
            }
            onEdit={props.openDocument ? undefined : props.onBeginEdit}
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
          onChange={(value) => props.onChangeDraft("body", value)}
        />
      </Show>
    </div>
  );
}
