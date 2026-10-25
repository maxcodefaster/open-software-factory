import { createSignal, createUniqueId, onSettled, Show } from "solid-js";
import { Icon } from "./icon";

export function DocumentLinkEditor(props: {
  inputLabel: string;
  onInsert(href: string): void;
  onCancel(): void;
}) {
  const id = createUniqueId();
  const [address, setAddress] = createSignal("");
  const [error, setError] = createSignal("");
  let input: HTMLInputElement | undefined;
  onSettled(() => input?.focus({ preventScroll: true }));

  function insert() {
    const value = address().trim();
    if (!value) return;
    const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      if (!["http:", "https:"].includes(new URL(href).protocol)) throw new Error("Unsupported URL");
    } catch {
      setError("Enter a valid web address.");
      return;
    }
    props.onInsert(href);
  }

  return (
    <form
      class="document-link-editor"
      aria-label="Insert link"
      onSubmit={(event) => {
        event.preventDefault();
        insert();
      }}
    >
      <div class="document-link-heading">
        <label for={id}>Link address</label>
        <button
          type="button"
          class="document-link-cancel"
          aria-label="Cancel link"
          title="Cancel link"
          onClick={props.onCancel}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="document-link-fields">
        <input
          id={id}
          ref={input}
          aria-label={props.inputLabel}
          aria-invalid={error() ? "true" : undefined}
          aria-describedby={error() ? `${id}-error` : undefined}
          placeholder="Paste or type a URL"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          inputmode="url"
          value={address()}
          onInput={(event) => {
            setAddress(event.currentTarget.value);
            setError("");
          }}
        />
        <button type="submit" class="document-link-insert" disabled={!address().trim()}>
          Insert link
        </button>
      </div>
      <Show when={error()}>
        <p id={`${id}-error`} class="document-link-error" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  );
}
