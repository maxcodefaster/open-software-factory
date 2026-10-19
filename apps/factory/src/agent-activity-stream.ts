import { z } from "zod";
import { type AgentView, agentViewSchema } from "./api-contracts";

const snapshotSchema = z.object({ type: z.literal("snapshot"), view: agentViewSchema });

export function observeAgentActivity(options: {
  changeID: string;
  signal: AbortSignal;
  snapshot(view: AgentView): void;
  disconnected(): void;
}) {
  if (options.signal.aborted) return () => {};
  // EventSource retries only this authenticated read. Build commands never use
  // this transport, and a fresh connection starts with a replacement snapshot.
  const source = new EventSource(`/api/changes/${options.changeID}/agent/activity`);
  let closed = false;
  const close = () => {
    closed = true;
    source.close();
    options.signal.removeEventListener("abort", close);
  };
  options.signal.addEventListener("abort", close, { once: true });
  source.onmessage = (event) => {
    if (closed || options.signal.aborted) return;
    try {
      options.snapshot(snapshotSchema.parse(JSON.parse(event.data)).view);
    } catch {
      close();
      options.disconnected();
    }
  };
  source.onerror = () => {
    if (!closed && !options.signal.aborted) options.disconnected();
  };
  return close;
}
