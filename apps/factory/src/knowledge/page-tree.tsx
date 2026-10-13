import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { pageSiblings } from "../../../../packages/knowledge-domain/src/page-tree";
import type { KnowledgePage, RepositoryDocument } from "../api-contracts";
import { Icon } from "../icon";

export type PageMove = { pageId: string; parentId: string | null; beforeId: string | null };
type Folder = { path: string; name: string; folders: Folder[]; documents: RepositoryDocument[] };
export function repositoryFolders(documents: readonly RepositoryDocument[]): Folder {
  const root: Folder = { path: "", name: "Repository documents", folders: [], documents: [] };
  for (const document of documents) {
    const parts = document.path.split("/");
    parts.pop();
    let folder = root;
    for (const name of parts) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.folders.find((entry) => entry.path === path);
      if (!child) {
        child = { path, name, folders: [], documents: [] };
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.documents.push(document);
  }
  return root;
}

const transferType = "application/x-factory-wiki-page";
type DropPosition = "before" | "inside" | "after";
export function pageDropPosition(y: number, top: number, height: number): DropPosition {
  const fraction = (y - top) / height;
  return fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "inside";
}
export function KnowledgeTree(props: {
  projectID: string;
  pages: KnowledgePage[];
  documents: RepositoryDocument[];
  canDevelop: boolean;
  onSearch(): void;
  selectedPageID?: string | undefined;
  selectedDocumentPath?: string | undefined;
  search: boolean;
  snippet(id: string): string | undefined;
  onSelectPage(id: string): void;
  onOpenDocument(path: string): void;
  onMove(move: PageMove): Promise<void>;
}) {
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["wiki"]));
  const [notice, setNotice] = createSignal("");
  const [rejected, setRejected] = createSignal("");
  const [dropTarget, setDropTarget] = createSignal("");
  const [dropPosition, setDropPosition] = createSignal<DropPosition>("inside");
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let shakeTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(noticeTimer);
    clearTimeout(shakeTimer);
  });
  createEffect(
    () => props.projectID,
    (id) => {
      let keys = ["wiki"];
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(`wiki-tree:${id}`) ?? "null");
        if (Array.isArray(stored) && stored.every((key) => typeof key === "string")) keys = stored;
      } catch {
        /* Browser storage is optional. */
      }
      setExpanded(new Set(keys));
    },
  );
  const isExpanded = (key: string) => props.search || expanded().has(key);
  function toggle(key: string) {
    const keys = new Set(expanded());
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    setExpanded(keys);
    try {
      localStorage.setItem(`wiki-tree:${props.projectID}`, JSON.stringify([...keys]));
    } catch {
      /* Navigation works without storage. */
    }
  }
  function reject(
    key: string,
    message = "Repository documents are read-only. Move source files in the IDE.",
  ) {
    clearTimeout(noticeTimer);
    clearTimeout(shakeTimer);
    setNotice(message);
    setRejected(key);
    shakeTimer = setTimeout(() => setRejected(""), 400);
    noticeTimer = setTimeout(() => setNotice(""), 4500);
  }
  async function move(input: PageMove) {
    setDropTarget("");
    try {
      await props.onMove(input);
    } catch (cause) {
      reject(
        input.pageId,
        cause instanceof Error ? cause.message : "Page could not be moved. Try again.",
      );
    }
  }
  function draggedPage(event: DragEvent) {
    try {
      const input: unknown = JSON.parse(event.dataTransfer?.getData(transferType) ?? "null");
      if (!input || typeof input !== "object" || !("projectID" in input) || !("pageID" in input))
        return;
      if (input.projectID !== props.projectID || typeof input.pageID !== "string") return;
      return input.pageID;
    } catch {
      return;
    }
  }
  function PageBranch(branch: { parentID: string | null; depth: number }) {
    const children = () =>
      props.search && branch.parentID === null
        ? [...props.pages].sort((a, b) => a.title.localeCompare(b.title))
        : pageSiblings(props.pages, branch.parentID);
    return (
      <For each={children()}>
        {(page) => {
          const hasChildren = () =>
            !props.search && props.pages.some((child) => child.parentId === page.id);
          return (
            <div class="wiki-branch">
              <section
                aria-label={`Move ${page.title}`}
                class={`wiki-tree-row${props.selectedPageID === page.id ? " selected" : ""}${rejected() === page.id ? " movement-rejected" : ""}${dropTarget() === page.id ? ` drop-${dropPosition()}` : ""}`}
                data-drop-position={dropTarget() === page.id ? dropPosition() : undefined}
                style={{ "--tree-depth": branch.depth }}
                draggable={props.search ? "false" : "true"}
                onDragStart={(event) => {
                  event.dataTransfer?.setData(
                    transferType,
                    JSON.stringify({ projectID: props.projectID, pageID: page.id }),
                  );
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDropTarget("")}
                onDragOver={(event) => {
                  if (event.dataTransfer?.types.includes(transferType)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDropPosition(pageDropPosition(event.clientY, rect.top, rect.height));
                    setDropTarget(page.id);
                  }
                }}
                onDragLeave={(event) => {
                  if (
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.contains(event.relatedTarget)
                  )
                    return;
                  if (dropTarget() === page.id) setDropTarget("");
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const pageId = draggedPage(event);
                  if (!pageId) {
                    reject(page.id, "Only Wiki pages from this Project can be moved here.");
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  const position = pageDropPosition(event.clientY, rect.top, rect.height);
                  const siblings = pageSiblings(props.pages, page.parentId ?? null);
                  const next =
                    siblings[siblings.findIndex((sibling) => sibling.id === page.id) + 1];
                  if (pageId === page.id) {
                    setDropTarget("");
                    return;
                  }
                  if (position === "inside") setExpanded(new Set([...expanded(), page.id]));
                  void move({
                    pageId,
                    parentId: position === "inside" ? page.id : (page.parentId ?? null),
                    beforeId:
                      position === "before"
                        ? page.id
                        : position === "after"
                          ? (next?.id ?? null)
                          : null,
                  });
                }}
              >
                <Show when={hasChildren()} fallback={<span class="tree-toggle-placeholder" />}>
                  <button
                    type="button"
                    class="tree-toggle"
                    aria-label={`Toggle ${page.title} children`}
                    aria-expanded={isExpanded(page.id) ? "true" : "false"}
                    onClick={() => toggle(page.id)}
                  >
                    <Icon name="chevron" />
                  </button>
                </Show>
                <button
                  type="button"
                  class="tree-page"
                  aria-label={page.title}
                  onClick={() => props.onSelectPage(page.id)}
                >
                  <Icon name={page.icon} />
                  <span>
                    {page.title}
                    <Show when={props.search}>
                      <small>{props.snippet(page.id)}</small>
                    </Show>
                  </span>
                </button>
              </section>
              <Show when={hasChildren() && isExpanded(page.id)}>
                <PageBranch parentID={page.id} depth={branch.depth + 1} />
              </Show>
            </div>
          );
        }}
      </For>
    );
  }
  function SourceBranch(branch: { folder: Folder; depth: number }) {
    return (
      <>
        <For each={[...branch.folder.folders].sort((a, b) => a.name.localeCompare(b.name))}>
          {(folder) => (
            <div>
              <button
                type="button"
                class="tree-folder"
                style={{ "--tree-depth": branch.depth }}
                aria-expanded={isExpanded(`source:${folder.path}`) ? "true" : "false"}
                onClick={() => toggle(`source:${folder.path}`)}
              >
                <Icon name="chevron" />
                <span>{folder.name}</span>
              </button>
              <Show when={isExpanded(`source:${folder.path}`)}>
                <SourceBranch folder={folder} depth={branch.depth + 1} />
              </Show>
            </div>
          )}
        </For>
        <For each={branch.folder.documents}>
          {(document) => (
            <section
              aria-label={`Source ${document.path}`}
              class={`wiki-tree-row${props.selectedDocumentPath === document.path ? " selected" : ""}${rejected() === document.path ? " movement-rejected" : ""}`}
              style={{ "--tree-depth": branch.depth }}
              draggable="true"
              onDragStart={(event) => {
                event.preventDefault();
                reject(document.path);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                reject(document.path);
              }}
            >
              <span class="tree-toggle-placeholder" />
              <button
                type="button"
                class="tree-page"
                aria-label={document.path}
                onClick={() => props.onOpenDocument(document.path)}
              >
                <Icon name="ticket" />
                <span>
                  {document.title}
                  <Show when={props.search}>
                    <small>
                      {document.path}
                      <br />
                      {props.snippet(`document:${document.path}`)}
                    </small>
                  </Show>
                </span>
              </button>
            </section>
          )}
        </For>
      </>
    );
  }
  return (
    <div class="knowledge-tree">
      <div class="wiki-root-row">
        <button
          type="button"
          class={`tree-root${dropTarget() === "wiki" ? " drop-target" : ""}`}
          aria-expanded={isExpanded("wiki") ? "true" : "false"}
          onClick={() => toggle("wiki")}
          onDragOver={(event) => {
            if (event.dataTransfer?.types.includes(transferType)) {
              event.preventDefault();
              setDropTarget("wiki");
            }
          }}
          onDragLeave={() => setDropTarget("")}
          onDrop={(event) => {
            event.preventDefault();
            const pageId = draggedPage(event);
            if (pageId) void move({ pageId, parentId: null, beforeId: null });
            else reject("wiki", "Only Wiki pages from this Project can be moved here.");
          }}
        >
          <Icon name="chevron" />
          <span>Wiki</span>
        </button>
        <button
          type="button"
          class="tree-search-button"
          aria-label="Search Wiki"
          title="Search Wiki"
          onClick={props.onSearch}
        >
          <Icon name="search" />
        </button>
      </div>
      <Show when={isExpanded("wiki")}>
        <PageBranch parentID={null} depth={0} />
      </Show>
      <Show when={props.canDevelop}>
        <button
          type="button"
          class={`tree-root${rejected() === "source" ? " movement-rejected" : ""}`}
          aria-expanded={isExpanded("source") ? "true" : "false"}
          onClick={() => toggle("source")}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            reject("source");
          }}
        >
          <Icon name="chevron" />
          <span>Code docs</span>
        </button>
        <Show when={isExpanded("source")}>
          <SourceBranch folder={repositoryFolders(props.documents)} depth={0} />
          <Show when={props.documents.length === 0}>
            <p class="tree-empty">This repository has no code documents.</p>
          </Show>
        </Show>
      </Show>
      <Show when={notice()}>
        <p class="wiki-tree-notice" role="status">
          {notice()}
        </p>
      </Show>
    </div>
  );
}
