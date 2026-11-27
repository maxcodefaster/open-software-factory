import type { TurnObservation } from "#conversation-domain/turn-observation";

export function projectFailureNotice(turn: Pick<TurnObservation, "state" | "summary">) {
  if (turn.state === "uncertain")
    return "Factory could not confirm whether this response finished. Your input is saved; no request was resent. Sending a new message starts a separate AI request.";
  if (turn.state === "stopped")
    return "This response was stopped. Your input is saved; no request was resent.";
  return `${turn.summary ?? "The assistant could not finish this response. Your input is saved."} No request was resent. Send a new message when you are ready to continue.`;
}
