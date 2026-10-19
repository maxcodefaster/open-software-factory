import { CommandError } from "../command-error";
import { createActivityWake } from "./opencode-events";

// The browser observes an admitted Build. Detaching never interrupts or repeats
// it. Full replacement snapshots also reconcile gaps in OpenCode's live-only SSE.
export function agentActivityResponse<T>(options: {
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
  const encoder = new TextEncoder();
  let pending = "";
  let previous = "";
  let detach: (() => void) | undefined;
  let sink: ReadableStreamDefaultController<Uint8Array>;
  function flush() {
    if (!pending || signal.aborted || (sink.desiredSize ?? 0) <= 0) return;
    const frame = pending;
    pending = "";
    sink.enqueue(encoder.encode(frame));
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        sink = value;
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
                pending = `data: ${encoded}\n\n`;
              } else if (!pending) {
                pending = ": keepalive\n\n";
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
              pending = "";
              sink.error(
                cause instanceof CommandError ? cause : new Error("Build activity disconnected"),
              );
              controller.abort();
            }
          } finally {
            detach?.();
            wake.dispose();
            if (!signal.aborted) sink.close();
          }
        })();
      },
      pull() {
        flush();
      },
      cancel() {
        pending = "";
        controller.abort();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
