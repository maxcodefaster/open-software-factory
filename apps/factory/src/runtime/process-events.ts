import type { RuntimeProcessSnapshot } from "./hub";

interface Subscription {
  readonly attemptID: string;
  readonly accessToken: string;
  changed(): void;
  close(): void;
}

export class RuntimeProcessEvents {
  readonly #subscriptions = new Set<Subscription>();
  constructor(private readonly read: (attemptID: string) => RuntimeProcessSnapshot[]) {}

  subscribe(attemptID: string, accessToken: string, signal: AbortSignal) {
    if (
      this.#subscriptions.size >= 128 ||
      [...this.#subscriptions].filter((entry) => entry.attemptID === attemptID).length >= 8
    )
      throw new Error("Process event subscription limit reached");
    const encoder = new TextEncoder();
    let subscription: Subscription | undefined;
    let dirty = true;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const send = () => {
      timer = undefined;
      if (ended || !dirty || (controller.desiredSize ?? 0) <= 0) return;
      dirty = false;
      controller.enqueue(
        encoder.encode(
          `event: snapshot\ndata: ${JSON.stringify({ processes: this.read(attemptID).slice(0, 16) })}\n\n`,
        ),
      );
    };
    const close = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearInterval(keepalive);
      signal.removeEventListener("abort", close);
      if (subscription) this.#subscriptions.delete(subscription);
      controller.close();
    };
    const body = new ReadableStream<Uint8Array>({
      start: (target) => {
        controller = target;
        subscription = {
          attemptID,
          accessToken,
          close,
          changed: () => {
            dirty = true;
            if (!timer && !ended) timer = setTimeout(send, 50);
          },
        };
        this.#subscriptions.add(subscription);
        signal.addEventListener("abort", close, { once: true });
        if (signal.aborted) {
          close();
          return;
        }
        send();
        keepalive = setInterval(() => {
          if (!ended && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 30_000);
        keepalive.unref();
      },
      pull: () => send(),
      cancel: () => {
        // Cancellation already closes the stream; only remove timers and ownership.
        ended = true;
        clearTimeout(timer);
        clearInterval(keepalive);
        signal.removeEventListener("abort", close);
        if (subscription) this.#subscriptions.delete(subscription);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
  changed(attemptID: string) {
    for (const subscription of this.#subscriptions)
      if (subscription.attemptID === attemptID) subscription.changed();
  }
  hasView(attemptID: string) {
    return [...this.#subscriptions].some((subscription) => subscription.attemptID === attemptID);
  }
  closeAttempt(attemptID: string) {
    for (const subscription of this.#subscriptions)
      if (subscription.attemptID === attemptID) subscription.close();
  }
  revokeAccess(accessToken: string) {
    for (const subscription of this.#subscriptions)
      if (subscription.accessToken === accessToken) subscription.close();
  }
}
