import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHealthProtocol } from "./health";

test("installation HTTP readiness requires this startup's completed bootstrap marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-readiness-"));
  const health = createHealthProtocol(
    {
      factoryOrigin: "http://127.0.0.1:3000",
      startupID: "current-startup",
      planningCacheURL: "http://127.0.0.1:4848",
    },
    directory,
  );
  const request = () =>
    health(new Request("http://127.0.0.1:3000/health/ready?installation=complete"));
  try {
    // The bootstrap supervisor still needs to observe the server before it can
    // finish Forgejo and Zero. That observation does not admit public traffic.
    expect((await health(new Request("http://127.0.0.1:3000/health/ready"))).status).toBe(200);
    expect((await request()).status).toBe(503);
    await writeFile(join(directory, "kubernetes-ready.json"), JSON.stringify({ startupID: "old" }));
    expect((await request()).status).toBe(503);
    await writeFile(join(directory, "kubernetes-ready.json"), "incomplete");
    expect((await request()).status).toBe(503);
    await writeFile(
      join(directory, "kubernetes-ready.json"),
      JSON.stringify({ startupID: "current-startup" }),
    );
    const ready = await request();
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-open-factory-startup")).toBe("current-startup");
    await rm(join(directory, "kubernetes-ready.json"));
    expect((await request()).status).toBe(503);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
