import postgres from "postgres";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";

const image =
  "docker.io/library/postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
const label = "factory.test-postgres";
export type PostgresIdentity = { owner: string; url: string };
async function docker(args: string[]) {
  const result = await runCommand(["docker", ...args], undefined, {
    timeoutMS: 60_000,
    outputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(`Owned test database ${args[0]} failed`);
  return result.stdout.trim();
}
async function verify(identity: PostgresIdentity) {
  if (
    !/^[a-f0-9-]{36}$/.test(identity.owner) ||
    !/^postgresql:\/\/factory:owned-test-password@127\.0\.0\.1:\d+\/factory$/.test(identity.url)
  )
    throw new Error("Invalid owned test PostgreSQL identity");
  if (
    (await docker([
      "inspect",
      "--format",
      `{{index .Config.Labels "${label}"}}`,
      `factory-test-postgres-${identity.owner}`,
    ])) !== identity.owner
  )
    throw new Error("Test PostgreSQL ownership mismatch");
}
export async function ownedPostgresServer() {
  const owner = crypto.randomUUID();
  const name = `factory-test-postgres-${owner}`;
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `${label}=${owner}`,
    "--env",
    "POSTGRES_USER=factory",
    "--env",
    "POSTGRES_PASSWORD=owned-test-password",
    "--env",
    "POSTGRES_DB=factory",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--publish",
    "127.0.0.1::5432",
    image,
    "postgres",
    "-c",
    "wal_level=logical",
  ]);
  const port = (await docker(["port", name, "5432/tcp"])).split(":").at(-1);
  const identity = {
    owner,
    url: `postgresql://factory:owned-test-password@127.0.0.1:${port}/factory`,
  };
  async function dispose() {
    await verify(identity);
    await docker(["rm", "--force", name]);
  }
  try {
    const migration = Bun.spawn([process.execPath, "--no-env-file", "packages/db/src/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: identity.url },
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await migration.exited) throw new Error("Owned test baseline migration failed");
    return { identity, dispose };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}
export async function ownedTestDatabase(identity: PostgresIdentity, id: string, retained = false) {
  await verify(identity);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid test database identity");
  const name = `owned_${id.replaceAll("-", "")}`;
  // Do not connect to the template itself while cloning it.
  const admin = postgres(identity.url.replace(/\/factory$/, "/postgres"), { max: 1 });
  try {
    if (retained) {
      const [existing] = await admin<
        { name: string }[]
      >`SELECT datname AS name FROM pg_database WHERE datname=${name}`;
      if (!existing) throw new Error("Retained owned test database is missing");
    } else await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE factory`);
  } finally {
    await admin.end();
  }
  return {
    url: identity.url.replace(/\/factory$/, `/${name}`),
    async dispose() {
      await verify(identity);
      const admin = postgres(identity.url.replace(/\/factory$/, "/postgres"), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
