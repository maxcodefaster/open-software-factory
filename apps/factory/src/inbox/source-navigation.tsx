import { Icon } from "../icon";
import type { InboxItem } from "./contracts";
import "./inbox.css";

export function InboxSourceNavigation(props: {
  next: InboxItem | undefined;
  busy: boolean;
  onBack(): void;
  onNext(): void;
}) {
  return (
    <nav class="inbox-source-navigation" aria-label="Inbox queue">
      <button type="button" class="workspace-action" onClick={props.onBack}>
        <Icon name="chevron" />
        Back to Inbox
      </button>
      <button
        type="button"
        class="workspace-action"
        disabled={props.busy || !props.next}
        title={
          props.next
            ? `${props.next.projectName} · ${props.next.ticketTitle}`
            : "No more items in this queue"
        }
        onClick={props.onNext}
      >
        Next item
        <Icon name="chevron" />
      </button>
    </nav>
  );
}
