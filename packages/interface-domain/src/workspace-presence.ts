type WorkspacePresenceInput = {
  changeState?: string | undefined;
  runtimeState?: string | undefined;
  implementationState?: string | undefined;
  connectionInterrupted?: boolean | undefined;
};

export function workspacePresence(input: WorkspacePresenceInput): string {
  if (input.changeState === "delivered") return "Delivered";
  if (input.changeState === "cancelled") return "Change cancelled";
  if (input.changeState === "cancelling") return "Change cancelling";
  if (input.changeState === "delivering") return "Delivery in progress";

  if (["stop-intended", "stopping"].includes(input.runtimeState ?? "")) {
    return "Workspace stopping";
  }
  if (input.runtimeState === "stopped") return "Workspace stopped";
  if (input.runtimeState === "failed") return "Workspace failed";
  if (input.connectionInterrupted && ["starting", "ready"].includes(input.runtimeState ?? ""))
    return "Workspace reconnecting";
  if (["create-intended", "starting"].includes(input.runtimeState ?? "")) {
    return "Workspace starting";
  }
  if (input.runtimeState === "ready") {
    if (input.implementationState === "working") return "Implementation running";
    return "Workspace ready";
  }
  if (input.changeState === "starting") return "Workspace starting";
  if (input.changeState === "failed") return "Change failed";
  if (input.implementationState && input.implementationState !== "idle")
    return "Workspace status unavailable";
  return "Workspace starts with implementation";
}
