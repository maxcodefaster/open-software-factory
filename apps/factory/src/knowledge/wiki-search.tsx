import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { KnowledgeSearchResult } from "../api-contracts";
import { bindDialogKeyboard } from "../dialog-keyboard";
import { Icon } from "../icon";

export function WikiSearch(props: {
  query: string;
  results: KnowledgeSearchResult[];
  canDevelop: boolean;
  onSearch(query: string): void;
  onSelect(result: KnowledgeSearchResult): void;
  onClose(): void;
}) {
  const [text, setText] = createSignal(props.query);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unbind: (() => void) | undefined;
  createEffect(
    () => props.query,
    (query) => {
      setText(query);
    },
  );
  onCleanup(() => {
    clearTimeout(timer);
    unbind?.();
  });
  const results = () =>
    props.results.filter((result) => props.canDevelop || result.kind === "page");
  return (
    <div
      class="wiki-search-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        class="wiki-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search Wiki"
        ref={(element) => {
          unbind = bindDialogKeyboard(element, props.onClose);
        }}
      >
        <form
          class="knowledge-search"
          onSubmit={(event) => {
            event.preventDefault();
            clearTimeout(timer);
            props.onSearch(text());
          }}
        >
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search Knowledge"
            placeholder={props.canDevelop ? "Search Wiki and code docs" : "Search Wiki"}
            value={text()}
            onInput={(event) => {
              const query = event.currentTarget.value;
              setText(query);
              clearTimeout(timer);
              if (!query.trim()) props.onSearch(query);
              else timer = setTimeout(() => props.onSearch(query), 180);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.currentTarget
                  .closest("section")
                  ?.querySelector<HTMLButtonElement>(".wiki-search-result")
                  ?.focus();
              }
            }}
          />
          <button
            type="button"
            class="icon-button"
            aria-label="Close search"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </form>
        <div class="wiki-search-results">
          <Show when={text().trim()} fallback={<p>Search titles and page content.</p>}>
            <For each={results()} fallback={<p>No matching pages.</p>}>
              {(result) => (
                <button
                  type="button"
                  class="wiki-search-result"
                  onClick={() => props.onSelect(result)}
                >
                  <Icon name={result.kind === "page" ? "knowledge" : "ticket"} />
                  <span>
                    <strong>{result.title}</strong>
                    <small>
                      {result.kind === "document" ? `Code docs · ${result.path}` : "Wiki"}
                    </small>
                    <p>{result.snippet}</p>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </section>
    </div>
  );
}
