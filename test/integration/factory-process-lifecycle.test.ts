import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryProcess } from "../fixtures/factory-process";

test("owned Factory fixture joins graceful shutdown and keeps explicit crash injection separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-process-lifecycle-"));
  let fixture: Awaited<ReturnType<typeof factoryProcess>> | undefined;
  // This child tests fixture process ownership only. It starts no Factory
  // controllers, native resources, browser or model call.
  const script = (marker: string) => `
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.FACTORY_PORT),
      fetch: () => new Response("owned fixture lifecycle"),
    });
    process.once("SIGTERM", async () => {
      await Bun.sleep(100);
      await Bun.write(${JSON.stringify(marker)}, "graceful shutdown joined");
      await server.stop(true);
      process.exit(0);
    });
  `;
  try {
    fixture = await factoryProcess();
    const gracefulMarker = join(directory, "graceful");
    const graceful = await fixture.start("-e", [script(gracefulMarker)]);
    await fixture.pause();
    expect(graceful.exitCode).toBe(0);
    expect(await Bun.file(gracefulMarker).text()).toBe("graceful shutdown joined");

    const crashMarker = join(directory, "crash");
    const crashed = await fixture.start("-e", [script(crashMarker)]);
    await fixture.kill(crashed);
    expect(crashed.signalCode).toBe("SIGKILL");
    expect(await Bun.file(crashMarker).exists()).toBe(false);
    await fixture.shutdown();
    expect(await Bun.file(crashMarker).exists()).toBe(false);
  } finally {
    try {
      await fixture?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 60_000);
