import { expect, test } from "bun:test";
import { addressFunctionID, createSharedReadTransport } from "./shared-reads";

function fakeServer() {
  const requests: {
    address: string;
    body: unknown;
    release(): void;
    signal?: AbortSignal | undefined;
  }[] = [];
  const send = (address: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const entry = {
        address,
        body: init.body,
        signal: init.signal ?? undefined,
        release: () => resolve(new Response(`answer-${requests.length}`)),
      };
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      requests.push(entry);
    });
  return { requests, send };
}

const call = (
  transport: { fetch: (address: string, init: RequestInit) => Promise<Response> | Response },
  id: string,
  body: string,
  signal?: AbortSignal,
) =>
  Promise.resolve(
    transport.fetch(`/_server/data/${id}`, {
      method: "POST",
      body,
      ...(signal ? { signal } : {}),
    }),
  );

test("function identity comes from the last address segment", () => {
  expect(addressFunctionID("/_server/data/abc%2Fdef?args=1")).toBe("abc/def");
  expect(addressFunctionID("/_server/xyz")).toBe("xyz");
});

test("identical in-flight reads share one request and each reader gets its own body", async () => {
  const server = fakeServer();
  const transport = createSharedReadTransport({
    isRead: (id) => id.startsWith("read"),
    send: server.send,
  });
  const first = call(transport, "read-a", '["t1"]');
  const second = call(transport, "read-a", '["t1"]');
  const other = call(transport, "read-a", '["t2"]');
  const different = call(transport, "read-b", '["t1"]');
  expect(server.requests).toHaveLength(3);
  server.requests[0]?.release();
  server.requests[1]?.release();
  server.requests[2]?.release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).not.toBe(b);
  expect(await a.text()).toBe(await b.text());
  await Promise.all([other, different]);
  // Nothing is retained after the response: the next identical read asks again.
  const later = call(transport, "read-a", '["t1"]');
  expect(server.requests).toHaveLength(4);
  server.requests[3]?.release();
  await later;
  expect(transport.pending()).toBe(0);
});

test("writes pass through and invalidate reads in flight before and after", async () => {
  const server = fakeServer();
  const transport = createSharedReadTransport({
    isRead: (id) => id.startsWith("read"),
    send: server.send,
  });
  const before = call(transport, "read-a", "[]");
  const write = call(transport, "save-a", "[]");
  const during = call(transport, "read-a", "[]");
  const again = call(transport, "save-a", "[]");
  expect(server.requests.map((request) => request.address.split("/").pop())).toEqual([
    "read-a",
    "save-a",
    "read-a",
    "save-a",
  ]);
  for (const request of server.requests) request.release();
  await Promise.all([before, write, during, again]);
  const afterWrite = call(transport, "read-a", "[]");
  expect(server.requests).toHaveLength(5);
  server.requests[4]?.release();
  await afterWrite;
});

test("a version change stops later readers joining an older request", async () => {
  const server = fakeServer();
  const transport = createSharedReadTransport({ isRead: () => true, send: server.send });
  const older = call(transport, "read-a", "[]");
  transport.invalidate();
  const newer = call(transport, "read-a", "[]");
  const joined = call(transport, "read-a", "[]");
  expect(server.requests).toHaveLength(2);
  for (const request of server.requests) request.release();
  await Promise.all([older, newer, joined]);
});

test("one reader aborting leaves the shared request to the others, the last abort cancels it", async () => {
  const server = fakeServer();
  const transport = createSharedReadTransport({ isRead: () => true, send: server.send });
  const first = new AbortController();
  const second = new AbortController();
  const aborted = call(transport, "read-a", "[]", first.signal);
  const kept = call(transport, "read-a", "[]", second.signal);
  expect(server.requests).toHaveLength(1);
  first.abort();
  await expect(aborted).rejects.toThrow();
  expect(server.requests[0]?.signal?.aborted).toBe(false);
  server.requests[0]?.release();
  expect(await (await kept).text()).toBe("answer-1");

  const sole = new AbortController();
  const lonely = call(transport, "read-a", "[]", sole.signal);
  expect(server.requests).toHaveLength(2);
  sole.abort();
  await expect(lonely).rejects.toThrow();
  expect(server.requests[1]?.signal?.aborted).toBe(true);
});

test("a failed request rejects every reader and is not retained", async () => {
  const sent: string[] = [];
  const transport = createSharedReadTransport({
    isRead: () => true,
    send: async (address) => {
      sent.push(address);
      throw new Error("offline");
    },
  });
  const readers = await Promise.allSettled([
    call(transport, "read-a", "[]"),
    call(transport, "read-a", "[]"),
  ]);
  expect(readers.map((reader) => reader.status)).toEqual(["rejected", "rejected"]);
  expect(sent).toHaveLength(1);
  await expect(call(transport, "read-a", "[]")).rejects.toThrow("offline");
  expect(sent).toHaveLength(2);
});
