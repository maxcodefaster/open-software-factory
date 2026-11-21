import { expect, spyOn, test } from "bun:test";
import { createOpenCodeClient } from "./opencode-adapter";
import { connectOpenCodeBrowser, connectOpenCodeSources } from "./opencode-browser";

const admissions = [
  {
    name: "factory_browser",
    connect: connectOpenCodeBrowser,
    url: "http://factory.test/internal/build-browser/owned/turn",
    timeout: { startup: 10_000, catalog: 10_000, execution: 245_000 },
  },
  {
    name: "factory_sources",
    connect: connectOpenCodeSources,
    url: "http://factory.test/internal/mcp/owned/turn",
    timeout: { startup: 10_000, catalog: 15_000, execution: 35_000 },
  },
];

for (const admission of admissions) {
  test(`${admission.name} registers its exact turn-bound facade and reads its connection without inference`, async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = createOpenCodeClient(async (request, path) => {
      calls.push({ method: request.method, path });
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe(
        "/workspace/project",
      );
      if (request.method === "PUT") {
        expect(path.split("?")[0]).toBe(`/api/experimental/mcp/${admission.name}`);
        expect(await request.json()).toEqual({
          config: {
            type: "remote",
            url: admission.url,
            codemode: false,
            oauth: false,
            protocol: "legacy",
            timeout: admission.timeout,
            headers: { Authorization: "Bearer owned-capability" },
          },
        });
        return new Response(null, { status: 204 });
      }
      expect(path.split("?")[0]).toBe("/api/mcp");
      return Response.json({
        data: [{ name: admission.name, status: { status: "connected" } }],
      });
    });
    await admission.connect(
      client,
      "http://factory.test/internal/build-browser/owned/turn",
      "owned-capability",
    );
    expect(calls.map(({ method }) => method)).toEqual(["PUT", "GET"]);
    expect(calls.some(({ path }) => path.includes("/prompt"))).toBe(false);
  });

  test(`${admission.name} awaits registration and the fresh connection read before returning`, async () => {
    const registered = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const connected = Promise.withResolvers<void>();
    const calls: string[] = [];
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    const client = createOpenCodeClient(async (request, path) => {
      calls.push(path.split("?")[0] ?? "");
      if (request.method === "PUT") {
        await registered.promise;
        return new Response(null, { status: 204 });
      }
      reading.resolve();
      await connected.promise;
      return Response.json({
        data: [{ name: admission.name, status: { status: "connected" } }],
      });
    });
    let returned = false;
    const registration = admission
      .connect(client, "http://factory.test/fixed", "owned-capability")
      .then(() => {
        returned = true;
      });
    try {
      expect(calls).toEqual([`/api/experimental/mcp/${admission.name}`]);
      expect(returned).toBe(false);
      registered.resolve();
      await reading.promise;
      expect(returned).toBe(false);
      expect(calls).toEqual([`/api/experimental/mcp/${admission.name}`, "/api/mcp"]);
      connected.resolve();
      await registration;
      expect(returned).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      registered.resolve();
      connected.resolve();
      await registration.catch(() => undefined);
      sleep.mockRestore();
    }
  });

  for (const status of ["pending", "disabled", "failed", "needs_auth", "missing"]) {
    test(`${admission.name} blocks dispatch when its native connection is ${status}`, async () => {
      const calls: string[] = [];
      const client = createOpenCodeClient(async (request, path) => {
        calls.push(path.split("?")[0] ?? "");
        if (request.method === "PUT") return new Response(null, { status: 204 });
        return Response.json({
          data: [
            { name: "unrelated", status: { status: "connected" } },
            ...(status === "missing" ? [] : [{ name: admission.name, status: { status } }]),
          ],
        });
      });
      let dispatched = false;
      const dispatch = async () => {
        await admission.connect(client, "http://factory.test/fixed", "owned-capability");
        dispatched = true;
        await client.session.prompt({
          sessionID: "ses_owned",
          text: "Must not dispatch",
          delivery: "queue",
          resume: true,
        });
      };
      await expect(dispatch()).rejects.toThrow("did not connect before Build dispatch");
      expect(dispatched).toBe(false);
      expect(calls).toEqual([`/api/experimental/mcp/${admission.name}`, "/api/mcp"]);
    });
  }

  test(`${admission.name} does not retry registration or dispatch inference after a failed readiness read`, async () => {
    const calls: string[] = [];
    const client = createOpenCodeClient(async (request, path) => {
      calls.push(path.split("?")[0] ?? "");
      if (request.method === "PUT") return new Response(null, { status: 204 });
      throw new Error("Owned connection read failed");
    });
    await expect(
      admission.connect(client, "http://factory.test/fixed", "owned-capability"),
    ).rejects.toThrow();
    expect(calls).toEqual([`/api/experimental/mcp/${admission.name}`, "/api/mcp"]);
  });

  test(`${admission.name} keeps native registration and observation request bounds`, async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    const client = createOpenCodeClient(async (request) => {
      expect(request.signal.aborted).toBe(false);
      return request.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json({
            data: [{ name: admission.name, status: { status: "connected" } }],
          });
    });
    try {
      await admission.connect(client, "http://factory.test/fixed", "owned-capability");
      expect(timeout.mock.calls).toEqual([[30_000], [5_000]]);
    } finally {
      timeout.mockRestore();
    }
  });

  test(`${admission.name} does not read connection or retry an unconfirmed registration`, async () => {
    const calls: string[] = [];
    const client = createOpenCodeClient(async (_request, path) => {
      calls.push(path.split("?")[0] ?? "");
      throw new Error("Owned registration outcome unconfirmed");
    });
    await expect(
      admission.connect(client, "http://factory.test/fixed", "owned-capability"),
    ).rejects.toThrow();
    expect(calls).toEqual([`/api/experimental/mcp/${admission.name}`]);
  });
}
