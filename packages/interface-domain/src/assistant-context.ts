/** Surface context selects the next request's existing authority, never grants approval. */
export function assistantContext(input: {
  view: string | undefined;
  ideChangeId: string | undefined;
  ticketChangeId: string | undefined;
}): "investigate" | "plan" | "build" {
  if (input.view === "ide" && input.ticketChangeId && input.ideChangeId === input.ticketChangeId)
    return "build";
  return input.ticketChangeId ? "investigate" : "plan";
}
