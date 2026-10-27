import { expect, test } from "bun:test";
import { observeAgentStream } from "./agent/observe-stream";
import type { AgentView } from "./api-contracts";
import type { ActivityEvent } from "./agent/activity-stream";

test("native Build observations validate replacements and fence a canceled connection after Stop", async () => {
  const snapshot: AgentView = {
    state: "working",
    messages: [],
    messagesAvailable: true,
    sessionAvailable: true,
    runtimeConnected: true,
    stopPending: false,
    stopId: null,
  };
  const views: AgentView[] = [],
    abort = new AbortController();
  const first = Promise.withResolvers<void>(),
    failed = Promise.withResolvers<void>();
  let requests = 0,
    disconnected = 0,
    wire: AbortSignal | undefined;
  let source: ReadableStreamDefaultController<ActivityEvent<AgentView>> | undefined;
  const close = observeAgentStream(
    {
      signal: abort.signal,
      snapshot(view) {
        views.push(view);
        first.resolve();
      },
      disconnected() {
        disconnected++;
        failed.resolve();
      },
    },
    async (signal) => {
      requests++;
      wire = signal;
      return new ReadableStream<ActivityEvent<AgentView>>({
        start(controller) {
          source = controller;
          controller.enqueue({ type: "snapshot", view: snapshot });
        },
      });
    },
  );
  try {
    await first.promise;
    expect(views).toHaveLength(1);
    source?.error(new Error("Read connection ended"));
    await failed.promise;
    expect(disconnected).toBe(1);
    abort.abort();
    await Bun.sleep(10);
    expect(wire?.aborted).toBe(true);
    expect(views).toHaveLength(1);
    expect(requests).toBe(1);
  } finally {
    close();
  }
});
