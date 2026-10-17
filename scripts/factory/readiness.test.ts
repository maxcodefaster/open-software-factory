import { expect, test } from "bun:test";
import { completeFactoryStartup, waitForFactory } from "./readiness";

test("installation readiness follows the planning cache and is never announced after its failure", async () => {
  const calls: string[] = [];
  const server = async () => {
    calls.push("server");
  };
  await expect(
    completeFactoryStartup({
      startServer: server,
      startPlanningCache: async () => {
        calls.push("cache");
        throw new Error("Cache unavailable");
      },
      ready: () => {
        calls.push("ready");
      },
    }),
  ).rejects.toThrow("Cache unavailable");
  expect(calls).toEqual(["server", "cache"]);
  calls.length = 0;
  await completeFactoryStartup({
    startServer: server,
    startPlanningCache: async () => {
      calls.push("cache");
    },
    ready: () => {
      calls.push("ready");
    },
  });
  expect(calls).toEqual(["server", "cache", "ready"]);
});

function child() {
  return Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

test("rejects immediately when its child exits, even while another Factory answers", async () => {
  const listener = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        headers: { "x-open-factory": "ready", "x-open-factory-startup": "expected" },
      }),
  });
  const server = child();
  try {
    server.kill("SIGKILL");
    await server.exited;
    await expect(
      waitForFactory({
        server,
        baseURL: listener.url.origin,
        startupID: "expected",
        timeoutMS: 200,
      }),
    ).rejects.toThrow("Factory server exited before readiness");
  } finally {
    await listener.stop(true);
  }
});

test("does not accept another live listener's readiness", async () => {
  const listener = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        headers: { "x-open-factory": "ready", "x-open-factory-startup": "other" },
      }),
  });
  const server = child();
  try {
    await expect(
      waitForFactory({
        server,
        baseURL: listener.url.origin,
        startupID: "expected",
        timeoutMS: 100,
        intervalMS: 10,
      }),
    ).rejects.toThrow("Factory server did not become ready");
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    await listener.stop(true);
  }
});

test("accepts only the exact started process and current readiness marker", async () => {
  const listener = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        headers: { "x-open-factory": "ready", "x-open-factory-startup": "expected" },
      }),
  });
  const server = child();
  try {
    await waitForFactory({
      server,
      baseURL: listener.url.origin,
      startupID: "expected",
      timeoutMS: 100,
      intervalMS: 10,
    });
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    await listener.stop(true);
  }
});

test("bounds a stalled HTTP response", async () => {
  const listener = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const server = child();
  try {
    const pending = waitForFactory({
      server,
      baseURL: listener.url.origin,
      startupID: "expected",
      timeoutMS: 150,
      requestTimeoutMS: 30,
      intervalMS: 10,
    });
    const outcome = pending.then(
      () => "ready",
      () => "rejected",
    );
    expect(await Promise.race([outcome, Bun.sleep(400).then(() => "hung")])).toBe("rejected");
  } finally {
    server.kill("SIGKILL");
    await server.exited;
    await listener.stop(true);
  }
});

test("child exit interrupts an in-flight readiness request", async () => {
  const listener = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const server = child();
  try {
    const pending = waitForFactory({
      server,
      baseURL: listener.url.origin,
      startupID: "expected",
      timeoutMS: 2_000,
      requestTimeoutMS: 1_000,
    });
    const observed = pending.then(
      () => "ready",
      () => "exited",
    );
    await Bun.sleep(20);
    server.kill("SIGKILL");
    expect(await Promise.race([observed, Bun.sleep(100).then(() => "still-waiting")])).toBe(
      "exited",
    );
    await server.exited;
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
    await server.exited;
    await listener.stop(true);
  }
});
