import { CommandError } from "../command-error";
import { createActivityWake } from "./opencode-events";

// The browser observes an admitted Build. Detaching never interrupts or repeats
// it. Full replacement snapshots also reconcile gaps in OpenCode's live-only SSE.
export type ActivityEvent<T> = { type: "snapshot"; view: T } | { type: "heartbeat" };

export function agentActivityStream<T>(options: {
  signal: AbortSignal;
  authorize(): Promise<void>;
  read(): Promise<T>;
  subscribe(notify: () => void): Promise<() => void>;
  reconcileMS?: number;
  coalesceMS?: number;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const wake = createActivityWake(signal);
  let pending: ActivityEvent<T> | undefined;
  let previous = "";
  let detach: (() => void) | undefined;
  let sink: ReadableStreamDefaultController<ActivityEvent<T>>;
  let closed = false;
  const finish = (closeSink: boolean, cause?: unknown) => {
    if (closed) return;
    closed = true;
    pending = undefined;
    signal.removeEventListener("abort", abort);
    controller.abort();
    if (closeSink) {
      if (cause) sink.error(cause);
      else sink.close();
    }
  };
  const abort = () => finish(true);
  function flush() {
    if (!pending || signal.aborted || (sink.desiredSize ?? 0) <= 0) return;
    const frame = pending;
    pending = undefined;
    sink.enqueue(frame);
  }
  return new ReadableStream<ActivityEvent<T>>(
    {
      start(value) {
        sink = value;
        if (signal.aborted) {
          finish(true);
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        void (async () => {
          try {
            detach = await options.subscribe(wake.notify);
            while (!signal.aborted) {
              const revision = wake.revision();
              await options.authorize();
              const snapshot = await options.read();
              // Authority can change during a slow native read.
              await options.authorize();
              if (signal.aborted) break;
              const encoded = JSON.stringify({ type: "snapshot", view: snapshot });
              if (encoded !== previous) {
                previous = encoded;
                pending = { type: "snapshot", view: snapshot };
              } else if (!pending) {
                pending = { type: "heartbeat" };
              }
              flush();
              await wake.wait(revision, options.reconcileMS ?? 15_000);
              if (!signal.aborted)
                await new Promise<void>((resolve) => {
                  const finish = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", finish);
                    resolve();
                  };
                  const timer = setTimeout(finish, options.coalesceMS ?? 100);
                  signal.addEventListener("abort", finish, { once: true });
                });
            }
          } catch (cause) {
            if (!signal.aborted) {
              // Do not retain a queued source snapshot after access revocation.
              finish(
                true,
                cause instanceof CommandError ? cause : new Error("Build activity disconnected"),
              );
            }
          } finally {
            detach?.();
            wake.dispose();
            if (!closed) finish(true);
          }
        })();
      },
      pull() {
        flush();
      },
      cancel() {
        finish(false);
      },
    },
    { highWaterMark: 1 },
  );
}
