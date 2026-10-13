import { For, onCleanup } from "solid-js";
import { Icon } from "./icon";

export type DocumentVersion = {
  id: string;
  label: string;
  state: string;
  createdAt: string | undefined;
  author: string | undefined;
};

export function VersionHistory(props: {
  label: string;
  versions: readonly DocumentVersion[];
  selectedID: string | undefined;
  loading?: boolean;
  opener?: HTMLElement | undefined;
  onSelect(id: string): void;
  onClose(): void;
}) {
  let panel: HTMLElement | undefined;
  const origin = props.opener ?? document.activeElement;
  const close = () => {
    props.onClose();
    if (origin instanceof HTMLElement && origin.isConnected)
      queueMicrotask(() => origin.focus({ preventScroll: true }));
  };
  const handleEscape = (event: KeyboardEvent) => {
    const workspace = panel?.closest(".workspace-window");
    if (event.key !== "Escape" || !workspace?.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener("keydown", handleEscape);
  onCleanup(() => {
    document.removeEventListener("keydown", handleEscape);
  });
  return (
    <aside
      ref={(element) => {
        panel = element;
        queueMicrotask(() => element.isConnected && element.focus({ preventScroll: true }));
      }}
      tabindex="-1"
      class="version-history"
      aria-label={props.label}
      aria-busy={props.loading ? "true" : "false"}
    >
      <header>
        <h3>History</h3>
        <button
          type="button"
          class="icon-button"
          aria-label="Close history"
          title="Close history"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>
      <div class="version-history-list">
        <For each={props.versions}>
          {(version) => (
            <button
              type="button"
              class="version-history-item"
              aria-pressed={props.selectedID === version.id ? "true" : "false"}
              onClick={() => props.onSelect(version.id)}
            >
              <strong>{version.label}</strong>
              <span>{version.state}</span>
              <small>{version.author ?? "Author unavailable"}</small>
              <time datetime={version.createdAt}>
                {version.createdAt
                  ? new Date(version.createdAt).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "Date unavailable"}
              </time>
            </button>
          )}
        </For>
      </div>
    </aside>
  );
}
