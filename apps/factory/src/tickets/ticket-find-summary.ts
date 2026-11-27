const tickets = (count: number) => `${count} ${count === 1 ? "Ticket" : "Tickets"}`;

/** The status line of Ticket quick find. A partial count never reads as the final answer. */
export function ticketFindSummary(state: {
  failed?: boolean | undefined;
  loading?: boolean | undefined;
  count: number;
  query: string;
}) {
  if (state.failed) return "Ticket search could not load. Retry shared sync, then search again.";
  if (state.loading)
    return state.count
      ? `Still searching. ${tickets(state.count)} found so far.`
      : "Finding Tickets…";
  if (state.count > 50) return "50 Tickets shown. Refine your search for more.";
  if (state.count) return `${tickets(state.count)} in this Project`;
  return state.query.trim()
    ? "No matching Tickets. Try another title or reference."
    : "No Tickets in this Project yet.";
}
