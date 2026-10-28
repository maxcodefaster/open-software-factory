import { expect, test } from "bun:test";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import type { ImportCredential } from "../../apps/factory/src/setup/secrets";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { isDesktopBackgroundKey } from "../../packages/interface-domain/src/background";
import { factoryProcess } from "../fixtures/factory-process";

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
    expect((await restarted.begin(manager))?.id).not.toBe(draft.id);
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

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
