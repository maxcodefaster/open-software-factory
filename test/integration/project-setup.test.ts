import { expect, test } from "bun:test";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import type { ImportCredential } from "../../apps/factory/src/setup/secrets";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { isDesktopBackgroundKey } from "../../packages/interface-domain/src/background";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("retained setup and ambiguous import recover without duplicate repositories with one application connection", async () => {
  const process = await factoryProcess();
  const database = process.connect(1);
  const manager = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const credentials = new Map<string, ImportCredential>();
  let repository: unknown;
  let creates = 0;
  let removed = 0;
  let ready = 0;
  let loseResponse = true;
  const forge = createForgejoClient({
    apiURL: "https://forge.test/api/v1/",
    token: "factory-fixture",
    fetch: async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const [intent] = await database.client`SELECT state,source_url,credential_key
          FROM factory.project_repository_intent`;
        expect(intent?.["state"]).toBe("create-intended");
        expect(intent?.["source_url"]).toBe("https://github.com/team/private.git");
        expect(credentials.has(String(intent?.["credential_key"]))).toBe(true);
        creates++;
        expect(body.mirror).toBe(false);
        expect(body.auth_token).toBe("private-source-token");
        expect(body.clone_addr).toBe("https://github.com/team/private.git");
        repository = {
          name: body.repo_name,
          owner: { login: body.repo_owner },
          default_branch: "trunk",
          private: true,
          mirror: false,
          empty: false,
          description: body.description,
        };
        if (loseResponse) {
          loseResponse = false;
          throw new DOMException("owned response loss", "AbortError");
        }
        return Response.json(repository);
      }
      if (String(_url).includes("/branches/"))
        return Response.json({ name: "trunk", commit: { id: "a".repeat(40) } });
      return repository ? Response.json(repository) : new Response(null, { status: 404 });
    },
  });
  const controller = createProjectSetupController({
    database,
    forge,
    forgeOwner: "factory",
    forgeOrigin: "https://forge.test",
    secrets: {
      configured: true,
      read: async (key) => credentials.get(key),
      create: async (key, value) => {
        const [intent] = await database.client`SELECT state,command_id,fingerprint
          FROM factory.project_repository_intent WHERE credential_key=${key}`;
        expect(intent?.["state"]).toBe("credential-intended");
        expect(intent?.["command_id"]).toBe(value.commandID);
        expect(intent?.["fingerprint"]).toBe(value.fingerprint);
        credentials.set(key, value);
      },
      remove: async (key) => {
        removed++;
        credentials.delete(key);
      },
    },
    signingKey: "owned-fingerprint",
    importOrigins: ["https://github.com"],
    onCreated: async () => {
      ready++;
    },
  });
  try {
    for (const id of [manager, contributor])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned user',${`${id}@setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    await expect(controller.begin(contributor)).rejects.toThrow("System Manager");
    const draft = await controller.begin(manager);
    expect(draft?.state).toBe("draft");
    expect((await controller.begin(manager))?.id).toBe(draft?.id);
    expect((await database.client`SELECT id FROM factory.project`).length).toBe(0);
    if (!draft) throw new Error("Owned draft missing");
    const updated = await controller.save(manager, {
      id: draft.id,
      version: draft.version,
      name: "Private product",
      slug: "private-product",
      kind: "import",
      sourceURL: "https://github.com/team/private.git",
    });
    // Strict input means callers submit fields, not persisted status.
    expect(updated?.version).toBe(2);
    await expect(
      controller.save(manager, {
        id: draft.id,
        version: 1,
        name: "Stale",
        slug: "stale",
        kind: "starter",
        sourceURL: "",
      }),
    ).rejects.toThrow("changed");
    const command = {
      id: draft.id,
      version: 2,
      commandID: crypto.randomUUID(),
      importToken: "private-source-token",
    };
    expect((await controller.create(manager, command))?.state).toBe("checking");
    expect(creates).toBe(1);
    expect((await database.client`SELECT id FROM factory.project`).length).toBe(0);
    const restarted = createProjectSetupController({
      database,
      forge,
      forgeOwner: "factory",
      forgeOrigin: "https://forge.test",
      secrets: {
        configured: true,
        read: async (key) => credentials.get(key),
        create: async () => {
          throw new Error("must not rewrite");
        },
        remove: async (key) => {
          removed++;
          credentials.delete(key);
        },
      },
      signingKey: "owned-fingerprint",
      importOrigins: ["https://github.com"],
      onCreated: async () => {
        ready++;
      },
    });
    await restarted.recover();
    const finished = await restarted.view(manager);
    expect(finished?.state).toBe("created");
    const [createdProject] = await database.client<{ id: string; key: string }[]>`
      SELECT id,desktop_background_key AS key FROM factory.project`;
    if (!createdProject || !finished?.projectID) throw new Error("Created Project is missing");
    expect(createdProject.id).toBe(finished.projectID);
    expect(isDesktopBackgroundKey(createdProject.key)).toBe(true);
    expect(creates).toBe(1);
    expect(credentials.size).toBe(0);
    expect(removed).toBe(1);
    expect(ready).toBe(1);
    expect(
      (
        await database.client`SELECT role FROM factory.project_membership WHERE user_id=${manager}`
      )[0]?.["role"],
    ).toBe("developer");
    expect(
      (
        await database.client`SELECT manage_project FROM factory.project_membership WHERE user_id=${manager}`
      )[0]?.["manage_project"],
    ).toBe(true);
    await restarted.create(manager, { ...command, importToken: undefined });
    const recoveredProjects = await database.client<{ id: string; key: string }[]>`
      SELECT id,desktop_background_key AS key FROM factory.project`;
    expect([...recoveredProjects]).toEqual([createdProject]);
    expect(creates).toBe(1);
    expect(
      JSON.stringify(await database.client`SELECT * FROM factory.project_repository_intent`),
    ).not.toContain("private-source-token");
    await expect(
      (async () => {
        await database.client`UPDATE factory.project_repository_intent SET source_url='https://evil.test/repo'`;
      })(),
    ).rejects.toThrow("immutable");
    const next = await restarted.begin(manager);
    expect(next?.id).not.toBe(draft.id);
    expect(next).toMatchObject({
      version: 1,
      name: "",
      slug: "",
      kind: "starter",
      sourceURL: "",
      state: "draft",
      projectID: null,
      commandID: null,
      failure: null,
    });
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

test("setup draft compare-and-swap keeps one winner under real row-lock contention", async () => {
  const host = await factoryProcess();
  const database = host.connect(4);
  const manager = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let blockerPID = 0;
  let lock: Promise<unknown> | undefined;
  let saves: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const controller = createProjectSetupController({
    database,
    forge: createForgejoClient({
      apiURL: "https://forge.test/api/v1/",
      token: "owned-fixture",
      fetch: async () => {
        throw new Error("Saving a draft must not create a repository");
      },
    }),
    forgeOwner: "owned",
    forgeOrigin: "https://forge.test",
    signingKey: "owned-cas",
    importOrigins: [],
    secrets: {
      configured: false,
      read: async () => undefined,
      create: async () => {},
      remove: async () => {},
    },
    onCreated: async () => {},
  });
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${manager},'Owned CAS',${`${manager}@setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const draft = await controller.begin(manager);
    if (!draft) throw new Error("Owned draft missing");
    await database.client`UPDATE factory.project_setup_draft SET updated_at='2001-01-01'`;
    const [before] = await database.client`SELECT * FROM factory.project_setup_draft`;
    expect(await controller.begin(manager)).toEqual(draft);
    expect((await database.client`SELECT * FROM factory.project_setup_draft`)[0]).toEqual(before);
    lock = database.client.begin(async (transaction) => {
      await transaction`SELECT id FROM factory.project_setup_draft WHERE id=${draft.id} FOR UPDATE`;
      const [backend] = await transaction<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("Owned draft lock backend is missing");
      blockerPID = backend.pid;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    saves = Promise.allSettled(
      ["first", "second"].map((name) =>
        controller.save(manager, {
          id: draft.id,
          version: draft.version,
          name,
          slug: name,
          kind: "starter",
          sourceURL: "",
        }),
      ),
    );
    await eventually(
      async () => {
        const [waiting] = await database.client<{ count: number }[]>`
          WITH RECURSIVE queued(pid) AS (
            SELECT pid FROM pg_stat_activity
            WHERE datname=current_database() AND ${blockerPID}=ANY(pg_blocking_pids(pid))
            UNION
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN queued ON queued.pid=ANY(pg_blocking_pids(activity.pid))
            WHERE activity.datname=current_database()
          )
          SELECT count(*)::integer AS count FROM queued`;
        return waiting?.count;
      },
      (count) => count === 2,
      "Both draft saves did not contend on the retained row",
      3000,
    );
    release.resolve();
    await lock;
    const results = await saves;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await controller.view(manager);
    if (!current) throw new Error("Owned draft missing after CAS");
    expect(current.version).toBe(2);
    expect(["first", "second"]).toContain(current.name);
    const [after] = await database.client`SELECT updated_at FROM factory.project_setup_draft`;
    expect(after?.["updated_at"]).not.toEqual(before?.["updated_at"]);
  } finally {
    release.resolve();
    await lock;
    await saves;
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 10_000);

test("a rejected private import can start another setup without discarding or replaying the old intent", async () => {
  const process = await factoryProcess();
  const database = process.connect(1);
  const manager = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const credentials = new Map<string, ImportCredential>();
  const repositories = new Map<string, { empty: boolean }>();
  let creates = 0;
  const forge = createForgejoClient({
    apiURL: "https://forge.test/api/v1/",
    token: "owned-fixture",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        creates++;
        const body = JSON.parse(String(init.body));
        const repository = {
          name: body.repo_name,
          owner: { login: body.repo_owner },
          default_branch: "main",
          private: true,
          mirror: false,
          empty: !body.auth_token,
          description: body.description,
        };
        repositories.set(body.repo_name, repository);
        return Response.json(repository, { status: body.auth_token ? 201 : 422 });
      }
      const name = path.split("/")[5];
      const repository = name ? repositories.get(name) : undefined;
      if (path.endsWith("/branches/main"))
        return repository?.empty
          ? new Response(null, { status: 404 })
          : Response.json({ name: "main", commit: { id: "a".repeat(40) } });
      return repository ? Response.json(repository) : new Response(null, { status: 404 });
    },
  });
  const controller = createProjectSetupController({
    database,
    forge,
    forgeOwner: "factory",
    forgeOrigin: "https://forge.test",
    signingKey: "owned-recovery",
    importOrigins: ["https://github.com"],
    secrets: {
      configured: true,
      read: async (key) => credentials.get(key),
      create: async (key, value) => {
        credentials.set(key, value);
      },
      remove: async (key) => {
        credentials.delete(key);
      },
    },
    onCreated: async () => {},
  });
  try {
    for (const id of [manager, contributor])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned user',${`${id}@setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const first = await controller.begin(manager);
    if (!first) throw new Error("Missing draft");
    await expect(controller.startAnother(contributor, first.id)).rejects.toThrow("System Manager");
    await expect(controller.startAnother(manager, first.id)).rejects.toThrow("changed");
    const saved = await controller.save(manager, {
      id: first.id,
      version: first.version,
      name: "Private app",
      slug: "first-import",
      kind: "import",
      sourceURL: "https://github.com/team/private.git",
    });
    if (!saved) throw new Error("Missing saved draft");
    const rejected = await controller.create(manager, {
      id: first.id,
      version: saved.version,
      commandID: crypto.randomUUID(),
    });
    expect(rejected?.state).toBe("failed");
    const [original] = await database.client`SELECT * FROM factory.project_repository_intent`;
    // Older versions classified this response as uncertain. Keep observing it
    // after starting another setup, but never repeat its external write.
    await database.client`UPDATE factory.project_repository_intent SET state='uncertain'`;
    await database.client`UPDATE factory.project_setup_draft SET state='checking'`;
    const second = await controller.startAnother(manager, first.id);
    if (!second) throw new Error("Missing new draft");
    expect(second?.id).not.toBe(first.id);
    expect(second?.state).toBe("draft");
    await expect(controller.startAnother(manager, first.id)).rejects.toThrow("changed");
    const updated = await controller.save(manager, {
      id: second.id,
      version: second.version,
      name: "Private app",
      slug: "second-import",
      kind: "import",
      sourceURL: "https://github.com/team/private.git",
    });
    if (!updated) throw new Error("Missing updated draft");
    expect(
      (
        await controller.create(manager, {
          id: second.id,
          version: updated.version,
          commandID: crypto.randomUUID(),
          importToken: "owned-private-token",
        })
      )?.state,
    ).toBe("created");
    await controller.recover();
    expect(creates).toBe(2);
    expect(repositories.size).toBe(2);
    expect(credentials.size).toBe(0);
    // A late successful observation of the previous operation still settles its
    // exact intent and must not replace the new draft's selected Project.
    const previousRepository = repositories.get("first-import");
    if (!previousRepository) throw new Error("Previous repository was discarded");
    previousRepository.empty = false;
    await controller.recover();
    const [retained] =
      await database.client`SELECT * FROM factory.project_repository_intent WHERE setup_id=${first.id}`;
    expect(retained?.["state"]).toBe("committed");
    expect(retained?.["command_id"]).toBe(original?.["command_id"]);
    expect(retained?.["source_url"]).toBe(original?.["source_url"]);
    expect((await controller.view(manager))?.id).toBe(second?.id);
    expect((await database.client`SELECT id FROM factory.project`).length).toBe(2);
    expect(creates).toBe(2);
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

test("an import URL outside the approved hosts is refused with its reason and keeps the draft editable", async () => {
  const process = await factoryProcess();
  const database = process.connect(1);
  const manager = crypto.randomUUID();
  const forge = createForgejoClient({
    apiURL: "https://forge.test/api/v1/",
    token: "owned-fixture",
    fetch: async () => {
      throw new Error("A refused URL must not reach the forge");
    },
  });
  const controller = createProjectSetupController({
    database,
    forge,
    forgeOwner: "factory",
    forgeOrigin: "https://forge.test",
    signingKey: "owned-refusal",
    importOrigins: ["https://github.com"],
    secrets: {
      configured: true,
      read: async () => undefined,
      create: async () => {},
      remove: async () => {},
    },
    onCreated: async () => {},
  });
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${manager},'Owned user',${`${manager}@setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const draft = await controller.begin(manager);
    if (!draft) throw new Error("Missing draft");
    for (const sourceURL of [
      "https://127.0.0.1/team/none.git",
      "https://evil.example/team/none.git",
    ]) {
      const current = await controller.view(manager);
      if (!current) throw new Error("Missing current draft");
      const saved = await controller.save(manager, {
        id: draft.id,
        version: current.version,
        name: "Refused import",
        slug: "refused-import",
        kind: "import",
        sourceURL,
      });
      if (!saved) throw new Error("Missing saved draft");
      await expect(
        controller.create(manager, {
          id: draft.id,
          version: saved.version,
          commandID: crypto.randomUUID(),
        }),
      ).rejects.toThrow(
        "Use a Git URL from an approved HTTPS repository host, without credentials.",
      );
      expect((await controller.view(manager))?.state).toBe("draft");
    }
    expect(
      (await database.client`SELECT command_id FROM factory.project_repository_intent`).length,
    ).toBe(0);
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);
