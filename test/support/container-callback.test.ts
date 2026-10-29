import { expect, test } from "bun:test";
import { forwardOwnedLoopback, ownedContainerCallback } from "../fixtures/container-callback";

test("an owned interface callback preserves native HTTP bytes and closes only its own connections", async () => {
  const payload = "owned callback body\n".repeat(100_000);
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health") return new Response("retained backend");
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/zero/query");
      expect(new URL(request.url).search).toBe("?scope=owned");
      expect(request.headers.get("cookie")).toBe("owned-session=fixture");
      return new Response(await request.text(), {
        headers: { connection: "close", "x-owned-response": "preserved" },
      });
    },
  });
  let relay: Awaited<ReturnType<typeof forwardOwnedLoopback>> | undefined;
  try {
    relay = await forwardOwnedLoopback(`http://127.0.0.1:${backend.port}`, "127.0.0.1");
    const response = await fetch(`${relay.base}/api/zero/query?scope=owned`, {
      method: "POST",
      headers: { cookie: "owned-session=fixture" },
      body: payload,
    });
    expect(response.headers.get("x-owned-response")).toBe("preserved");
    expect(await response.text()).toBe(payload);
    await relay.dispose();
    const closed = relay.base;
    relay = undefined;
    await expect(fetch(closed)).rejects.toThrow();
    expect(await (await fetch(`http://127.0.0.1:${backend.port}/health`)).text()).toBe(
      "retained backend",
    );
  } finally {
    await relay?.dispose();
    await backend.stop(true);
  }
});

test("callbacks cannot target another service or bind all host interfaces", async () => {
  for (const base of [
    "https://127.0.0.1:3000",
    "http://example.invalid:3000",
    "http://user:password@127.0.0.1:3000",
    "http://127.0.0.1:3000/path",
    "http://127.0.0.1:3000/?query=other",
  ])
    await expect(forwardOwnedLoopback(base, "127.0.0.1")).rejects.toThrow("exact loopback");
  for (const address of ["0.0.0.0", "::", "example.invalid"])
    await expect(forwardOwnedLoopback("http://127.0.0.1:3000", address)).rejects.toThrow(
      "explicit interface",
    );
});

test("Linux callbacks require an explicitly owned network; desktop callbacks preserve the host alias", async () => {
  for (const network of [undefined, "bridge", `foreign-${crypto.randomUUID()}`])
    await expect(ownedContainerCallback("http://127.0.0.1:3000", network, "linux")).rejects.toThrow(
      "owned database network",
    );
  const callback = await ownedContainerCallback("http://127.0.0.1:3000", undefined, "darwin");
  expect(callback.base).toBe("http://host.docker.internal:3000");
  await callback.dispose();
});
