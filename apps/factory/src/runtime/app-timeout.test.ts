import { expect, test } from "bun:test";
import { appTimeoutResponse } from "./app-timeout";
import { RuntimeHub, type RuntimeSocketData } from "./hub";
import type { ServerWebSocket } from "bun";
import { fixtureValue } from "../../../../test/fixtures/value";

const id = crypto.randomUUID();
const timeout = new Error("Runtime request timed out");

test.each(["app", "preview/app", "preview/app-admin"])(
  "a timed-out %s write reports an unknown outcome, not a definite failed save",
  async (channel) => {
    const response = appTimeoutResponse(
      new Request(`http://app.test/runtime/${id}/${channel}/api/support-requests`, {
        method: "POST",
        body: "{}",
      }),
      timeout,
    );
    expect(response?.status).toBe(504);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const body = await response?.json();
    expect(body.error).toContain("did not confirm whether this change finished");
    expect(body.error).toContain("before submitting it again");
  },
);

test("read timeouts do not imply an App change, and unrelated errors keep their own handling", async () => {
  const request = new Request(`http://app.test/runtime/${id}/preview/app/api/support-requests`);
  expect((await appTimeoutResponse(request, timeout)?.json())?.error).toContain(
    "App response timed out",
  );
  expect(appTimeoutResponse(request, new Error("private runtime diagnostic"))).toBeUndefined();
  expect(
    appTimeoutResponse(new Request(`http://app.test/runtime/${id}/ide/api/file`), timeout),
  ).toBeUndefined();
  expect(
    appTimeoutResponse(new Request(`http://app.test/api/projects/${id}/conversation`), timeout),
  ).toBeUndefined();
});

test("an actual unconfirmed runtime response reaches the App timeout translation", async () => {
  const hub = new RuntimeHub(async () => {});
  const frames: Array<{ type: string; streamId?: string }> = [];
  const socket = {
    data: { kind: "connector", role: "child", attemptID: "attempt", generation: 1 },
    close() {},
    send(value: string) {
      frames.push(JSON.parse(value));
      return 1;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  const request = new Request(`http://app.test/runtime/${id}/preview/app/api/support-requests`, {
    method: "POST",
    body: "{}",
  });
  try {
    hub.open(socket);
    const response = hub
      .request("attempt", "app", request, "/api/support-requests")
      .catch((cause) => appTimeoutResponse(request, cause));
    await Bun.sleep(0);
    const frame = frames.find((value) => value.type === "http-request");
    expect(frame?.streamId).toBeDefined();
    hub.message(
      socket,
      JSON.stringify({
        type: "stream-error",
        streamId: fixtureValue(frame, "frame").streamId,
        error: "Runtime request timed out",
      }),
    );
    const result = await response;
    expect(result?.status).toBe(504);
    expect((await result?.json())?.error).toContain("whether this change finished");
  } finally {
    hub.revoke("attempt");
  }
});
