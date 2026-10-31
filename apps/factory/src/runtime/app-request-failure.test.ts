import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { fixtureValue } from "../../../../test/fixtures/value";
import { appRequestFailureResponse } from "./app-request-failure";
import { RuntimeHub, type RuntimeSocketData } from "./hub";

const id = crypto.randomUUID();
const timeout = new Error("Runtime request timed out");

test.each(["app", "preview/app", "preview/app-admin"])(
  "a timed-out %s write reports an unknown outcome, not a definite failed save",
  async (channel) => {
    const response = appRequestFailureResponse(
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
  expect((await appRequestFailureResponse(request, timeout)?.json())?.error).toContain(
    "App response timed out",
  );
  expect(
    appRequestFailureResponse(request, new Error("private runtime diagnostic")),
  ).toBeUndefined();
  expect(
    appRequestFailureResponse(new Request(`http://app.test/runtime/${id}/ide/api/file`), timeout),
  ).toBeUndefined();
  expect(
    appRequestFailureResponse(
      new Request(`http://app.test/api/projects/${id}/conversation`),
      timeout,
    ),
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
      .catch((cause) => appRequestFailureResponse(request, cause));
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

test.each(["app", "preview/app", "preview/app-admin"])(
  "an unreachable %s reports service unavailability without claiming an unconfirmed write failed",
  async (channel) => {
    const unavailable = new Error("channel request failed");
    const url = `http://app.test/runtime/${id}/${channel}/api/support-requests`;
    const read = appRequestFailureResponse(new Request(url), unavailable);
    expect(read?.status).toBe(503);
    expect(read?.headers.get("cache-control")).toBe("no-store");
    expect((await read?.json())?.error).toContain("App could not be reached");
    const write = appRequestFailureResponse(
      new Request(url, { method: "POST", body: "{}" }),
      unavailable,
    );
    expect(write?.status).toBe(503);
    expect((await write?.json())?.error).toContain("did not confirm whether this change finished");
    expect(
      appRequestFailureResponse(
        new Request(`http://app.test/runtime/${id}/ide/api/file`),
        unavailable,
      ),
    ).toBeUndefined();
    expect(
      appRequestFailureResponse(
        new Request(`http://app.test/api/projects/${id}/conversation`),
        unavailable,
      ),
    ).toBeUndefined();
  },
);

test("an unreachable App mutation is dispatched once and keeps its outcome unconfirmed", async () => {
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
      .catch((cause) => appRequestFailureResponse(request, cause));
    await Bun.sleep(0);
    const frame = frames.find((value) => value.type === "http-request");
    hub.message(
      socket,
      JSON.stringify({
        type: "stream-error",
        streamId: fixtureValue(frame, "frame").streamId,
        error: "channel request failed",
      }),
    );
    const result = await response;
    expect(result?.status).toBe(503);
    expect((await result?.json())?.error).toContain("whether this change finished");
    expect(frames.filter((value) => value.type === "http-request")).toHaveLength(1);
    expect(frames.at(-1)?.type).toBe("stream-close");
  } finally {
    hub.revoke("attempt");
  }
});
