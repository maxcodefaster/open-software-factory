import type { WriterView } from "./agent/contracts";

export function writerStatusText(view: WriterView) {
  if (view.stopPending) return "Agent Stop unconfirmed. Check Stop in this Ticket.";
  if (view.state === "human")
    return view.canWrite
      ? "You are editing"
      : `${view.actor?.user?.name ?? "Another developer"} ${view.presence?.idle ? "holds editing · no recent edits" : "is editing"}`;
  if (view.state === "handoff")
    if (view.handoffKind === "release") return "Releasing editing · stopping previous commands";
    else
      return view.requester
        ? `Transferring editing to ${view.requester.name}`
        : "Editing handoff in progress";
  if (view.state === "agent" || view.state === "agent-preparing") {
    const work = view.actor?.workState;
    const label =
      work === "uncertain"
        ? "Agent outcome unconfirmed"
        : work === "failed"
          ? "Agent work failed"
          : ["completed", "stopped"].includes(work ?? "")
            ? "Agent work settled"
            : view.state === "agent-preparing"
              ? "Agent preparing"
              : "Agent working";
    return `${label}${view.actor?.user ? ` · ${view.actor.delegated ? "delegated" : "requested"} by ${view.actor.user.name}` : ""}`;
  }
  return "Editing is available";
}
