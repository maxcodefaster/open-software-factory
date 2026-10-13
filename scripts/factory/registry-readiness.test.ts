import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { waitForRegistry } from "./registry-readiness";

test("a Registry that accepts TCP but never responds cannot hold startup past its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-registry-"));
  const caFile = join(directory, "ca.pem");
  await writeFile(caFile, rootCertificates.join("\n"));
  const sockets = new Set<{ terminate(): void }>();
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        sockets.add(socket);
      },
      data() {},
    },
  });
  const close = () => {
    for (const socket of sockets) socket.terminate();
    listener.stop(true);
  };
  const cleanup = setTimeout(close, 500);
  const started = performance.now();
  try {
    await expect(
      waitForRegistry({
        forward: { exitCode: null, exited: new Promise<number>(() => {}) },
        host: `127.0.0.1:${listener.port}`,
        caFile,
        timeoutMS: 100,
      }),
    ).rejects.toThrow("Registry");
    expect(performance.now() - started).toBeLessThan(300);
  } finally {
    clearTimeout(cleanup);
    close();
    await rm(directory, { recursive: true });
  }
});

test("an exited Registry port-forward refuses startup immediately", async () => {
  const started = performance.now();
  await expect(
    waitForRegistry({
      forward: { exitCode: 1, exited: Promise.resolve(1) },
      host: "127.0.0.1:1",
      caFile: "/dev/null",
    }),
  ).rejects.toThrow("port-forward");
  expect(performance.now() - started).toBeLessThan(100);
});
