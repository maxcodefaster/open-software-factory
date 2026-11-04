import { Show } from "solid-js";
import { Icon } from "./icon";

export function DesktopEmpty(props: { onChoose(): void }) {
  return (
    <div class="desktop-empty">
      <p>Choose a Project to open its Ticket board.</p>
      <button type="button" class="quiet-button" onClick={props.onChoose}>
        Choose project
      </button>
    </div>
  );
}

export function WindowHeading(props: {
  eyebrow: string;
  title: string;
  titleID?: string;
  description?: string;
  onClose?: () => void;
}) {
  return (
    <header class="window-heading">
      <div>
        <p>{props.eyebrow}</p>
        <h2 id={props.titleID}>{props.title}</h2>
        <Show when={props.description}>
          <span>{props.description}</span>
        </Show>
      </div>
      <Show when={props.onClose}>
        {(onClose) => (
          <button
            type="button"
            class="bare-icon"
            aria-label="Close workspace"
            title="Close workspace"
            onClick={onClose()}
          >
            <Icon name="close" />
          </button>
        )}
      </Show>
    </header>
  );
}

export { InboxWorkspace } from "./inbox/workspace";
