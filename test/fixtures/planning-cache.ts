import { eventually } from "./factory-process";

export async function ownedPlanningCache(
  databaseURL: string,
  base: string,
  observeWhileRunning = false,
  syncWorkers = 1,
) {
  if (!Number.isSafeInteger(syncWorkers) || syncWorkers < 1)
    throw new Error("Owned planning cache requires a positive worker count");
  const owner = crypto.randomUUID();
  const name = `factory-owned-planning-cache-${owner}`;
  console.info(`Owned planning cache intended: ${name}`);
  const database = new URL(databaseURL);
  database.hostname = "host.docker.internal";
  const server = new URL(base);
  server.hostname = "host.docker.internal";
  async function docker(...args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if (await child.exited) throw new Error(`Owned planning cache ${args[0]} failed`);
    return output.trim();
  }
  async function dispose() {
    const label = await docker(
      "inspect",
      "--format",
      '{{index .Config.Labels "factory.owned-planning-cache"}}',
      name,
    );
    if (label !== owner) throw new Error("Planning cache cleanup ownership changed");
    await docker("rm", "--force", name);
  }
  await docker(
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `factory.owned-planning-cache=${owner}`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/data",
    "--publish",
    "127.0.0.1::4848",
    "--env",
    `ZERO_UPSTREAM_DB=${database}`,
    "--env",
    `ZERO_CVR_DB=${database}`,
    "--env",
    `ZERO_CHANGE_DB=${database}`,
    "--env",
    "ZERO_REPLICA_FILE=/data/replica.db",
    "--env",
    "ZERO_ADMIN_PASSWORD=owned-planning-cache-not-a-secret",
    "--env",
    `ZERO_QUERY_URL=${new URL("/api/zero/query", server)}`,
    "--env",
    `ZERO_MUTATE_URL=${new URL("/api/zero/mutate", server)}`,
    "--env",
    "ZERO_ENABLE_CRUD_MUTATIONS=false",
    "--env",
    `ZERO_NUM_SYNC_WORKERS=${syncWorkers}`,
    "--env",
    "ZERO_APP_PUBLICATIONS=factory_zero_publication",
    "--env",
    "ZERO_QUERY_FORWARD_COOKIES=true",
    "--env",
    "ZERO_MUTATE_FORWARD_COOKIES=true",
    "--env",
    "DO_NOT_TRACK=1",
    "docker.io/rocicorp/zero:1.10.0@sha256:745c80f13eb53f5b74e5423d9051269aaa26cd32333fc8da4229b03800d58437",
  );
  console.info(`Owned planning cache started: ${name}`);
  try {
    const port = (await docker("port", name, "4848/tcp")).split(":").at(-1);
    if (!port || !/^\d+$/.test(port)) throw new Error("Planning cache port missing");
    const url = `http://127.0.0.1:${port}`;
    while (true) {
      try {
        await eventually(
          () => fetch(`${url}/keepalive`, { signal: AbortSignal.timeout(1000) }).catch(() => null),
          (response) => response?.ok === true,
          "Owned planning cache not ready",
          120_000,
        );
        break;
      } catch (cause) {
        if (!observeWhileRunning) throw cause;
        const observed = JSON.parse(
          await docker(
            "inspect",
            "--format",
            '{"owner":{{json (index .Config.Labels "factory.owned-planning-cache")}},"image":{{json .Config.Image}},"running":{{json .State.Running}}}',
            name,
          ),
        );
        if (
          observed.owner !== owner ||
          observed.image !==
            "docker.io/rocicorp/zero:1.10.0@sha256:745c80f13eb53f5b74e5423d9051269aaa26cd32333fc8da4229b03800d58437" ||
          !observed.running
        )
          throw cause;
        console.info(
          `Owned cache observation expired while ${name} is still running; observing this same resource`,
        );
      }
    }
    return { url, name, dispose };
  } catch (cause) {
    const logs = await docker("logs", "--tail", "60", name).catch(() => "");
    await dispose();
    throw new Error(`Owned planning cache failed${logs ? `:\n${logs}` : ""}`, { cause });
  }
}
