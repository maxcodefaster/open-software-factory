import { Match, Switch } from "solid-js";

export type IconName =
  | "agent"
  | "agent-panel"
  | "chevron"
  | "close"
  | "external"
  | "epic"
  | "history"
  | "link"
  | "trash"
  | "check"
  | "home"
  | "ide"
  | "inbox"
  | "knowledge"
  | "minimize"
  | "more"
  | "play"
  | "preview"
  | "settings"
  | "search"
  | "stop"
  | "ticket";

export function Icon(props: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <Switch>
        <Match when={props.name === "epic"}>
          <path d="m12 3-9 5 9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" />
        </Match>
        <Match when={props.name === "history"}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </Match>
        <Match when={props.name === "link"}>
          <path d="m10 14 4-4m-6 5-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
        </Match>
        <Match when={props.name === "trash"}>
          <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
        </Match>
        <Match when={props.name === "check"}>
          <path d="m5 12 4 4L19 6" />
        </Match>
        <Match when={props.name === "agent"}>
          <path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2 2-6.5Z" />
        </Match>
        <Match when={props.name === "agent-panel"}>
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <path d="M9 4v16m7-11-3 3 3 3" />
        </Match>
        <Match when={props.name === "chevron"}>
          <path d="m8 10 4 4 4-4" />
        </Match>
        <Match when={props.name === "close"}>
          <path d="m7 7 10 10M17 7 7 17" />
        </Match>
        <Match when={props.name === "external"}>
          <path d="M14 5h5v5M19 5l-8 8M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </Match>
        <Match when={props.name === "home"}>
          <path d="m4 11 8-7 8 7M6.5 9.5V20h11V9.5M10 20v-6h4v6" />
        </Match>
        <Match when={props.name === "ide"}>
          <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14" />
        </Match>
        <Match when={props.name === "inbox"}>
          <path d="M5 5h14l2 9v5H3v-5l2-9Z" />
          <path d="M3 14h5l1.5 2h5L16 14h5" />
        </Match>
        <Match when={props.name === "knowledge"}>
          <path d="M4.5 5.5A3.5 3.5 0 0 1 8 2h4v18H8a3.5 3.5 0 0 0-3.5 2V5.5Z" />
          <path d="M19.5 5.5A3.5 3.5 0 0 0 16 2h-4v18h4a3.5 3.5 0 0 1 3.5 2V5.5Z" />
        </Match>
        <Match when={props.name === "minimize"}>
          <path d="M7 12h10" />
        </Match>
        <Match when={props.name === "more"}>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </Match>
        <Match when={props.name === "play"}>
          <path d="m9 7 8 5-8 5V7Z" />
        </Match>
        <Match when={props.name === "preview"}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18M7 7h.01M10 7h.01" />
        </Match>
        <Match when={props.name === "settings"}>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </Match>
        <Match when={props.name === "search"}>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 5 5" />
        </Match>
        <Match when={props.name === "stop"}>
          <rect x="7" y="7" width="10" height="10" rx="1" />
        </Match>
        <Match when={props.name === "ticket"}>
          <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
        </Match>
      </Switch>
    </svg>
  );
}
