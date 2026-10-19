import { expect, test } from "bun:test";
import { observeAgentActivity } from "./agent-activity-stream";

test("Build observation validates replacements and fences canceled connections after Stop", () => {
  const NativeEventSource = globalThis.EventSource;
  const sources: FakeEventSource[] = [];
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const snapshot = {
    state: "working",
    messages: [],
    messagesAvailable: true,
    sessionAvailable: true,
    runtimeConnected: true,
    stopPending: false,
    stopId: null,
  };
  const views: unknown[] = [];
  let disconnected = 0;
  const controller = new AbortController();
  try {
    observeAgentActivity({
      changeID: "owned",
      signal: controller.signal,
      snapshot: (view) => views.push(view),
      disconnected: () => disconnected++,
    });
    const source = sources[0];
    if (!source) throw new Error("Activity source was not created");
    expect(source.url).toBe("/api/changes/owned/agent/activity");
    source.onmessage?.({ data: JSON.stringify({ type: "snapshot", view: snapshot }) });
    source.onerror?.();
    expect(views).toHaveLength(1);
    expect(disconnected).toBe(1);
    expect(source.closed).toBe(false);
    controller.abort();
    source.onmessage?.({ data: JSON.stringify({ type: "snapshot", view: snapshot }) });
    source.onerror?.();
    expect(views).toHaveLength(1);
    expect(disconnected).toBe(1);
    expect(source.closed).toBe(true);
  } finally {
    controller.abort();
    globalThis.EventSource = NativeEventSource;
  }
});
