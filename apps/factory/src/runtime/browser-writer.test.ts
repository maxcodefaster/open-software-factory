import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createTerminalWriterBoundary } from "./browser-writer";
import { RuntimeHub, type RuntimeSocketData } from "./hub";

test("terminal admission and every queued input recheck writer authority without reordering or post-close dispatch", async () => {
  const hub = new RuntimeHub(async () => {});
  const sent: string[] = [];
  hub.open = () => {
    sent.push("open");
  };
  hub.message = (_socket, raw) => {
    sent.push(String(raw));
  };
  hub.close = () => {};
  const first = Promise.withResolvers<void>();
  let allowed = true;
  let calls = 0;
  const closed: number[] = [];
  const socket = {
    data: { kind: "browser", attemptID: crypto.randomUUID(), channel: "terminal", path: "/owned" },
    close(code: number) {
      closed.push(code);
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  const boundary = createTerminalWriterBoundary(hub, async (_data, send) => {
    calls++;
    if (calls === 1) await first.promise;
    if (!allowed) throw new Error("Revoked writer");
    send();
  });
  boundary.open(socket);
  boundary.message(socket, "one");
  boundary.message(socket, "two");
  expect(sent).toEqual([]);
  first.resolve();
  await Bun.sleep(5);
  expect(sent).toEqual(["open", "one", "two"]);
  allowed = false;
  boundary.message(socket, "must not send");
  await Bun.sleep(5);
  expect(sent).toEqual(["open", "one", "two"]);
  expect(closed).toEqual([1008]);
  boundary.close(socket);
  boundary.message(socket, "closed input");
  expect(calls).toBe(4);
});
