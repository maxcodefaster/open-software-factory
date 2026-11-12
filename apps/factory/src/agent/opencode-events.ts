import type { createOpenCodeClient } from "./opencode-client";

type Client = ReturnType<typeof createOpenCodeClient>;
type Source = {
  controller: AbortController;
  listeners: Set<(type: string) => void>;
  done: Promise<void>;
};

// Notifications invalidate observations. They never grant execution authority or
// prove settlement. Reconnection is read-only; consumers reconcile native state.
export function createOpenCodeEvents(client: (attemptID: string) => Client) {
  let closed = false;
  const active = new Map<string, Source>();
  // Cancellation releases the attempt ID, not ownership of iterator cleanup.
  const draining = new Set<Source>();
  const drain = (attemptID: string, source: Source) => {
    if (active.get(attemptID) !== source) return;
    active.delete(attemptID);
    draining.add(source);
    source.listeners.clear();
    source.controller.abort();
  };
  return {
    subscribe(attemptID: string, notify: (type: string) => void) {
      if (closed) return () => {};
      let source = active.get(attemptID);
      if (!source) {
        const controller = new AbortController();
        const listeners = new Set<(type: string) => void>();
        const emit = (type: string) => {
          for (const listener of listeners) {
            if (closed || controller.signal.aborted) break;
            listener(type);
          }
        };
        const done = (async () => {
          let failures = 0;
          while (!controller.signal.aborted) {
            try {
              for await (const event of client(attemptID).event.subscribe({
                signal: controller.signal,
              })) {
                if (controller.signal.aborted) break;
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
        const owned: Source = {
          controller,
          listeners,
          done: done.finally(() => draining.delete(owned)),
        };
        source = owned;
        active.set(attemptID, source);
      }
      source.listeners.add(notify);
      const owned = source;
      return () => {
        owned.listeners.delete(notify);
        if (owned.listeners.size) return;
        drain(attemptID, owned);
      };
    },
    async shutdown() {
      closed = true;
      for (const [attemptID, source] of active) drain(attemptID, source);
      await Promise.all([...draining].map((source) => source.done));
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
