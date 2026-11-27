import { expect, test } from "bun:test";
import type { createDatabase } from "#db/client";
import type { RuntimeHub } from "../runtime/hub";
import { createCodingRuntimeShutdown } from "./runtime-shutdown";

const database = {} as ReturnType<typeof createDatabase>;
const attemptID = "01994a7d-0000-7000-8000-000000000001";
const nextAttemptID = "01994a7d-0000-7000-8000-000000000002";

function fixture(connected = true) {
  const effects: string[] = [];
  const hub = {
    connected(id: string) {
      effects.push(`connected:${id}`);
      return connected;
    },
    async request(id: string, role: string, request: Request, path: string) {
      effects.push(`request:${id}:${role}:${path}`);
      expect(request.method).toBe("GET");
      return Response.json({ data: [] });
    },
  } as unknown as RuntimeHub;
  return { effects, hub };
}

test("constructing Coding shutdown does not create a request or replay usage", () => {
  const f = fixture();
  createCodingRuntimeShutdown(database, f.hub, {
    async drainAttempt() {
      throw Error("Construction must not drain");
    },
    async markUnavailable() {
      throw Error("Construction must not mark coverage");
    },
  });
  expect(f.effects).toEqual([]);
});

test("Coding shutdown uses the native SDK through only the exact Attempt's Agent channel", async () => {
  const f = fixture();
  const shutdown = createCodingRuntimeShutdown(database, f.hub, {
    async drainAttempt(id, client) {
      f.effects.push(`drain:${id}`);
      expect(await client.session.inbox.list({ sessionID: "ses_owned_shutdown" })).toEqual([]);
    },
    async markUnavailable() {
      throw Error("Successful drain must retain its observed coverage");
    },
  });
  await shutdown(attemptID);
  await shutdown(nextAttemptID);
  expect(f.effects).toEqual(
    [attemptID, nextAttemptID].flatMap((id) => [
      `connected:${id}`,
      `drain:${id}`,
      `request:${id}:agent:/api/session/ses_owned_shutdown/inbox`,
    ]),
  );
});

test("Coding shutdown waits for the usage drain before native teardown can proceed", async () => {
  const f = fixture();
  const draining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const shutdown = createCodingRuntimeShutdown(database, f.hub, {
    async drainAttempt(id) {
      expect(id).toBe(attemptID);
      draining.resolve();
      await release.promise;
    },
    async markUnavailable() {
      throw Error("Successful drain must not lose coverage");
    },
  });
  let finished = false;
  const pending = shutdown(attemptID).then(() => {
    finished = true;
  });
  try {
    await draining.promise;
    expect(finished).toBe(false);
  } finally {
    release.resolve();
    await pending;
  }
  expect(finished).toBe(true);
});

test.each([false, true])(
  "Coding shutdown retains unknown coverage for missing or rejected logs, connected=%s",
  async (connected) => {
    const f = fixture(connected);
    const unavailable = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const shutdown = createCodingRuntimeShutdown(database, f.hub, {
      async drainAttempt(id) {
        f.effects.push(`drain:${id}`);
        throw Error("Owned log is unreadable");
      },
      async markUnavailable(id) {
        f.effects.push(`unknown:${id}`);
        unavailable.resolve();
        await release.promise;
      },
    });
    let finished = false;
    const pending = shutdown(attemptID).then(() => {
      finished = true;
    });
    try {
      await unavailable.promise;
      expect(finished).toBe(false);
      expect(f.effects).toEqual([
        `connected:${attemptID}`,
        ...(connected ? [`drain:${attemptID}`] : []),
        `unknown:${attemptID}`,
      ]);
    } finally {
      release.resolve();
      await pending;
    }
    expect(finished).toBe(true);
  },
);

test.each([false, true])(
  "unrecorded unknown usage rejects shutdown instead of allowing Delete, connected=%s",
  async (connected) => {
    const f = fixture(connected);
    const failure = Error("Owned unknown coverage could not be retained");
    const shutdown = createCodingRuntimeShutdown(database, f.hub, {
      async drainAttempt() {
        throw Error("Owned usage log unavailable");
      },
      async markUnavailable(id) {
        expect(id).toBe(attemptID);
        throw failure;
      },
    });
    await expect(shutdown(attemptID)).rejects.toBe(failure);
  },
);
