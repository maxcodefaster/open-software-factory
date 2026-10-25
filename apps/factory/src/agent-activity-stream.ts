import { invoke } from "@solidjs/web/server-functions";
import { z } from "zod";
import { type AgentView, agentViewSchema } from "./api-contracts";
import type { ActivityEvent } from "./agent/activity-stream";
import { getAgentActivity } from "./server-functions/agent";
import { serverCall } from "./server-functions/result";

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), view: agentViewSchema }),
  z.object({ type: z.literal("heartbeat") }),
]);
type Observation = {
  signal: AbortSignal;
  snapshot(view: AgentView): void;
  disconnected(): void;
};

export function observeAgentStream(
  options: Observation,
  open: (signal: AbortSignal) => Promise<ReadableStream<ActivityEvent<AgentView>>>,
) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, options.signal]);
  const close = () => lifetime.abort();
  if (signal.aborted) return close;
  void (async () => {
    while (!signal.aborted) {
      const connection = new AbortController();
      const current = AbortSignal.any([signal, connection.signal]);
      let reader: ReadableStreamDefaultReader<ActivityEvent<AgentView>> | undefined;
      const cancel = () => {
        void reader?.cancel(current.reason).catch(() => {});
      };
      try {
        reader = (await open(current)).getReader();
        current.addEventListener("abort", cancel, { once: true });
        while (!current.aborted) {
          const chunk = await reader.read();
          if (current.aborted) break;
          if (chunk.done) throw new Error("Build observation disconnected");
          const event = eventSchema.parse(chunk.value);
          if (event.type === "snapshot") options.snapshot(event.view);
        }
      } catch {
        if (!signal.aborted) options.disconnected();
      } finally {
        current.removeEventListener("abort", cancel);
        connection.abort();
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 3_000);
          signal.addEventListener("abort", finish, { once: true });
        });
    }
  })();
  return close;
}

export function observeAgentActivity(options: Observation & { changeID: string }) {
  // Only the named read reconnects. No execution command enters this loop.
  return observeAgentStream(options, (signal) =>
    serverCall(invoke(getAgentActivity, { signal }, options.changeID)),
  );
}
