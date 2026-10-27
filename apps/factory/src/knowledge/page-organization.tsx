import { createSignal, For, Show, onCleanup } from "solid-js";
import {
  knowledgeIcons,
  pageParentWouldCycle,
  pageSiblings,
} from "../../../../packages/knowledge-domain/src/page-tree";
import type { KnowledgePage, KnowledgePageOutline } from "../api-contracts";
import { Icon } from "../icon";
import type { PageMove } from "./page-tree";

export function PageOrganization(props: {
  page: KnowledgePage;
  pages: KnowledgePageOutline[];
  onMove(move: PageMove): Promise<void>;
  onIcon(icon: (typeof knowledgeIcons)[number]): Promise<void>;
}) {
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  let menu: HTMLDetailsElement | undefined;
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && menu?.open && !menu.contains(event.target))
      menu.open = false;
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && menu?.open) {
      event.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  };
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", closeOnEscape);
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside);
    document.removeEventListener("keydown", closeOnEscape);
  });
  async function change(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Page could not be updated.");
    } finally {
      setPending(false);
    }
  }
  const siblings = () => pageSiblings(props.pages, props.page.parentId ?? null);
  const position = () => siblings().findIndex((page) => page.id === props.page.id);
  function reorder(direction: -1 | 1) {
    const list = siblings();
    const index = position();
    const beforeId =
      direction === -1 ? (list[index - 1]?.id ?? null) : (list[index + 2]?.id ?? null);
    void change(() =>
      props.onMove({ pageId: props.page.id, parentId: props.page.parentId ?? null, beforeId }),
    );
  }
  return (
    <details class="page-organization" ref={menu}>
      <summary aria-label="Organize Wiki page">
        <Icon name={props.page.icon} />
      </summary>
      <div class="page-organization-menu">
        <fieldset class="page-icon-options" aria-label="Page icon">
          <For each={knowledgeIcons}>
            {(icon) => (
              <button
                type="button"
                aria-label={`Use ${icon} icon`}
                aria-pressed={props.page.icon === icon ? "true" : "false"}
                disabled={pending()}
                onClick={() => void change(() => props.onIcon(icon))}
              >
                <Icon name={icon} />
              </button>
            )}
          </For>
        </fieldset>
        <label>
          Move page
          <select
            aria-label="Parent page"
            disabled={pending()}
            value={props.page.parentId ?? ""}
            onChange={(event) => {
              const parentId = event.currentTarget.value || null;
              void change(() => props.onMove({ pageId: props.page.id, parentId, beforeId: null }));
            }}
          >
            <option value="">Wiki root</option>
            <For
              each={props.pages.filter(
                (page) => !pageParentWouldCycle(props.pages, props.page.id, page.id),
              )}
            >
              {(page) => <option value={page.id}>{page.title}</option>}
            </For>
          </select>
        </label>
        <div class="page-order-actions">
          <button type="button" disabled={pending() || position() <= 0} onClick={() => reorder(-1)}>
            Move up
          </button>
          <button
            type="button"
            disabled={pending() || position() === siblings().length - 1}
            onClick={() => reorder(1)}
          >
            Move down
          </button>
        </div>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </div>
    </details>
  );
}
