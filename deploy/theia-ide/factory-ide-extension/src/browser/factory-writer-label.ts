function name(value: unknown) {
  if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string")
    return undefined;
  return value.name.trim().slice(0, 160) || undefined;
}

/** Identity is display data. It never grants authority or replaces canWrite. */
export function factoryWriterLabel(value: {
  state: string;
  canWrite: boolean;
  stopPending?: boolean;
  actor?: unknown;
  requester?: unknown;
  presence?: unknown;
}) {
  const actor = value.actor && typeof value.actor === "object" ? value.actor : undefined;
  const person = actor && "user" in actor ? name(actor.user) : undefined;
  if (value.stopPending)
    return "Agent Stop unconfirmed. Check Stop in this Ticket. Files remain available to read.";
  if (value.canWrite) return "You are editing this implementation.";
  if (value.state === "handoff") {
    const requester = name(value.requester);
    return requester
      ? `Transferring editing to ${requester}. Existing files are preserved.`
      : "Editing takeover is pending. Existing files are preserved.";
  }
  if (value.state === "human")
    return `${person ?? "Another developer"} ${
      value.presence &&
      typeof value.presence === "object" &&
      "idle" in value.presence &&
      value.presence.idle === true
        ? "holds editing; no recent edits."
        : "is editing."
    } Files remain available to read.`;
  if (value.state === "agent" || value.state === "agent-preparing") {
    const work = actor && "workState" in actor ? actor.workState : undefined;
    const state =
      work === "uncertain"
        ? "Agent outcome unconfirmed"
        : work === "failed"
          ? "Agent work failed"
          : work === "completed" || work === "stopped"
            ? "Agent work settled"
            : value.state === "agent"
              ? "Agent working"
              : "Agent preparing";
    const attribution =
      actor && "delegated" in actor && actor.delegated === true ? "delegated by" : "requested by";
    return `${state}${person ? ` · ${attribution} ${person}` : ""}. Observation mode.`;
  }
  return value.state === "unassigned"
    ? "Editing is available."
    : "Editing status is unavailable. Files remain available to read.";
}
