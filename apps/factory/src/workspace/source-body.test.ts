import { expect, test } from "bun:test";
import { boundedSourceBody } from "./source-body";

test("chunked Source requests are bounded before dispatch without trusting Content-Length", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array((4 << 20) + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  await expect(
    boundedSourceBody(
      new Request("http://factory.invalid/write", {
        method: "POST",
        body,
        headers: { "Content-Length": "1" },
      }),
    ),
  ).rejects.toThrow("4 MiB");
  expect(canceled).toBe(true);
  const content = '{"path":"app.ts"}';
  expect(
    await boundedSourceBody(
      new Request("http://factory.invalid/read", {
        method: "POST",
        body: content,
      }),
    ),
  ).toEqual(new TextEncoder().encode(content));
});

test("Source upload cancellation releases a stalled body before dispatch", async () => {
  let canceled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const content = boundedSourceBody(
    new Request("http://factory.invalid/write", { method: "POST", body }),
    controller.signal,
  );
  controller.abort(new Error("Source upload canceled"));
  await expect(content).rejects.toThrow("Source upload canceled");
  expect(canceled).toBe(true);
});
