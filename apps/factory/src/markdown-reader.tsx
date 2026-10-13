import { createSignal, Show } from "solid-js";
import { markdownHTML } from "./markdown";

export function MarkdownReader(props: {
  value: string;
  label: string;
  class: string;
  onEdit?: (() => void) | undefined;
  onNavigate?: ((href: string) => boolean) | undefined;
}) {
  const [copyError, setCopyError] = createSignal("");
  return (
    <>
      <article
        class={props.class}
        tabindex={props.onEdit ? "0" : undefined}
        aria-label={props.label}
        innerHTML={markdownHTML(props.value, true)}
        onClick={async (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const link = target.closest<HTMLAnchorElement>("a");
          if (
            link &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey &&
            props.onNavigate?.(link.getAttribute("href") ?? "")
          ) {
            event.preventDefault();
            return;
          }
          const button = target.closest<HTMLButtonElement>('button[aria-label="Copy code"]');
          if (button) {
            try {
              await navigator.clipboard.writeText(
                button.closest("pre")?.querySelector("code")?.textContent ?? "",
              );
              button.textContent = "Copied";
              setCopyError("");
            } catch {
              setCopyError("Could not copy. Select the code to copy manually.");
            }
            return;
          }
          if (!target.closest("a,input,button")) props.onEdit?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget && props.onEdit) {
            event.preventDefault();
            props.onEdit();
          }
        }}
      />
      <Show when={copyError()}>
        <small role="status">{copyError()}</small>
      </Show>
    </>
  );
}
