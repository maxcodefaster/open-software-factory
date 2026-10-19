import type { createOpenCodeClient } from "./opencode-client";

type Client = ReturnType<typeof createOpenCodeClient>;

// Notifications invalidate observations. They never grant execution authority or
// prove settlement. Reconnection is read-only; consumers reconcile native state.
export function createOpenCodeEvents(client: (attemptID: string) => Client) {
  let closed = false;
  const sources = new Map<
    string,
    { controller: AbortController; listeners: Set<(type: string) => void>; done: Promise<void> }
  >();
  return {
    subscribe(attemptID: string, notify: (type: string) => void) {
      if (closed) return () => {};
      let source = sources.get(attemptID);
      if (!source) {
        const controller = new AbortController();
        const listeners = new Set<(type: string) => void>();
        const emit = (type: string) => {
          for (const listener of listeners) listener(type);
        };
        const done = (async () => {
          let failures = 0;
          while (!controller.signal.aborted) {
            try {
              for await (const event of client(attemptID).event.subscribe({
                signal: controller.signal,
              })) {
                failures = 0;
                emit(event.type);
              }
            } catch {
              // The native stream is live-only and does not reconnect itself.
            }
            if (controller.signal.aborted) break;
            emit("factory.disconnected");
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", finish);
                resolve();
              };
              const timer = setTimeout(finish, Math.min(5_000, 250 * 2 ** failures++));
              controller.signal.addEventListener("abort", finish, { once: true });
            });
          }
        })();
        source = { controller, listeners, done };
        sources.set(attemptID, source);
      }
      source.listeners.add(notify);
      const owned = source;
      return () => {
        owned.listeners.delete(notify);
        if (owned.listeners.size || sources.get(attemptID) !== owned) return;
        sources.delete(attemptID);
        owned.controller.abort();
      };
    },
    async shutdown() {
      closed = true;
      const active = [...sources.values()];
      sources.clear();
      for (const source of active) source.controller.abort();
      await Promise.all(active.map((source) => source.done));
    },
  };
}

// A revision prevents events arriving during a snapshot read from being lost.
// There is at most one pending wait, not a queue of native token deltas.
export function createActivityWake(signal: AbortSignal) {
  let revision = 0;
  let release: (() => void) | undefined;
  const notify = () => {
    revision++;
    release?.();
  };
  signal.addEventListener("abort", notify, { once: true });
  return {
    notify,
    revision: () => revision,
    wait(after: number, timeout: number) {
      if (signal.aborted || after !== revision) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          release = undefined;
          resolve();
        };
        const timer = setTimeout(finish, timeout);
        release = finish;
      });
    },
    dispose() {
      signal.removeEventListener("abort", notify);
      release?.();
    },
  };
}
