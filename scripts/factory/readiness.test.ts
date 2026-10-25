import { expect, test } from "bun:test";
import { completeFactoryStartup, waitForFactory } from "./readiness";

test("public Factory start commands keep managed bootstrap instead of launching a bare server", async () => {
  const { scripts } = await Bun.file(new URL("../../package.json", import.meta.url)).json();
  expect(scripts["factory:up"]).toBe("bun scripts/factory/index.ts up");
  expect(scripts["factory:restart"]).toBe("bun scripts/factory/index.ts restart");
  expect(scripts["factory:connect"]).toBe("bun scripts/kubernetes/connect.ts");
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith("factory:"))
      expect(String(command)).not.toContain("apps/factory/src/server.ts");
  }
});

test("restart brings stopped data services back before starting the server", async () => {
  const calls: string[] = [];
  let dataServicesRunning = false;
  await completeFactoryStartup({
    checkStorageReady: async () => {
      calls.push("storage");
    },
    startDependencies: async () => {
      calls.push("dependencies");
      dataServicesRunning = true;
    },
    startServer: async () => {
      if (!dataServicesRunning) throw new Error("Database and Forgejo are still stopped");
      calls.push("server");
    },
    startPlanningCache: async () => {
      calls.push("cache");
    },
    ready: () => {
      calls.push("ready");
    },
  });
  expect(calls).toEqual(["storage", "dependencies", "server", "cache", "ready"]);
});

test("failed data-service readiness leaves the server and planning cache untouched", async () => {
  const calls: string[] = [];
  await expect(
    completeFactoryStartup({
      checkStorageReady: async () => {
        calls.push("storage");
      },
      startDependencies: async () => {
        calls.push("dependencies");
        throw new Error("Database health check failed");
      },
      startServer: async () => {
        calls.push("server");
      },
      startPlanningCache: async () => {
        calls.push("cache");
      },
      ready: () => {
        calls.push("ready");
      },
    }),
  ).rejects.toThrow("Database health check failed");
  expect(calls).toEqual(["storage", "dependencies"]);
});

test("storage failure prevents server replacement, cache startup and the ready announcement", async () => {
  const calls: string[] = [];
  await expect(
    completeFactoryStartup({
      checkStorageReady: async () => {
        calls.push("storage");
        throw new Error("Storage is not writable");
      },
      startDependencies: async () => {
        calls.push("dependencies");
      },
      startServer: async () => {
        calls.push("server");
      },
      startPlanningCache: async () => {
        calls.push("cache");
      },
      ready: () => {
        calls.push("ready");
      },
    }),
  ).rejects.toThrow("Storage is not writable");
  expect(calls).toEqual(["storage"]);
});

test("installation readiness follows the planning cache and is never announced after its failure", async () => {
  const calls: string[] = [];
  const server = async () => {
    calls.push("server");
  };
  await expect(
    completeFactoryStartup({
      checkStorageReady: async () => {
        calls.push("storage");
      },
      startDependencies: async () => {
        calls.push("dependencies");
      },
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
  expect(calls).toEqual(["storage", "dependencies", "server", "cache"]);
  calls.length = 0;
  await completeFactoryStartup({
    checkStorageReady: async () => {
      calls.push("storage");
    },
    startDependencies: async () => {
      calls.push("dependencies");
    },
    startServer: server,
    startPlanningCache: async () => {
      calls.push("cache");
    },
    ready: () => {
      calls.push("ready");
    },
  });
  expect(calls).toEqual(["storage", "dependencies", "server", "cache", "ready"]);
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
      // Identity is the assertion here, not sub-100ms loopback scheduling.
      timeoutMS: 2_000,
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
