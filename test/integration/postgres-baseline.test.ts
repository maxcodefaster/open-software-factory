import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";
import { ownedPostgresServer } from "../fixtures/postgres-server";

test("the PostgreSQL invariant command owns a fresh baseline instead of using the development database", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/integration/postgres.ts"], {
    env: {
      ...verificationEnvironment(process.env),
      DATABASE_URL: "postgresql://not-a-retained-database@127.0.0.1:1/not-a-target",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(stdout).toContain("Owned test PostgreSQL intended:");
  expect(stdout).toContain("PostgreSQL clean baseline invariants passed");
});

test("fresh-storage migration upgrades version ten once without changing retained source records", async () => {
  const owned = await ownedPostgresServer();
  const admin = postgres(owned.identity.url, { max: 1 });
  const name = `upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(owned.identity.url);
  url.pathname = `/${name}`;
  let database: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    database = postgres(url.toString(), { max: 1 });
    const directory = new URL("../../packages/db/migrations/", import.meta.url);
    for (const migration of (await readdir(directory)).sort())
      if (/^\d{4}_.+\.sql$/.test(migration) && Number(migration.slice(0, 4)) <= 10)
        await database.unsafe(await readFile(new URL(migration, directory), "utf8"));
    const actorID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    await database`INSERT INTO auth."user"(id,name,email)
      VALUES(${actorID},'Retained upgrade owner',${`${actorID}@upgrade.test`})`;
    await database`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,
      devcontainer_path,created_by,desktop_background_key)
      VALUES(${projectID},${`upgrade-${projectID}`},'Retained upgrade source',
        'https://example.invalid/retained.git','main','.devcontainer/devcontainer.json',
        ${actorID},'river-landscape')`;
    const before = [...(await database`SELECT * FROM factory.project WHERE id=${projectID}`)];
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "packages/db/src/migrate.ts"], {
        env: { ...verificationEnvironment(process.env), DATABASE_URL: url.toString() },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, error] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect({ status, error }).toEqual({ status: 0, error: "" });
      expect([...(await database`SELECT * FROM factory.project WHERE id=${projectID}`)]).toEqual(
        before,
      );
      expect(
        (
          await database<
            Array<{ version: number }>
          >`SELECT version FROM factory.schema_migration ORDER BY version`
        ).map(({ version }) => version),
      ).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    }
  } finally {
    await database?.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
    await owned.dispose();
  }
}, 60_000);
