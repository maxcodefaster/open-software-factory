import { chmod, lstat, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";

// Same opaque Unix-socket technique as verification-pool-transport: the owned
// Docker network cannot dial host listeners through this host's firewall.
// Neither firewall changes nor TLS termination/credential forwarding is needed.
export async function substrateTestTransport(path: string, port: number) {
  const sockets = new Set<Socket>();
  const server = createServer((incoming) => {
    const upstream = connect({ host: "127.0.0.1", port });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        incoming.destroy();
        upstream.destroy();
      });
      socket.once("close", () => sockets.delete(socket));
    }
    incoming.on("close", () => upstream.destroy());
    upstream.on("close", () => incoming.destroy());
    incoming.pipe(upstream);
    upstream.pipe(incoming);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(path, accept);
  });
  await chmod(path, 0o660);
  const original = await lstat(path);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
    const current = await lstat(path).catch(() => undefined);
    if (!current) return;
    if (!current.isSocket() || current.ino !== original.ino || current.dev !== original.dev)
      throw new Error("Owned relay socket identity changed");
    await rm(path);
  };
}
