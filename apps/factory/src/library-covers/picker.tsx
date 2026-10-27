import { createSignal, For, Show } from "solid-js";
import {
  libraryCoverCatalog,
  type LibraryCover,
  type LibraryCoverKey,
} from "../../../../packages/conversation-domain/src/library-covers";
import { libraryCoverURL } from "./catalog";
import "./picker.css";

export function LibraryCoverPicker(props: {
  kind: "skill" | "mcp";
  cover?: LibraryCover | null | undefined;
  busy: boolean;
  onSave: (key: LibraryCoverKey, expectedVersion: number) => Promise<boolean>;
}) {
  const [open, setOpen] = createSignal(false);
  const [selected, setSelected] = createSignal<LibraryCoverKey>();
  const [basis, setBasis] = createSignal(0);
  const [error, setError] = createSignal("");
  const identity = `library-cover-${crypto.randomUUID()}`;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  const selectedName = () => libraryCoverCatalog.find((cover) => cover.key === selected())?.name;
  function close() {
    setOpen(false);
    setError("");
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  }
  async function save() {
    const key = selected();
    if (!key || props.busy) return;
    setError("");
    if (await props.onSave(key, basis())) close();
    else setError("Your cover choice is kept. Try again, or reload the library if it changed.");
  }
  return (
    <section
      class="library-cover-picker"
      data-kind={props.kind}
      aria-label="Cover appearance"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open()) {
          event.preventDefault();
          event.stopPropagation();
          if (!props.busy) close();
        }
      }}
    >
      <button
        ref={(element) => {
          trigger = element;
        }}
        type="button"
        class="quiet-button"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={identity}
        disabled={props.busy}
        onClick={() => {
          if (open()) return close();
          setSelected(props.cover?.key);
          setBasis(props.cover?.version ?? 0);
          setError("");
          setOpen(true);
          requestAnimationFrame(() =>
            (
              panel?.querySelector<HTMLInputElement>("input:checked") ??
              panel?.querySelector<HTMLInputElement>("input")
            )?.focus(),
          );
        }}
      >
        Change cover
      </button>
      <Show when={open()}>
        <section
          id={identity}
          class="library-cover-panel"
          aria-label="Cover selection"
          ref={(element) => {
            panel = element;
          }}
        >
          <fieldset disabled={props.busy}>
            <legend>Choose a cover</legend>
            <div class="library-cover-options">
              <For each={libraryCoverCatalog}>
                {(cover) => (
                  <label class="library-cover-option">
                    <img
                      src={libraryCoverURL(cover.key, props.kind)}
                      width={props.kind === "skill" ? 384 : 768}
                      height="512"
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                    <span>
                      <input
                        type="radio"
                        name={identity}
                        value={cover.key}
                        checked={selected() === cover.key}
                        onChange={() => {
                          setSelected(cover.key);
                          setError("");
                        }}
                      />
                      {cover.name}
                    </span>
                  </label>
                )}
              </For>
            </div>
          </fieldset>
          <p class="library-cover-selection" aria-live="polite">
            {selectedName() ? `${selectedName()} selected` : "Select an illustration."}
          </p>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <div class="model-settings-actions">
            <button type="button" class="quiet-button" disabled={props.busy} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              class="primary-button"
              disabled={props.busy || !selected() || selected() === props.cover?.key}
              onClick={() => void save()}
            >
              {props.busy ? "Saving…" : "Save cover"}
            </button>
          </div>
        </section>
      </Show>
    </section>
  );
}
