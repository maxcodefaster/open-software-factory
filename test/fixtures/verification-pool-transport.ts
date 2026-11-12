import { writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";

/** Opaque network transport across the host firewall, without changing any firewall rule. */
export async function verificationPoolTransport(id: string, directory: string, evidence: string) {
  const name = `${id}-transport`;
  const label = "factory.owned-verification-pool";
  const program = `const net=require('net');for(const port of [3000,5000,8000])net.createServer(a=>{const b=net.connect('/owned/relay-'+port+'.sock');for(const s of [a,b])s.on('error',()=>{a.destroy();b.destroy()});a.on('close',()=>b.destroy());b.on('close',()=>a.destroy());a.pipe(b);b.pipe(a)}).listen(port,'0.0.0.0');`;
  const created = await runCommand([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${label}=${id}`,
    "--network",
    id,
    "--memory=128m",
    "--cpus=0.5",
    "--pids-limit=128",
    "--mount",
    `type=bind,src=${directory},dst=/owned,readonly`,
    "docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20",
    "node",
    "-e",
    program,
  ]);
  if (created.exitCode) throw new Error("Owned opaque transport create failed");
  const containerID = created.stdout.trim();
  const metadata = await runCommand(["docker", "inspect", containerID]);
  const original = JSON.parse(metadata.stdout)[0];
  if (original.Id !== containerID || original.Config.Labels[label] !== id)
    throw new Error("Transport ownership differs");
  const ip: string = original.NetworkSettings.Networks[id].IPAddress;
  await writeFile(
    resolve(evidence, "transport-ownership.json"),
    JSON.stringify({ id, name, containerID, ip, program }, null, 2),
  );
  const servers: ReturnType<typeof createServer>[] = [];
  const sockets = new Set<Socket>();
  return {
    ip,
    async attach(base: string, port: 3000 | 5000 | 8000) {
      const target = new URL(base);
      if (
        target.hostname !== "127.0.0.1" ||
        !["http:", "https:"].includes(target.protocol) ||
        !target.port ||
        target.username ||
        target.password
      )
        throw new Error("Transport target must be exact owned loopback");
      const server = createServer((incoming) => {
        const upstream = connect({ host: "127.0.0.1", port: Number(target.port) });
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
        server.listen(resolve(directory, `relay-${port}.sock`), accept);
      });
      servers.push(server);
      return { base: `${target.protocol}//${ip}:${port}` };
    },
    async dispose() {
      for (const socket of sockets) socket.destroy();
      for (const server of servers)
        await new Promise<void>((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept())),
        );
      const observed = await runCommand(["docker", "inspect", containerID]);
      const info = JSON.parse(observed.stdout)[0];
      if (info.Id !== containerID || info.Name !== `/${name}` || info.Config.Labels[label] !== id)
        throw new Error("Transport exact cleanup refused");
      const removed = await runCommand(["docker", "rm", "--force", containerID]);
      if (removed.exitCode) throw new Error("Owned transport cleanup failed");
      await writeFile(
        resolve(evidence, "transport-cleanup.json"),
        JSON.stringify({ id, containerID, removed: true }),
      );
    },
  };
}
