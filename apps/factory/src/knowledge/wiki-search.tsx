import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { KnowledgeSearchResult } from "../api-contracts";
import { bindDialogKeyboard } from "../dialog-keyboard";
import { Icon } from "../icon";

export function WikiSearch(props: {
  query: string;
  results: KnowledgeSearchResult[];
  canDevelop: boolean;
  onSearch(query: string): Promise<"found" | "failed" | "superseded">;
  onSelect(result: KnowledgeSearchResult): void;
  onClose(): void;
}) {
  const [text, setText] = createSignal(untrack(() => props.query));
  const [status, setStatus] = createSignal<"idle" | "searching" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  function search(query: string) {
    const current = ++sequence;
    const pending = props.onSearch(query);
    if (!query.trim()) {
      setStatus("idle");
      return;
    }
    setStatus("searching");
    void pending.then(
      (outcome) => {
        if (current === sequence && outcome !== "superseded")
          setStatus(outcome === "failed" ? "failed" : "idle");
      },
      () => {
        if (current === sequence) setStatus("failed");
      },
    );
  }
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
            search(text());
          }}
        >
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search Wiki"
            placeholder={props.canDevelop ? "Search Wiki and code docs" : "Search Wiki"}
            value={text()}
            onInput={(event) => {
              const query = event.currentTarget.value;
              setText(query);
              clearTimeout(timer);
              if (!query.trim()) search(query);
              else {
                setStatus("searching");
                timer = setTimeout(() => search(query), 180);
              }
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
            title="Close search"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </form>
        <div class="wiki-search-results" aria-busy={status() === "searching" ? "true" : "false"}>
          <Show when={text().trim()} fallback={<p>Search titles and page content.</p>}>
            <Show when={status() === "failed"}>
              <p role="alert">
                Search failed. Your connection or the server may be unavailable.{" "}
                <button type="button" class="quiet-button" onClick={() => search(text())}>
                  Try again
                </button>
              </p>
            </Show>
            <Show when={status() === "searching"}>
              <p role="status">Searching…</p>
            </Show>
            <For
              each={status() === "failed" ? [] : results()}
              fallback={
                <Show when={status() === "idle"}>
                  <p>No matching pages.</p>
                </Show>
              }
            >
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
