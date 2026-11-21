import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { waitForRegistry } from "./registry-readiness";

test("normal Kubernetes forwarding preparation does not exhaust the Registry check before HTTPS is ready", async () => {
  const started = Date.now();
  let reads = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => started + (reads++ === 0 ? 0 : 20_000));
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    exitCode: 0,
    exited: Promise.resolve(0),
  } as ReturnType<typeof Bun.spawn>);
  try {
    await waitForRegistry({
      forward: { exitCode: null, exited: new Promise<number>(() => {}) },
      host: "registry.localhost:12345",
      caFile: "/owned-registry-ca.pem",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toContain("--cacert");
  } finally {
    spawn.mockRestore();
    clock.mockRestore();
  }
});

test("a Registry that accepts TCP but never responds cannot hold startup past its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-registry-"));
  const caFile = join(directory, "ca.pem");
  await writeFile(caFile, rootCertificates.join("\n"));
  const sockets = new Set<{ terminate(): void }>();
  const clientHello = Promise.withResolvers<Uint8Array>();
  const disconnected = Promise.withResolvers<void>();
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        sockets.add(socket);
      },
      data(_socket, bytes) {
        clientHello.resolve(new Uint8Array(bytes));
      },
      end(socket) {
        socket.end();
      },
      close(socket) {
        sockets.delete(socket);
        disconnected.resolve();
      },
    },
  });
  const close = () => {
    for (const socket of sockets) socket.terminate();
    listener.stop(true);
  };
  const timeoutMS = 100;
  let now = Date.now();
  // Keep host scheduling out of the budget calculation. The real curl still owns
  // its 100ms timeout; its exit advances the observation clock to that deadline.
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const spawn = spyOn(Bun, "spawn");
  let probe: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const forward = { exitCode: null, exited: new Promise<number>(() => {}) };
    const readiness = waitForRegistry({
      forward,
      host: `127.0.0.1:${listener.port}`,
      caFile,
      timeoutMS,
    });
    void readiness.catch(() => {});
    probe = spawn.mock.results[0]?.value as ReturnType<typeof Bun.spawn>;
    void probe.exited.then(() => {
      now += timeoutMS;
    });
    const command = spawn.mock.calls[0]?.[0];
    expect(command).toEqual([
      "curl",
      "--fail",
      "--silent",
      "--connect-timeout",
      "0.1",
      "--max-time",
      "0.1",
      "--cacert",
      caFile,
      `https://127.0.0.1:${listener.port}/v2/`,
    ]);
    const [bytes] = await Promise.all([
      clientHello.promise,
      expect(readiness).rejects.toThrow("not confirmed within 0.1s"),
    ]);
    expect(bytes[0]).toBe(22); // TLS handshake record, deliberately unanswered.
    expect(probe.exitCode).toBe(28); // curl's own timeout, not fixture shutdown.
    await disconnected.promise;
    expect(sockets.size).toBe(0);
    expect(forward.exitCode).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    if (probe?.exitCode === null) probe.kill();
    await probe?.exited;
    spawn.mockRestore();
    clock.mockRestore();
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
