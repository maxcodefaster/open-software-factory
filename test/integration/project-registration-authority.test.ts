import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase } from "../../packages/db/src/client";
import { createProjectService } from "../../apps/factory/src/projects/service";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

test.each(["manager", "account", "directory"] as const)(
  "registration rechecks %s revocation after an observed PostgreSQL policy-lock wait",
  async (revocation) => {
    const owned = await ownedTestDatabase(server.identity, crypto.randomUUID());
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = owned.url;
    let database: ReturnType<typeof createDatabase>;
    try {
      database = createDatabase(4);
    } finally {
      if (previous === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previous;
    }
    const userID = crypto.randomUUID();
    let registered = 0;
    let release: (() => void) | undefined;
    let registration: Promise<unknown> | undefined;
    let blocker: Promise<unknown> | undefined;
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Owned manager',${`${userID}@registration.invalid`})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userID})`;
      const service = createProjectService({
        database,
        localRepositoryOrigin: "https://forge.invalid",
        forgeOwner: "owned",
        onRegistered: async () => {
          registered++;
        },
      });
      const entered = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      release = () => finished.resolve();
      blocker = database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-account-policy',0))`;
        entered.resolve();
        await finished.promise;
        if (revocation === "manager")
          await sql`DELETE FROM factory.administrator WHERE user_id=${userID}`;
        else if (revocation === "account")
          await sql`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${userID}`;
        else
          await sql`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${userID}`;
      });
      await entered.promise;
      registration = service
        .register(userID, {
          slug: `owned-${userID}`,
          name: "Revoked registration",
          repositoryUrl: "https://forge.invalid/owned/repository.git",
          defaultBranch: "main",
          devcontainerPath: ".devcontainer/devcontainer.json",
        })
        .then(
          (value) => value,
          (cause: unknown) => cause,
        );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [lock] = await database.client<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%factory-account-policy%') AS waiting`;
        if (lock?.waiting) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      release();
      await blocker;
      expect(await registration).toMatchObject({
        code: "forbidden",
        message:
          revocation === "manager"
            ? "System Manager access required"
            : "Account access is disabled",
      });
      expect(registered).toBe(0);
      for (const table of ["project", "project_membership", "project_setup_readiness"])
        expect(await database.client.unsafe(`SELECT * FROM factory.${table}`)).toHaveLength(0);
    } finally {
      release?.();
      await Promise.allSettled([blocker, registration]);
      await database.client.end({ timeout: 2 });
      await owned.dispose();
    }
  },
  60_000,
);
