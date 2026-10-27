import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";

test("the native Bun host serves Start documents without caching and shuts down its lifecycle cleanly", async () => {
  const fixture = await factoryProcess();
  try {
    const child = await fixture.start();
    const page = `${fixture.base}/projects/${crypto.randomUUID()}/tickets/${crypto.randomUUID()}`;
    const headers = { accept: "text/html" };
    const response = await fetch(page, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("Open Software Factory");
    const head = await fetch(page, { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const path of ["/server/entry.js", "/.vite/manifest.json", "/assets/missing.js"]) {
      expect((await fetch(`${fixture.base}${path}`, { headers })).status).toBe(404);
    }
    expect((await fetch(`${fixture.base}/api/missing`, { headers })).status).toBe(401);
    for (const kind of ["inputs", "monitoring"]) {
      const hook = await fetch(
        `${fixture.base}/hooks/${kind}/${crypto.randomUUID()}/${"x".repeat(43)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Owned unknown webhook" }),
        },
      );
      // This is the capability-bound webhook response, not the page fallback
      // or the central-session API gate. An unknown hook admits no work.
      expect(hook.status).toBe(404);
      expect(hook.headers.get("cache-control")).toBe("no-store");
      expect(hook.headers.get("referrer-policy")).toBe("no-referrer");
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 60_000);
