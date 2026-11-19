import type { createOpenCodeClient } from "./opencode-client";

// Terminal cleanup may turn a recorded background shell into a synthetic
// error notification which wakes the parent. Never cancel user/unknown work,
// or notifications from shells not durably captured before cleanup.
export async function checkTerminalOpenCodeInbox(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
  shells: readonly { id: string; sessionID: string }[],
  cancelOwnedNotifications = false,
) {
  const inbox = await client.session.inbox.list(
    { sessionID },
    { signal: AbortSignal.timeout(5_000) },
  );
  for (const input of inbox) {
    const metadata = input.type === "synthetic" ? input.payload.metadata : undefined;
    if (
      metadata?.["source"] !== "shell" ||
      typeof metadata["shellID"] !== "string" ||
      metadata["jobID"] !== metadata["shellID"] ||
      !["completed", "error", "cancelled"].includes(String(metadata["state"])) ||
      !shells.some((shell) => shell.id === metadata["shellID"] && shell.sessionID === sessionID)
    )
      throw new Error("A newer or unidentified native input prevents terminal cleanup");
  }
  if (cancelOwnedNotifications)
    for (const input of inbox)
      await client.session.inbox.cancel(
        { sessionID, inboxID: input.id },
        { signal: AbortSignal.timeout(5_000) },
      );
}
