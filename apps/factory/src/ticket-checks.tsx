import { Show } from "solid-js";

export type TicketCheckDetails = {
  verificationState?: string | undefined;
  verificationSummary?: string | undefined;
  actionRunUrl?: string | undefined;
  promotionState?: string | undefined;
  cleanupError?: string | undefined;
};

export function TicketChecks(props: {
  details: TicketCheckDetails | undefined;
  building: boolean;
}) {
  const label = () => {
    if (props.building) return "Implementation in progress";
    switch (props.details?.verificationState) {
      case "succeeded":
        return "Checks passed";
      case "failed":
        return "Checks need attention";
      case "running":
        return "Checks running";
      case "runner-starting":
      case "pending":
        return "Preparing checks";
      case "cancelled":
        return "Checks stopped";
      default:
        return undefined;
    }
  };
  const busy = () =>
    props.building ||
    ["pending", "runner-starting", "running"].includes(props.details?.verificationState ?? "");
  return (
    <Show when={label()}>
      <details class="ticket-checks">
        <summary>
          <span
            class={`check-indicator ${busy() ? "busy" : props.details?.verificationState === "succeeded" ? "passed" : "attention"}`}
            aria-hidden="true"
          >
            {busy() ? "" : props.details?.verificationState === "succeeded" ? "✓" : "!"}
          </span>
          <span>{label()}</span>
        </summary>
        <div class="ticket-check-details">
          <Show
            when={props.building}
            fallback={<p>Checks verify the exact implemented version.</p>}
          >
            <p>Earlier check results do not approve these corrections.</p>
          </Show>
          <Show when={props.details?.actionRunUrl}>
            <a href={props.details?.actionRunUrl} target="_blank" rel="noreferrer">
              Open Forgejo checks
            </a>
          </Show>
          <Show when={props.details?.verificationSummary && !props.building}>
            <p>{props.details?.verificationSummary}</p>
          </Show>
          <Show when={props.details?.promotionState}>
            <p>Delivery · {props.details?.promotionState}</p>
          </Show>
          <Show when={props.details?.cleanupError}>
            <p>Delivery is complete. Resource cleanup needs attention.</p>
          </Show>
        </div>
      </details>
    </Show>
  );
}
