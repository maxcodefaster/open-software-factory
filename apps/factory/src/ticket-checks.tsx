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
  unsubmitted?: boolean | undefined;
}) {
  const unsubmitted = () => props.unsubmitted && Boolean(props.details?.verificationState);
  const passed = () => !unsubmitted() && props.details?.verificationState === "succeeded";
  const label = () => {
    if (props.building) return "Implementation in progress";
    if (unsubmitted()) return "Corrections not submitted";
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
    (!unsubmitted() &&
      ["pending", "runner-starting", "running"].includes(props.details?.verificationState ?? ""));
  return (
    <Show when={label()}>
      <details class="ticket-checks">
        <summary>
          <span
            class={`check-indicator ${busy() ? "busy" : passed() ? "passed" : "attention"}`}
            aria-hidden="true"
          >
            {busy() ? "" : passed() ? "✓" : "!"}
          </span>
          <span>{label()}</span>
        </summary>
        <div class="ticket-check-details">
          <Show
            when={props.building}
            fallback={
              <p>
                {unsubmitted()
                  ? "Earlier checks do not verify the retained corrections. Finish and submit them before review."
                  : "Checks verify the exact implemented version."}
              </p>
            }
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
