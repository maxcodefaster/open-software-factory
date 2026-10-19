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
