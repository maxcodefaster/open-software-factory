import { expect, test } from "bun:test";
import { createOpenCodeClient } from "./opencode-client";
import { createActivityWake, createOpenCodeEvents } from "./opencode-events";

async function until(accepts: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (accepts()) return;
    await Bun.sleep(10);
  }
  throw new Error("Native observation did not arrive");
}

function controlledEvents() {
  const sources: {
    signal: AbortSignal;
    started: ReturnType<typeof Promise.withResolvers<void>>;
    eventReady: ReturnType<typeof Promise.withResolvers<void>>;
    delivered: ReturnType<typeof Promise.withResolvers<void>>;
    cleanupStarted: ReturnType<typeof Promise.withResolvers<void>>;
    cleanupRelease: ReturnType<typeof Promise.withResolvers<void>>;
    cleaned: ReturnType<typeof Promise.withResolvers<void>>;
  }[] = [];
  const native = createOpenCodeClient(async () => {
    throw new Error("Controlled event source must not use the transport");
  });
  const client: ReturnType<typeof createOpenCodeClient> = {
    ...native,
    event: {
      ...native.event,
      subscribe(options) {
        const signal = options?.signal;
        if (!signal) throw new Error("Event source must have an abort signal");
        const source = {
          signal,
          started: Promise.withResolvers<void>(),
          eventReady: Promise.withResolvers<void>(),
          delivered: Promise.withResolvers<void>(),
          cleanupStarted: Promise.withResolvers<void>(),
          cleanupRelease: Promise.withResolvers<void>(),
          cleaned: Promise.withResolvers<void>(),
        };
        sources.push(source);
        return (async function* () {
          const aborted = Promise.withResolvers<void>();
          const abort = () => aborted.resolve();
          signal.addEventListener("abort", abort, { once: true });
          try {
            source.started.resolve();
            await Promise.race([source.eventReady.promise, aborted.promise]);
            // Model an already queued event arriving after cancellation.
            yield { id: "evt_controlled", type: "server.connected" as const, data: {} };
            source.delivered.resolve();
            await aborted.promise;
          } finally {
            source.cleanupStarted.resolve();
            await source.cleanupRelease.promise;
            signal.removeEventListener("abort", abort);
            source.cleaned.resolve();
          }
        })();
      },
    },
  };
  return { sources, events: createOpenCodeEvents(() => client) };
}

test("shutdown waits for unsubscribed async iterator cleanup, including repeated shutdown", async () => {
  const { events, sources } = controlledEvents();
  const off = events.subscribe("owned", () => {});
  const source = sources[0];
  if (!source) throw new Error("Native stream was not created");
  await source.started.promise;
  off();
  const completed: string[] = [];
  const firstShutdown = events.shutdown().then(() => completed.push("first"));
  const secondShutdown = events.shutdown().then(() => completed.push("second"));
  try {
    await source.cleanupStarted.promise;
    await Promise.resolve();
    expect(source.signal.aborted).toBe(true);
    expect(completed).toEqual([]);
    source.cleanupRelease.resolve();
    await Promise.all([firstShutdown, secondShutdown]);
    await source.cleaned.promise;
    expect(completed).toEqual(["first", "second"]);
  } finally {
    source.cleanupRelease.resolve();
    await events.shutdown();
  }
});

test("an attempt can resubscribe while its old source drains without losing the replacement", async () => {
  const { events, sources } = controlledEvents();
  const oldNotifications: string[] = [];
  const replacementNotifications: string[] = [];
  const sharedNotifications: string[] = [];
  const offOld = events.subscribe("owned", (type) => oldNotifications.push(type));
  const old = sources[0];
  if (!old) throw new Error("Native stream was not created");
  await old.started.promise;
  offOld();
  const offReplacement = events.subscribe("owned", (type) => replacementNotifications.push(type));
  const replacement = sources[1];
  if (!replacement) throw new Error("Replacement stream was not created");
  try {
    await old.cleanupStarted.promise;
    await replacement.started.promise;
    old.cleanupRelease.resolve();
    await old.cleaned.promise;
    await Promise.resolve();
    await Promise.resolve();
    offOld();
    const offShared = events.subscribe("owned", (type) => sharedNotifications.push(type));
    expect(sources).toHaveLength(2);
    expect(replacement.signal.aborted).toBe(false);
    replacement.eventReady.resolve();
    await replacement.delivered.promise;
    expect(oldNotifications).toEqual([]);
    expect(replacementNotifications).toEqual(["server.connected"]);
    expect(sharedNotifications).toEqual(["server.connected"]);
    offReplacement();
    expect(replacement.signal.aborted).toBe(false);
    offShared();
    expect(replacement.signal.aborted).toBe(true);
  } finally {
    offOld();
    offReplacement();
    for (const source of sources) source.cleanupRelease.resolve();
    await events.shutdown();
  }
});

