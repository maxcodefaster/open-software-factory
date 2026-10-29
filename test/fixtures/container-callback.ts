import { connect, createServer, isIP, type Socket } from "node:net";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";

function loopbackTarget(base: string) {
  const target = new URL(base);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("Owned callback requires an exact loopback HTTP listener");
  return target;
}

/** Opaque transport only. The real Factory still owns every HTTP/auth decision. */
export async function forwardOwnedLoopback(base: string, address: string) {
  const target = loopbackTarget(base);
  if (isIP(address) !== 4 || address === "0.0.0.0")
    throw new Error("Owned callback requires one explicit interface address");
  const sockets = new Set<Socket>();
  const server = createServer((incoming) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {
        incoming.destroy();
        upstream.destroy();
      });
    }
    incoming.once("close", () => upstream.destroy());
    upstream.once("close", () => {
      if (!incoming.writableEnded) incoming.destroy();
    });
    incoming.pipe(upstream);
    upstream.pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: address, port: 0 }, resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    server.close();
    throw new Error("Owned callback listener has no TCP address");
  }
  return {
    base: `http://${address}:${bound.port}`,
    async dispose() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Linux loopback-published host ports are not reachable through host-gateway. */
export async function ownedContainerCallback(
  base: string,
  network: string | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  const target = loopbackTarget(base);
  if (platform !== "linux") {
    target.hostname = "host.docker.internal";
    return { base: target.origin, async dispose() {} };
  }
  const match = /^factory-test-postgres-([a-f0-9-]{36})$/.exec(network ?? "");
  const owner = match?.[1];
  if (!owner || !network) throw new Error("Linux callbacks require an owned database network");
  const observed = await runCommand([
    "docker",
    "network",
    "inspect",
    "--format",
    "{{json .}}",
    network,
  ]);
  if (observed.exitCode !== 0) throw new Error("Owned callback network observation failed");
  const metadata = JSON.parse(observed.stdout) as {
    Labels?: Record<string, string>;
    IPAM?: { Config?: { Gateway?: string }[] };
  };
  const gateway = metadata.IPAM?.Config?.find((value) => isIP(value.Gateway ?? "") === 4)?.Gateway;
  if (metadata.Labels?.["factory.test-postgres"] !== owner || !gateway)
    throw new Error("Owned callback network identity differs");
  return forwardOwnedLoopback(base, gateway);
}
