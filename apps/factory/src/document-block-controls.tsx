import { createEffect, createSignal, For, Show } from "solid-js";
import { codeLanguages } from "./code-highlighting";
import type { DocumentBlockState, DocumentEditor, TableCommand } from "./document-model";
import { CopyButton } from "./ui/feedback";

const tableActions = [
  ["addColumnBefore", "Column before"],
  ["addColumnAfter", "Column after"],
  ["addRowBefore", "Row above"],
  ["addRowAfter", "Row below"],
  ["toggleHeaderRow", "Header row"],
  ["deleteColumn", "Delete column"],
  ["deleteRow", "Delete row"],
  ["deleteTable", "Delete table"],
] as const satisfies ReadonlyArray<readonly [TableCommand, string]>;

export function DocumentBlockControls(props: {
  state: DocumentBlockState | undefined;
  editor: DocumentEditor | undefined;
  host: HTMLElement | undefined;
  editable: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const code = () => {
    const state = props.state;
    return state?.kind === "code" ? state : undefined;
  };
  let controls: HTMLDivElement | undefined;
  let tableButton: HTMLButtonElement | undefined;
  createEffect(
    () => open(),
    (opened) => {
      if (!opened) return;
      const outside = (event: PointerEvent) => {
        if (event.target instanceof Node && !controls?.contains(event.target)) setOpen(false);
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          tableButton?.focus();
        }
      };
      document.addEventListener("pointerdown", outside);
      document.addEventListener("keydown", closeOnEscape, true);
      return () => {
        document.removeEventListener("pointerdown", outside);
        document.removeEventListener("keydown", closeOnEscape, true);
      };
    },
  );
  createEffect(
    () => props.state,
    () => {
      setOpen(false);
    },
  );
  createEffect(
    () => ({ state: props.state, host: props.host }),
    ({ state, host }) => {
      if (!state || !host) return;
      const place = () => {
        if (!controls || !state.element.isConnected) return;
        const root = host.getBoundingClientRect();
        const block = state.element.getBoundingClientRect();
        controls.style.top = `${block.top - root.top}px`;
        controls.style.right = "0px";
      };
      const resize = new ResizeObserver(place);
      resize.observe(host);
      queueMicrotask(place);
      return () => resize.disconnect();
    },
  );
  return (
    <Show when={props.state}>
      {(state) => (
        <div
          class="document-block-controls"
          role="toolbar"
          aria-label="Document block controls"
          ref={controls}
          onMouseDown={(event) => {
            if (!(event.target instanceof HTMLSelectElement)) event.preventDefault();
          }}
        >
          <Show
            when={state().kind === "table" && props.editable}
            fallback={
              <Show when={state().kind === "code"}>
                <select
                  aria-label="Code language"
                  disabled={!props.editable}
                  value={code()?.language ?? "plaintext"}
                  onChange={(event) => props.editor?.language(event.currentTarget.value)}
                >
                  <For each={codeLanguages}>
                    {(language) => (
                      <option value={language}>
                        {language === "plaintext" ? "Plain text" : language}
                      </option>
                    )}
                  </For>
                  <Show
                    when={
                      code()?.language &&
                      !codeLanguages.some((language) => language === code()?.language)
                    }
                  >
                    <option value={code()?.language ?? ""}>{code()?.language}</option>
                  </Show>
                </select>
                <CopyButton
                  value={code()?.text ?? ""}
                  scope={code()?.element}
                  accessibleLabel="Copy code"
                  successMessage="Code copied"
                  errorMessage="Could not copy. Select the code to copy manually."
                />
              </Show>
            }
          >
            <button
              type="button"
              aria-expanded={open() ? "true" : "false"}
              aria-label="Table actions"
              ref={tableButton}
              onClick={() => setOpen((value) => !value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setOpen(true);
                  queueMicrotask(() =>
                    controls?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
                  );
                }
              }}
            >
              Table ···
            </button>
            <Show when={open()}>
              <div
                class="document-table-menu"
                role="menu"
                aria-label="Table actions"
                onKeyDown={(event) => {
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
                  );
                  const active = document.activeElement;
                  const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                          items.length;
                  items[next]?.focus();
                }}
              >
                <For each={tableActions}>
                  {([command, label]) => (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        props.editor?.table(command);
                        setOpen(false);
                      }}
                    >
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
}
