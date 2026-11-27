import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase } from "#db/client";
import { createProjectService } from "../../apps/factory/src/projects/service";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

test("native registration admits the actual non-main default and persists its ActorTemplate without execution", async () => {
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
  let prepared = 0;
  const reads: { owner: string; name: string }[] = [];
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Native Project manager',${`${userID}@registration.invalid`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userID})`;
    const service = createProjectService({
      database,
      localRepositoryOrigin: "https://forge.invalid",
      forgeOwner: "owned",
      readDefaultBranch: async (repository) => {
        reads.push(repository);
        return "trunk";
      },
      onRegistered: async () => {
        prepared++;
      },
    });
    const input = {
      slug: `native-${userID}`,
      name: "Native Project",
      repositoryUrl: `https://forge.invalid/owned/native-${userID}.git`,
      defaultBranch: "trunk",
      actorTemplatePath: ".factory/actor-template.json",
    };
    const project = await service.register(userID, input);
    expect(project.defaultBranch).toBe("trunk");
    expect(reads).toEqual([{ owner: "owned", name: input.slug }]);
    expect(project.actorTemplatePath).toBe(input.actorTemplatePath);
    expect(project).not.toHaveProperty("devcontainerPath");
    const [saved] = await database.client<{ path: string }[]>`
      SELECT actor_template_path AS path FROM factory.project WHERE id=${project.id}`;
    expect(saved?.path).toBe(input.actorTemplatePath);
    expect(prepared).toBe(1);
    expect(await database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    const retired = {
      ...input,
      slug: `retired-${userID}`,
      devcontainerPath: ".devcontainer/devcontainer.json",
    } as Parameters<typeof service.register>[1];
    await expect(service.register(userID, retired)).rejects.toThrow();
    expect(await database.client`SELECT id FROM factory.project`).toHaveLength(1);
    expect(prepared).toBe(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
}, 60_000);

test("registration rejects a repository-name/slug mismatch without persisting rows or preparing the Project", async () => {
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
  let prepared = 0;
  let reads = 0;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned registration manager',${`${userID}@registration.invalid`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userID})`;
    const service = createProjectService({
      database,
      localRepositoryOrigin: "https://forge.invalid",
      forgeOwner: "factory-mutation",
      readDefaultBranch: async () => {
        reads++;
        return "main";
      },
      onRegistered: async () => {
        prepared++;
      },
    });
    await expect(
      service.register(userID, {
        slug: "native-observation-4777f596",
        name: "Mismatched Project",
        repositoryUrl: "https://forge.invalid/factory-mutation/factory-source-perf-d6b1f748.git",
        defaultBranch: "main",
        actorTemplatePath: ".factory/actor-template.json",
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Project repository name must match its slug.",
    });
    for (const table of ["project", "project_membership", "operation"])
      expect(await database.client.unsafe(`SELECT * FROM factory.${table}`)).toHaveLength(0);
    expect(prepared).toBe(0);
    expect(reads).toBe(0);
  } finally {
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
}, 60_000);

test.each(["mismatched", "unavailable"] as const)(
  "registration rejects a %s repository default branch without writes or preparation",
  async (branch) => {
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
    const slug = `branch-${userID}`;
    let prepared = 0;
    const reads: { owner: string; name: string }[] = [];
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Owned branch manager',${`${userID}@registration.invalid`})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userID})`;
      const service = createProjectService({
        database,
        localRepositoryOrigin: "https://forge.invalid",
        forgeOwner: "owned",
        readDefaultBranch: async (repository) => {
          reads.push(repository);
          if (branch === "unavailable") throw Error("Owned Forge lookup failed");
          return "trunk";
        },
        onRegistered: async () => {
          prepared++;
        },
      });
      await expect(
        service.register(userID, {
          slug,
          name: "Owned default branch",
          repositoryUrl: `https://forge.invalid/owned/${slug}.git`,
          defaultBranch: "main",
          actorTemplatePath: ".factory/actor-template.json",
        }),
      ).rejects.toMatchObject({
        code: branch === "mismatched" ? "invalid" : "unavailable",
        message:
          branch === "mismatched"
            ? "Project branch must match the repository default branch."
            : "Factory could not confirm the repository default branch. Check Forgejo access and try again.",
      });
      expect(reads).toEqual([{ owner: "owned", name: slug }]);
      for (const table of ["project", "project_membership", "runtime_attempt"])
        expect(await database.client.unsafe(`SELECT * FROM factory.${table}`)).toHaveLength(0);
      expect(
        await database.client`SELECT * FROM factory.operation WHERE scope_type <> 'installation'`,
      ).toHaveLength(0);
      expect(prepared).toBe(0);
    } finally {
      await database.client.end({ timeout: 2 });
      await owned.dispose();
    }
  },
  60_000,
);

test.each(["manager", "account"] as const)(
  "registration releases policy locks during Forge lookup and rechecks %s revocation before writes",
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
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let registration: Promise<unknown> | undefined;
    let registered = 0;
    let reads = 0;
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Owned branch manager',${`${userID}@registration.invalid`})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userID})`;
      const service = createProjectService({
        database,
        localRepositoryOrigin: "https://forge.invalid",
        forgeOwner: "owned",
        readDefaultBranch: async () => {
          reads++;
          entered.resolve();
          await finished.promise;
          return "main";
        },
        onRegistered: async () => {
          registered++;
        },
      });
      registration = service
        .register(userID, {
          slug: `lookup-${userID}`,
          name: "Revoked during Forge lookup",
          repositoryUrl: `https://forge.invalid/owned/lookup-${userID}.git`,
          defaultBranch: "main",
          actorTemplatePath: ".factory/actor-template.json",
        })
        .then(
          (value) => value,
          (cause: unknown) => cause,
        );
      expect(
        await Promise.race([entered.promise.then(() => true), registration.then(() => false)]),
      ).toBe(true);
      await database.client.begin(async (sql) => {
        await sql`SET LOCAL lock_timeout = '2s'`;
        const [lock] = await sql<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended('factory-account-policy',0)) AS acquired`;
        expect(lock?.acquired).toBe(true);
        if (revocation === "manager")
          await sql`DELETE FROM factory.administrator WHERE user_id=${userID}`;
        else await sql`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${userID}`;
      });
      finished.resolve();
      expect(await registration).toMatchObject({
        code: "forbidden",
        message:
          revocation === "manager"
            ? "System Manager access required"
            : "Account access is disabled",
      });
      expect(reads).toBe(1);
      expect(registered).toBe(0);
      for (const table of ["project", "project_membership", "runtime_attempt"])
        expect(await database.client.unsafe(`SELECT * FROM factory.${table}`)).toHaveLength(0);
      expect(
        await database.client`SELECT * FROM factory.operation WHERE scope_type <> 'installation'`,
      ).toHaveLength(0);
    } finally {
      finished.resolve();
      await Promise.allSettled([registration]);
      await database.client.end({ timeout: 2 });
      await owned.dispose();
    }
  },
  60_000,
);

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
    let reads = 0;
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
        readDefaultBranch: async () => {
          reads++;
          return "main";
        },
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
          repositoryUrl: `https://forge.invalid/owned/owned-${userID}.git`,
          defaultBranch: "main",
          actorTemplatePath: ".factory/actor-template.json",
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
      expect(reads).toBe(0);
      for (const table of ["project", "project_membership", "operation"])
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
