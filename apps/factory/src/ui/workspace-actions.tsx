import type { JSX } from "@solidjs/web";
import { children, Show } from "solid-js";
import "./workspace-actions.css";

/** Page actions share one quiet row. Form and editor controls stay with their content. */
export function WorkspaceActionBar(props: {
  label: string;
  children: JSX.Element;
  leading?: JSX.Element;
  status?: JSX.Element;
  class?: string;
  hasPrimary?: boolean;
  collapsible?: boolean;
}) {
  const content = children(() => props.children);
  const status = children(() => props.status);
  const leading = children(() => props.leading);
  return (
    <fieldset
      class={`workspace-action-bar${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.label}
      data-has-primary={props.hasPrimary ? "true" : undefined}
      data-collapsible={props.collapsible ? "true" : undefined}
    >
      <Show when={leading()}>
        <div class="workspace-action-leading">{leading()}</div>
      </Show>
      <Show when={status()}>
        <div class="workspace-action-status">{status()}</div>
      </Show>
      {content()}
    </fieldset>
  );
}
