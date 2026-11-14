import { chmod, chown, mkdir, readFile, rm } from "node:fs/promises";

// Test-only TCP transport to the actual inherited-descriptor Source host.
// Factory uses its private Unix socket directly, never this proxy.
const directory = "/run/factory-owned-source";
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { mode: 0o700 });
await chown("/workspace/project", 1000, 1000);
await chmod("/workspace/project", 0o700);
const access: unknown = JSON.parse(await readFile("/workspace/access.json", "utf8"));
const socket = `${directory}/source.sock`;
const child = Bun.spawn(["/connector", "source-host"], {
  stdin: new Blob([JSON.stringify({ root: "/workspace/project", socket, access })]),
  stdout: "pipe",
  stderr: "inherit",
});
const reader = child.stdout.getReader();
const first = await reader.read();
reader.releaseLock();
if (new TextDecoder().decode(first.value).trim() !== "ready") {
  child.kill("SIGTERM");
  throw Error("Owned native Source did not confirm its inherited listener");
}
const server = Bun.serve({
  port: 4600,
  hostname: "0.0.0.0",
  async fetch(request) {
    return fetch(`http://source.internal${new URL(request.url).pathname}`, {
      unix: socket,
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }),
      signal: request.signal,
    });
  },
});
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  child.kill("SIGTERM");
});
void child.exited.then(async (status) => {
  await server.stop(true);
  process.exit(stopping ? 0 : status || 1);
});
