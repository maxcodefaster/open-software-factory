import { expect, test } from "bun:test";
import { RuntimeProcessEvents } from "./process-events";
import type { RuntimeProcessSnapshot } from "./hub";

function eventReader(response: Response) {
  if (!response.body) throw new Error("Process event stream has no body");
  return response.body.getReader();
}

test("process events coalesce changes, reconcile slow readers and never poll unchanged snapshots", async () => {
  let reads = 0;
  let output = "first";
  const events = new RuntimeProcessEvents(() => {
    reads++;
    return [{ name: "app", state: "running", output }];
  });
  const cancel = new AbortController();
  const reader = eventReader(events.subscribe("attempt-a", "viewer-a", cancel.signal));
  const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
  expect(decode((await reader.read()).value)).toContain('"output":"first"');
  await Bun.sleep(65);
  expect(reads).toBe(1);
  for (let index = 0; index < 100; index++) {
    output = String(index);
    events.changed("attempt-a");
  }
  expect(decode((await reader.read()).value)).toContain('"output":"99"');
  expect(reads).toBe(2);
  events.changed("attempt-b");
  await Bun.sleep(65);
  expect(reads).toBe(2);
  output = "queued";
  events.changed("attempt-a");
  await Bun.sleep(65);
  for (let index = 0; index < 100; index++) {
    output = `slow-${index}`;
    events.changed("attempt-a");
  }
  await Bun.sleep(65);
  expect(reads).toBe(3);
  expect(decode((await reader.read()).value)).toContain('"output":"queued"');
  expect(decode((await reader.read()).value)).toContain('"output":"slow-99"');
  expect(reads).toBe(4);
  cancel.abort();
  expect((await reader.read()).done).toBe(true);
});

test("process streams are attempt/access-scoped and bounded, with cancellation freeing capacity", async () => {
  const processes: RuntimeProcessSnapshot[] = [
    { name: "app", state: "running", output: "bounded" },
  ];
  const events = new RuntimeProcessEvents(() => processes);
  const streams = Array.from({ length: 8 }, (_, index) =>
    events.subscribe("attempt-a", `viewer-${index}`, new AbortController().signal),
  );
  expect(() => events.subscribe("attempt-a", "overflow", new AbortController().signal)).toThrow(
    "limit reached",
  );
  if (!streams[0]?.body) throw new Error("Missing bounded subscription");
  await streams[0].body.cancel();
  const replacement = eventReader(
    events.subscribe("attempt-a", "replacement", new AbortController().signal),
  );
  const other = eventReader(events.subscribe("attempt-b", "other", new AbortController().signal));
  await replacement.read();
  await other.read();
  events.revokeAccess("replacement");
  expect((await replacement.read()).done).toBe(true);
  events.closeAttempt("attempt-a");
  events.changed("attempt-b");
  expect(new TextDecoder().decode((await other.read()).value)).toContain("bounded");
  events.closeAttempt("attempt-b");
  expect((await other.read()).done).toBe(true);
});
