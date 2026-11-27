import type { TicketTechnicalBadgeState } from "./ticket-section-state";

export function resolveHeaderPlanningBadges(options: {
  technicalBadge: TicketTechnicalBadgeState;
  hasChange: boolean;
  hasProposal: boolean;
  technicalPlanningPending: boolean;
  planningBusy: boolean;
  canInterview: boolean;
  clarificationAction: { label: string; status: boolean };
}): {
  technicalBadge: { label: string; live: boolean } | undefined;
  clarificationStatus: string | undefined;
} {
  const technicalPlanningActive = Boolean(
    !options.hasChange &&
      !options.hasProposal &&
      options.technicalPlanningPending &&
      (options.planningBusy ||
        (options.clarificationAction.status &&
          options.clarificationAction.label === "Clarification in progress")),
  );
  const technicalBadge =
    options.technicalBadge.kind === "hidden"
      ? undefined
      : options.technicalBadge.kind === "planning-required" && technicalPlanningActive
        ? { label: "Technical planning in progress", live: true }
        : { label: options.technicalBadge.label, live: false };
  const clarificationStatus =
    options.canInterview && options.clarificationAction.status && !technicalPlanningActive
      ? options.clarificationAction.label
      : undefined;
  return { technicalBadge, clarificationStatus };
}
