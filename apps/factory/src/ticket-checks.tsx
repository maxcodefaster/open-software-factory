import { For, Show } from "solid-js";
import type { CandidateReviewResult } from "../../../packages/conversation-domain/src/candidate-review";

export type TicketCheckDetails = {
  deliveryPolicyId?: string | undefined;
  openReviewThreads?: number | undefined;
  checksStopId?: string | undefined;
  verificationState?: string | undefined;
  verificationSummary?: string | undefined;
  verificationPreparationFailure?: string | undefined;
  verificationFailureKind?: string | undefined;
  correctionState?: string | undefined;
  actionRunUrl?: string | undefined;
  reviewState?: string | undefined;
  reviewCurrent?: boolean | undefined;
  reviewSummary?: string | undefined;
  reviewFindings?: CandidateReviewResult["findings"] | undefined;
  promotionState?: string | undefined;
  cleanupError?: string | undefined;
};

export function TicketChecks(props: {
  details: TicketCheckDetails | undefined;
  building: boolean;
  preparing?: boolean | undefined;
  paused?: boolean | undefined;
  unsubmitted?: boolean | undefined;
  fallback?: string | undefined;
}) {
  const unsubmitted = () =>
    !props.details?.checksStopId &&
    props.unsubmitted &&
    !props.details?.reviewCurrent &&
    Boolean(props.details?.verificationState);
  const passed = () =>
    !unsubmitted() &&
    props.details?.verificationState === "succeeded" &&
    props.details?.reviewState === "passed";
  const label = () => {
    if (props.details?.checksStopId) return "Checks paused";
    if (props.paused) return "Coding paused";
    if (["pending", "dispatching", "running"].includes(props.details?.correctionState ?? ""))
      return "Automatic correction in progress";
    if (!unsubmitted() && ["pending", "running"].includes(props.details?.reviewState ?? ""))
      return "Independent review in progress";
    if (props.building)
      return props.preparing ? "Preparing implementation" : "Implementation in progress";
    if (unsubmitted()) return "Corrections not submitted";
    switch (props.details?.verificationState) {
      case "succeeded":
        return props.details?.reviewState === "passed"
          ? "Checks and independent review passed"
          : props.details?.reviewState === "changes-requested"
            ? "Review found defects"
            : ["failed", "stopped", "uncertain", "incomplete"].includes(
                  props.details?.reviewState ?? "",
                )
              ? "Independent review needs attention"
              : "Preparing independent review";
      case "failed":
        return "Checks need attention";
      case "running":
        return "Checks running";
      case "runner-starting":
      case "pending":
        return props.details?.verificationPreparationFailure
          ? "Check preparation needs attention"
          : "Preparing checks";
      case "cancelled":
        return "Checks stopped";
      default:
        return undefined;
    }
  };
  const busy = () =>
    !props.paused &&
    !props.details?.checksStopId &&
    (["pending", "dispatching", "running"].includes(props.details?.correctionState ?? "") ||
      props.building ||
      (!unsubmitted() &&
        (["pending", "runner-starting", "running"].includes(
          props.details?.verificationState ?? "",
        ) ||
          (props.details?.verificationState === "succeeded" &&
            (!props.details.reviewState ||
              ["pending", "running"].includes(props.details.reviewState))))));
  return (
    <Show when={label()} fallback={props.fallback ? <span>{props.fallback}</span> : undefined}>
      <details class="ticket-checks">
        <summary>
          <Show when={!busy()}>
            <span class={`check-indicator ${passed() ? "passed" : "attention"}`} aria-hidden="true">
              {passed() ? "✓" : "!"}
            </span>
          </Show>
          <span>{label()}</span>
        </summary>
        <div class="ticket-check-details">
          <Show
            when={props.building && !props.details?.reviewCurrent}
            fallback={
              <p>
                {unsubmitted()
                  ? "Earlier checks do not verify the retained corrections. Finish and submit them before review."
                  : props.details?.checksStopId
                    ? "The submitted version is retained. Resume checks to continue verification and independent review without repeating implementation."
                    : "Checks and independent review assess the exact submitted version. Delivery still needs your approval."}
              </p>
            }
          >
            <p>
              {props.details?.verificationState
                ? "Earlier check results do not approve these corrections."
                : props.preparing
                  ? "Work starts automatically when preparation finishes. Your requirements and existing code are retained."
                  : "The coding agent is implementing the approved requirements. Checks and independent review follow source submission."}
            </p>
          </Show>
          <Show when={props.details?.actionRunUrl}>
            <a href={props.details?.actionRunUrl} target="_blank" rel="noreferrer">
              Open Forgejo checks
            </a>
          </Show>
          <Show
            when={
              props.details?.verificationSummary && (!props.building || props.details.reviewCurrent)
            }
          >
            <p>{props.details?.verificationSummary}</p>
          </Show>
          <Show
            when={
              !unsubmitted() &&
              ["pending", "runner-starting"].includes(props.details?.verificationState ?? "") &&
              props.details?.verificationPreparationFailure
            }
          >
            <p>Last preparation issue: {props.details?.verificationPreparationFailure}</p>
          </Show>
          <Show when={props.details?.reviewSummary}>
            <p>{props.details?.reviewSummary}</p>
          </Show>
          <Show when={props.details?.deliveryPolicyId}>
            <p>
              Delivery was authorized by the Project delegation, not an individual human review.
            </p>
          </Show>
          <For each={props.details?.reviewFindings}>
            {(finding) => (
              <details>
                <summary>
                  {finding.severity === "blocking" ? "Defect" : "Suggestion"} · {finding.title}
                </summary>
                <p>{finding.explanation}</p>
                <Show when={finding.path}>
                  <p>
                    <code>
                      {finding.path}
                      {finding.line ? `:${finding.line}` : ""}
                    </code>
                  </p>
                </Show>
                <p>{finding.reproduction}</p>
              </details>
            )}
          </For>
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
