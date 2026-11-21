import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStartupDispatchGate } from "./startup-dispatch";

const preconnect = globalThis.fetch.preconnect;
const fetchImplementation = (
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) => Object.assign(implementation, { preconnect });

test("source development needs no Helm callback readiness probe", async () => {
  const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No request admitted"));
  try {
    expect(
      await createStartupDispatchGate({
        required: false,
        origin: "http://127.0.0.1:3000",
        startupID: "source",
      })(),
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});

test("local Helm browsers dispatch only after the bound native HTTPS origin is ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-startup-dispatch-"));
  const caFile = join(directory, "public-ca.pem");
  await writeFile(caFile, "Owned public CA");
  const request = spyOn(globalThis, "fetch").mockImplementation(
    fetchImplementation(async (url, options) => {
      expect(String(url)).toBe("https://native.example.test/health/ready?installation=complete");
      expect(options).toMatchObject({ tls: { ca: "Owned public CA" }, redirect: "error" });
      return new Response("ready", {
        headers: { "x-open-factory": "ready", "x-open-factory-startup": "current" },
      });
    }),
  );
  try {
    const ready = createStartupDispatchGate({
      required: true,
      origin: "http://127.0.0.1:58000",
      nativeBinding: { connectorURL: "wss://native.example.test/internal/runtime-connect" },
      startupID: "current",
      caFile,
    });
    expect(await ready()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Helm dispatch requires verified HTTPS from its own startup, never a redirect or old Pod", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-startup-dispatch-"));
  const caFile = join(directory, "public-ca.pem");
  const ca = "Owned public CA";
  await writeFile(caFile, ca);
  let state = "unrouted";
  let calls = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation(
    fetchImplementation(async (url, options) => {
      calls++;
      expect(String(url)).toBe("https://factory.example.test/health/ready?installation=complete");
      expect(options).toMatchObject({ tls: { ca }, redirect: "error" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      if (state === "network" || state === "TLS") throw new Error(state);
      if (state === "unrouted") return new Response("Not found", { status: 404 });
      if (state === "bootstrap") return new Response("Not ready", { status: 503 });
      if (state === "redirect") return new Response(null, { status: 302 });
      return new Response("ready", {
        headers: {
          "x-open-factory": state === "missing-identity" ? "other" : "ready",
          "x-open-factory-startup": state === "old-startup" ? "previous" : "current",
        },
      });
    }),
  );
  try {
    const ready = createStartupDispatchGate({
      required: true,
      origin: "https://factory.example.test",
      startupID: "current",
      caFile,
    });
    for (state of [
      "unrouted",
      "network",
      "TLS",
      "bootstrap",
      "redirect",
      "old-startup",
      "missing-identity",
    ])
      expect(await ready()).toBe(false);
    state = "current";
    expect(await ready()).toBe(true);
    const observed = calls;
    expect(await ready()).toBe(true);
    expect(calls).toBe(observed);
    for (const origin of [
      "http://factory.example.test",
      "https://factory.example.test/path",
      "https://other@factory.example.test",
    ])
      expect(() =>
        createStartupDispatchGate({ required: true, origin, startupID: "current", caFile }),
      ).toThrow();
    expect(() =>
      createStartupDispatchGate({
        required: true,
        origin: "https://factory.example.test",
        startupID: "current",
      }),
    ).toThrow();
    await writeFile(caFile, "");
    expect(() =>
      createStartupDispatchGate({
        required: true,
        origin: "https://factory.example.test",
        startupID: "current",
        caFile,
      }),
    ).toThrow("nonempty public CA");
  } finally {
    request.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent recovery jobs share one public startup observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-startup-dispatch-"));
  const caFile = join(directory, "public-ca.pem");
  await writeFile(caFile, "Owned public CA");
  const response = Promise.withResolvers<Response>();
  const request = spyOn(globalThis, "fetch").mockImplementation(
    fetchImplementation(() => response.promise),
  );
  try {
    const ready = createStartupDispatchGate({
      required: true,
      origin: "https://factory.example.test",
      startupID: "current",
      caFile,
    });
    const one = ready(),
      two = ready();
    expect(one).toBe(two);
    expect(request).toHaveBeenCalledTimes(1);
    response.resolve(
      new Response("ready", {
        headers: { "x-open-factory": "ready", "x-open-factory-startup": "current" },
      }),
    );
    expect(await one).toBe(true);
    expect(await two).toBe(true);
  } finally {
    response.resolve(new Response(null, { status: 503 }));
    request.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