test("shutdown suppresses queued notifications and refuses new subscriptions while draining", async () => {
  const { events, sources } = controlledEvents();
  const notifications: string[] = [];
  events.subscribe("owned", (type) => notifications.push(type));
  const source = sources[0];
  if (!source) throw new Error("Native stream was not created");
  await source.started.promise;
  source.eventReady.resolve();
  const shutdown = events.shutdown();
  try {
    events.subscribe("owned", (type) => notifications.push(type));
    events.subscribe("new", (type) => notifications.push(type));
    await source.cleanupStarted.promise;
    expect(notifications).toEqual([]);
    expect(sources).toHaveLength(1);
    source.cleanupRelease.resolve();
    await shutdown;
    events.subscribe("new", (type) => notifications.push(type));
    expect(sources).toHaveLength(1);
    expect(notifications).toEqual([]);
  } finally {
    source.cleanupRelease.resolve();
    await shutdown;
  }
});

test("shutdown from a listener stops delivery to the remaining subscribers", async () => {
  const { events, sources } = controlledEvents();
  const notifications: string[] = [];
  let shutdown: Promise<void> | undefined;
  events.subscribe("owned", () => {
    notifications.push("first");
    shutdown = events.shutdown();
  });
  events.subscribe("owned", () => notifications.push("second"));
  const source = sources[0];
  if (!source) throw new Error("Native stream was not created");
  try {
    await source.started.promise;
    source.eventReady.resolve();
    await source.cleanupStarted.promise;
    expect(notifications).toEqual(["first"]);
    expect(shutdown).toBeDefined();
    source.cleanupRelease.resolve();
    await shutdown;
  } finally {
    source.cleanupRelease.resolve();
    await events.shutdown();
  }
});

test("one native connection per attempt, read-only reconnect and last-reader cancellation", async () => {
  const paths: string[] = [];
  const canceled: string[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const events = createOpenCodeEvents((attemptID) =>
    createOpenCodeClient(async (request, path) => {
      paths.push(`${attemptID} ${request.method} ${path}`);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: `evt_${streams.length}`, type: "server.connected", data: {} })}\n\n`,
              ),
            );
            request.signal.addEventListener("abort", () => {
              canceled.push(attemptID);
              try {
                controller.close();
              } catch {
                // A completed upstream stream is already closed.
              }
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const first: string[] = [];
  const second: string[] = [];
  const offFirst = events.subscribe("owned", (type) => first.push(type));
  const offSecond = events.subscribe("owned", (type) => second.push(type));
  try {
    await until(() => first.includes("server.connected") && second.includes("server.connected"));
    expect(paths).toEqual(["owned GET /api/event"]);
    const stream = streams[0];
    if (!stream) throw new Error("Native stream was not created");
    stream.close();
    await until(
      () => paths.length === 2 && second.filter((v) => v === "server.connected").length === 2,
    );
    expect(first).toContain("factory.disconnected");
    expect(paths.every((path) => path === "owned GET /api/event")).toBe(true);
    const completedCancellations = canceled.length;
    offFirst();
    expect(canceled).toHaveLength(completedCancellations);
    offSecond();
    await until(() => canceled.length === completedCancellations + 1);
    const count = paths.length;
    await Bun.sleep(300);
    expect(paths).toHaveLength(count);
  } finally {
    offFirst();
    offSecond();
    await events.shutdown();
  }
});

test("events during a snapshot read are retained without building a delta queue", async () => {
  const controller = new AbortController();
  const wake = createActivityWake(controller.signal);
  const revision = wake.revision();
  for (let i = 0; i < 1000; i++) wake.notify();
  await Promise.race([
    wake.wait(revision, 60_000),
    Bun.sleep(100).then(() => {
      throw new Error("Lost notification");
    }),
  ]);
  const pending = wake.wait(wake.revision(), 60_000);
  controller.abort();
  await pending;
  wake.dispose();
});
