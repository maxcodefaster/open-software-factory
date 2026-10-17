import { expect, test } from "bun:test";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import type { ImportCredential } from "../../apps/factory/src/setup/secrets";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { factoryProcess } from "../fixtures/factory-process";

test("retained setup, protected private import and ambiguous create recover without duplicate repositories", async () => {
  const process = await factoryProcess();
  const database = process.connect();
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
