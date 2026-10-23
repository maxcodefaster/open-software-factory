import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { eventually } from "./factory-process";

export const monitoringNativeSource = z
  .object({
    endpoint: z.literal("https://monitoring.factory.test/mcp"),
    bearer: z.string().min(20),
    observations: z.string(),
  })
  .strict();

export async function ownedMonitoringForge(directory: string, id: string) {
  z.uuid().parse(id);
  const container = `factory-owned-monitoring-forge-${id}`;
  const volumes = [`${container}-data`, `${container}-config`];
  const image =
    "codeberg.org/forgejo/forgejo:15.0.10-rootless@sha256:6ffebd9ab9ee9f6677e3523fa60debd9de630ff2a226fa681d6cc0c7ba541d77";
  const owner = "factory-mutation";
  const tokenFile = resolve(directory, "forge-token");
  const originFile = resolve(directory, "forge-origin");
  async function docker(...args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (status !== 0)
      throw new Error(`Owned monitoring Forge ${args[0]} failed. Sensitive output suppressed.`);
    return output.trim();
  }
  async function requireOwnership() {
    const found = await docker(
      "inspect",
      "--format",
      '{{index .Config.Labels "factory.owned-monitoring-forge"}}',
      container,
    );
    if (found !== id) throw new Error("Owned monitoring Forge identity differs");
  }
  const existing = await docker(
    "ps",
    "--all",
    "--filter",
    `name=^${container}$`,
    "--format",
    "{{.Names}}",
  );
  let origin = await readFile(originFile, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (!origin) {
    if (existing) throw new Error("Retained monitoring Forge has no recorded origin");
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      origin = `http://127.0.0.1:${reservation.port}`;
      await writeFile(originFile, origin, { mode: 0o600, flag: "wx" });
    } finally {
      await reservation.stop(true);
    }
  }
  const address = new URL(origin.trim());
  if (address.hostname !== "127.0.0.1" || address.protocol !== "http:" || !address.port)
    throw new Error("Invalid owned monitoring Forge origin");
  origin = address.origin;
  if (existing) {
    await requireOwnership();
    const temporary = JSON.parse(
      await docker("inspect", "--format", "{{json .HostConfig.Tmpfs}}", container),
    );
    if (temporary?.["/var/lib/gitea"] || temporary?.["/etc/gitea"])
      throw new Error(
        "Retained monitoring Forge used volatile storage. Preserve it for inspection; do not adopt replacement data.",
      );
    await docker("start", container);
  } else {
    for (const volume of volumes) {
      await docker("volume", "create", "--label", `factory.owned-monitoring-forge=${id}`, volume);
      const label = await docker(
        "volume",
        "inspect",
        "--format",
        '{{index .Labels "factory.owned-monitoring-forge"}}',
        volume,
      );
      if (label !== id) throw new Error("Owned monitoring Forge volume identity differs");
    }
    await docker(
      "run",
      "--rm",
      "--user",
      "0",
      "--entrypoint",
      "sh",
      "--mount",
      `type=volume,src=${volumes[0]},dst=/var/lib/gitea`,
      "--mount",
      `type=volume,src=${volumes[1]},dst=/etc/gitea`,
      image,
      "-c",
      "chown -R 1000:1000 /var/lib/gitea /etc/gitea",
    );
    await docker(
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `factory.owned-monitoring-forge=${id}`,
      "--mount",
      `type=volume,src=${volumes[0]},dst=/var/lib/gitea`,
      "--mount",
      `type=volume,src=${volumes[1]},dst=/etc/gitea`,
      "--env",
      "FORGEJO__security__INSTALL_LOCK=true",
      "--env",
      "FORGEJO__database__DB_TYPE=sqlite3",
      "--env",
      "FORGEJO__service__DISABLE_REGISTRATION=true",
      "--env",
      "FORGEJO__actions__ENABLED=true",
      "--publish",
      `127.0.0.1:${address.port}:3000`,
      image,
    );
  }
  const port = (await docker("port", container, "3000/tcp")).split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Owned monitoring Forge port is missing");
  await eventually(
    () => fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(1000) }).catch(() => null),
    (response) => response?.ok === true,
    "Owned monitoring Forge did not become healthy",
    30_000,
  );
  let token = await readFile(tokenFile, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (!token) {
    if (existing)
      throw new Error(
        "Retained monitoring Forge has no observed token; do not replace its identity",
      );
    await docker(
      "exec",
      container,
      "forgejo",
      "admin",
      "user",
      "create",
      "--username",
      owner,
      "--random-password",
      "--email",
      `${id}@monitoring.test`,
      "--must-change-password=false",
      "--admin=true",
    );
    token = await docker(
      "exec",
      container,
      "forgejo",
      "admin",
      "user",
      "generate-access-token",
      "--username",
      owner,
      "--token-name",
      `monitoring-${id}`,
      "--scopes",
      "all",
      "--raw",
    );
    await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
  }
  return {
    container,
    origin,
    owner,
    token,
    async execute(args: string[]) {
      await requireOwnership();
      return docker("exec", container, "forgejo", ...args);
    },
    async reload() {
      await requireOwnership();
      await docker("restart", container);
      await eventually(
        () =>
          fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(1000) }).catch(() => null),
        (response) => response?.ok === true,
        "Owned monitoring Forge did not restart",
        30_000,
      );
    },
    async api(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${origin}/api/v1/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`Owned monitoring Forge API ${method} ${path}: ${response.status}`);
      return response.status === 204 ? null : response.json();
    },
    async dispose() {
      await requireOwnership();
      await docker("rm", "--force", container);
      for (const volume of volumes) {
        const label = await docker(
          "volume",
          "inspect",
          "--format",
          '{{index .Labels "factory.owned-monitoring-forge"}}',
          volume,
        );
        if (label !== id) throw new Error("Owned monitoring Forge volume cleanup refused");
        await docker("volume", "rm", volume);
      }
      await unlink(tokenFile);
    },
  };
}
