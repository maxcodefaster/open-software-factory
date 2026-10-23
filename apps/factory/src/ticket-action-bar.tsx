import { children, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useAttachmentPending } from "./attachments/ui";
import { WorkspaceActionBar } from "./ui/workspace-actions";

export type TicketHeaderAction = {
  id: string;
  label: string;
  disabled?: boolean;
  title?: string | undefined;
  primary?: boolean;
  run(): void;
};

/** Overflow first, context actions next, one next-step action at the right edge. */
export function TicketActionBar(props: {
  actions: readonly TicketHeaderAction[];
  menu?: JSX.Element;
  status?: string | undefined;
}) {
  const menu = children(() => props.menu);
  const uploading = useAttachmentPending();
  const primary = () => props.actions.find((action) => action.primary)?.id;
  const ordered = () => [
    ...props.actions.filter((action) => action.id !== primary()),
    ...props.actions.filter((action) => action.id === primary()),
  ];
  return (
    <WorkspaceActionBar
      class="ticket-header-actions"
      label="Ticket actions"
      hasPrimary={Boolean(primary())}
      collapsible={Boolean(menu())}
      status={
        <Show when={props.status}>
          <span class="clarification-status" role="status">
            {props.status}
          </span>
        </Show>
      }
    >
      {menu()}
      <For each={ordered()} keyed={(action) => action.id}>
        {(action) => (
          <button
            type="button"
            class="workspace-action ticket-header-action"
            data-primary={action().id === primary() ? "true" : undefined}
            disabled={action().disabled || uploading()}
            title={uploading() ? "Wait for file preparation to finish." : action().title}
            onClick={() => action().run()}
          >
            {action().label}
          </button>
        )}
      </For>
    </WorkspaceActionBar>
  );
}
