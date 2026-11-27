// Typed component runners and isolated data-service rehearsal orchestrator.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { restoreFiles } from "./restore-rehearsal-archive";
import {
  boundedExecute,
  images,
  invocation,
  persist,
  requireThat,
  resourcePlan,
  safeExecute,
  same,
} from "./restore-rehearsal-common";
import {
  cleanupOwned,
  createDockerRunner,
  verifyDaemonPreflight,
} from "./restore-rehearsal-docker";
import { validateForgejoDatabase } from "./restore-rehearsal-forgejo";
import { openBaoRequest } from "./restore-rehearsal-openbao";
import type {
  ComponentName,
  ComponentOutcome,
  DockerRunner,
  Execute,
  Journal,
  LoadedFixture,
  Receipt,
} from "./restore-rehearsal-types";
import { forgejoWitnessProgram, postgresWitnessProgram } from "./restore-rehearsal-witness";

const componentClients: Record<ComponentName, string[]> = {
  state: [],
  postgres: ["postgres"],
  forgejo: ["forgejo"],
  objects: ["rclone", "garage"],
  openbao: ["bao-client", "openbao"],
};

async function runComponentStep(
  runner: DockerRunner,
  f: LoadedFixture,
  receipt: Receipt,
  key: ComponentName,
  action: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ComponentOutcome> {
  signal?.throwIfAborted();
  let status: "passed" | "failed" = "failed";
  try {
    await action();
    signal?.throwIfAborted();
    status = "passed";
  } catch {
    status = "failed";
  } finally {
    for (const client of componentClients[key])
      if (runner.get(client).id && !signal?.aborted) {
        try {
          await runner.command(["container", "stop", runner.get(client).id ?? ""]);
        } catch {
          status = "failed";
          runner.state.fatal = true;
        }
      }
  }
  receipt.components[key] = status;
  await persist(f.evidenceDirectory, "result.json", receipt);
  signal?.throwIfAborted();
  requireThat(
    !runner.state.fatal,
    "Owned client completion unconfirmed; stop before subsequent components",
  );
  return { status, fatal: runner.state.fatal };
}

async function runStateComponent(runner: DockerRunner, f: LoadedFixture) {
  const config = {
    root: "",
    set: f.set,
    source: f.source,
    diskBytes: f.limits.requiredDiskBytes,
    witnessDigest: f.witnessDigest,
  };
  await runner.exec("tools", invocation(restoreFiles, { ...config, verifyOnly: true }));
  await runner.exec("tools", invocation(restoreFiles, config));
}

async function runPostgresComponent(runner: DockerRunner, f: LoadedFixture) {
  await runner.container(
    "postgres",
    images["postgres"] ?? "",
    [
      "--network",
      "none",
      ...runner.controlMount,
      ...runner.volume("postgres-data", "/var/lib/postgresql/data"),
      "--tmpfs",
      "/var/run/postgresql:rw,nosuid,nodev,uid=999,gid=999,mode=0775",
      "--user",
      "999:999",
      "-e",
      "POSTGRES_DB=factory",
      "-e",
      "POSTGRES_USER=factory",
      "-e",
      "POSTGRES_PASSWORD_FILE=/control/pg-password",
      "-e",
      "PGDATA=/var/lib/postgresql/data/pgdata",
    ],
    "docker-entrypoint.sh",
    ["postgres", "-c", "listen_addresses=", "-c", "wal_level=logical"],
  );
  await runner.exec(
    "postgres",
    `set -euo pipefail
until test "$(cat /proc/1/comm)" = postgres && pg_isready -q -U factory -d factory; do sleep 1; done
pg_restore --exit-on-error --single-transaction --no-owner -U factory -d factory /control/postgres.dump >/dev/null 2>&1
`,
    "bash",
  );
  const foreignKeys = await readFile(
    resolve(import.meta.dir, "../../deploy/helm/factory/files/backup/foreign-keys.sql"),
    "utf8",
  );
  const observed = JSON.parse(
    await runner.exec(
      "postgres",
      postgresWitnessProgram(f.witnesses.postgres, foreignKeys),
      "bash",
    ),
  );
  requireThat(
    same(observed, f.witnesses.postgres),
    "Restored PostgreSQL inventory/row digests differ",
  );
}

async function runForgejoComponent(runner: DockerRunner, f: LoadedFixture) {
  await runner.exec("tools", invocation(validateForgejoDatabase, { root: "" }));
  await runner.exec(
    "tools",
    `const fs = await import("node:fs/promises");
await fs.chown("/forgejo/data/forgejo.db", 1000, 1000);
await fs.chmod("/forgejo/data/forgejo.db", 0o600);`,
  );
  await runner.container(
    "forgejo",
    images["forgejo"] ?? "",
    [
      "--network",
      "none",
      "--user",
      "1000:1000",
      ...runner.volume("forgejo-data", "/var/lib/gitea", true),
      ...runner.volume("forgejo-config", "/etc/gitea", true),
    ],
    "sh",
    ["-c", "while :; do sleep 3600; done"],
  );
  // No server, hooks, migrations or restored executable files are started.
  await runner.exec(
    "forgejo",
    forgejoWitnessProgram(
      f.witnesses.forgejo.repositories.map(
        (repo) => `/var/lib/gitea/git/repositories/${repo.slice(6)}`,
      ),
    ),
    "sh",
  );
}

async function runObjectsComponent(runner: DockerRunner) {
  const access = `GK${randomBytes(16).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  const rpc = randomBytes(32).toString("hex");
  await runner.exec(
    "tools",
    `const fs = await import("node:fs/promises");
await fs.writeFile("/control/object-access", ${JSON.stringify(access)}, {mode:0o600});
await fs.writeFile("/control/object-secret", ${JSON.stringify(secret)}, {mode:0o600});`,
  );
  await runner.container(
    "garage",
    images["garage"] ?? "",
    [
      "--network",
      runner.name("network"),
      "--network-alias",
      "garage",
      "--dns",
      "127.0.0.1",
      "--user",
      "1000:1000",
      ...runner.volume("objects-data", "/data"),
      ...runner.controlMount,
      "-e",
      "GARAGE_DEFAULT_BUCKET=factory",
      "-e",
      "GARAGE_DEFAULT_ACCESS_KEY",
      "-e",
      "GARAGE_DEFAULT_SECRET_KEY",
      "-e",
      "GARAGE_RPC_SECRET",
    ],
    "/garage",
    ["-c", "/control/garage.toml", "server", "--single-node", "--default-bucket"],
    {
      GARAGE_DEFAULT_ACCESS_KEY: access,
      GARAGE_DEFAULT_SECRET_KEY: secret,
      GARAGE_RPC_SECRET: rpc,
    },
  );
  await runner.container(
    "rclone",
    images["rclone"] ?? "",
    [
      "--network",
      runner.name("network"),
      "--dns",
      "127.0.0.1",
      ...runner.controlMount,
      ...runner.volume("objects-input", "/objects-input", true),
    ],
    "sh",
    ["-c", "while :; do sleep 3600; done"],
  );
  await runner.exec(
    "rclone",
    `set -eu
export HOME=/tmp RCLONE_CONFIG=/dev/null RCLONE_CONFIG_OBJECTS_TYPE=s3 RCLONE_CONFIG_OBJECTS_PROVIDER=Other
export RCLONE_CONFIG_OBJECTS_ENDPOINT=http://garage:3900 RCLONE_CONFIG_OBJECTS_REGION=garage RCLONE_CONFIG_OBJECTS_FORCE_PATH_STYLE=true
RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID="$(cat /control/object-access)"; export RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID
RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY="$(cat /control/object-secret)"; export RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY
until rclone lsf objects:factory >/dev/null 2>&1; do sleep 1; done
rclone copy /objects-input objects:factory --create-empty-src-dirs --retries 1 >/dev/null 2>&1
rclone check /objects-input objects:factory --download --retries 1 >/dev/null 2>&1
`,
    "sh",
  );
}

async function runOpenBaoComponent(runner: DockerRunner) {
  await runner.container(
    "openbao",
    images["openbao"] ?? "",
    [
      "--network",
      "none",
      "--user",
      "100:1000",
      ...runner.controlMount,
      ...runner.volume("openbao-data", "/bao/data"),
    ],
    "/usr/bin/bao",
    ["server", "-config=/control/bao.json"],
  );
  await runner.container(
    "bao-client",
    images["tools"] ?? "",
    [
      "--network",
      `container:${runner.get("openbao").id}`,
      "--cap-add=CHOWN",
      "--cap-add=DAC_OVERRIDE",
      ...runner.controlMount,
      ...runner.volume("state", "/state", true),
    ],
    "node",
    ["-e", "setInterval(()=>{},2147483647)"],
  );
  await runner.exec("bao-client", invocation(openBaoRequest, { action: "initialize" }));
  await runner.exec(
    "openbao",
    `set -eu
export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/control/tls/ca.crt
BAO_TOKEN="$(cat /control/temporary-root-token)"; export BAO_TOKEN
bao operator raft snapshot restore -force /control/openbao.snap >/dev/null 2>&1
`,
    "sh",
  );
  await runner.exec("bao-client", invocation(openBaoRequest, { action: "validate" }));
}

export async function rehearse(
  f: LoadedFixture,
  execute: Execute = safeExecute,
  signal?: AbortSignal,
): Promise<Receipt> {
  execute = boundedExecute(f, execute);
  signal?.throwIfAborted();
  const planned = resourcePlan(f);
  await verifyDaemonPreflight(f, planned, execute, signal);
  signal?.throwIfAborted();
  await mkdir(f.evidenceDirectory, { mode: 0o700 });
  const journal: Journal = {
    schema: 1,
    owner: f.owner,
    run: randomUUID(),
    source: f.source,
    set: f.set,
    daemonID: f.docker.daemonID,
    resources: [],
  };
  const receipt: Receipt = {
    schema: 1,
    owner: f.owner,
    source: f.source,
    set: f.set,
    status: "incomplete",
    components: {
      postgres: "not-run",
      forgejo: "not-run",
      objects: "not-run",
      openbao: "not-run",
      state: "not-run",
    },
    cleanup: "unconfirmed",
    nativeActivation: "not-run-not-qualified",
    limits: f.limits,
    witnessDigest: f.witnessDigest,
  };
  const runner = createDockerRunner(f, journal, planned, execute, signal);
  const step = (key: ComponentName, action: () => Promise<void>) =>
    runComponentStep(runner, f, receipt, key, action, signal);

  try {
    await persist(f.evidenceDirectory, "result.json", receipt);
    await runner.create("network", ["--internal", "--driver", "bridge"]);
    for (const resource of planned.filter((v) => v.kind === "volume"))
      await runner.create(resource.key, ["--driver", "local"]);
    const toolsMounts = [
      ...runner.controlMount,
      ...runner.inputMount,
      ...runner.volume("state", "/state"),
      ...runner.volume("forgejo-data", "/forgejo"),
      ...runner.volume("forgejo-config", "/forgejo-config"),
      ...runner.volume("openbao-data", "/bao-data"),
      ...runner.volume("postgres-data", "/pg-data"),
      ...runner.volume("objects-data", "/objects-data"),
      ...runner.volume("objects-input", "/objects-input"),
    ];
    await runner.container(
      "tools",
      images["tools"] ?? "",
      [
        "--network",
        "none",
        "--cap-add=CHOWN",
        "--cap-add=FOWNER",
        "--cap-add=DAC_OVERRIDE",
        ...toolsMounts,
      ],
      "node",
      ["-e", "setInterval(()=>{},2147483647)"],
    );
    const stateOutcome = await step("state", () => runStateComponent(runner, f));
    requireThat(
      stateOutcome.status === "passed",
      "Archive/state staging failed; no data services started",
    );
    await step("postgres", () => runPostgresComponent(runner, f));
    await step("forgejo", () => runForgejoComponent(runner, f));
    await step("objects", () => runObjectsComponent(runner));
    await step("openbao", () => runOpenBaoComponent(runner));
  } catch {
    // Unknown/cancelled outcomes are incomplete. Never serialize command errors or raw service output.
  } finally {
    receipt.cleanup = (await cleanupOwned(f, journal, execute)) ? "confirmed" : "unconfirmed";
    if (
      !signal?.aborted &&
      receipt.cleanup === "confirmed" &&
      Object.values(receipt.components).every((v) => v === "passed")
    )
      receipt.status = "data-services-passed";
    await persist(f.evidenceDirectory, "result.json", receipt);
  }
  return receipt;
}
