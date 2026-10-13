import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { factoryProcess } from "../fixtures/factory-process";

test("real Forgejo creates one exact turnkey Starter and recovers the lost initialization response", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
  const name = `owned-slice23-${manager.slice(0, 8)}`;
  const apiURL = "http://127.0.0.1:33030/api/v1/";
  const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
  let lost = false;
  const forge = createForgejoClient({
    apiURL,
    token,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "POST" && String(url).endsWith("/contents") && response.ok && !lost) {
        lost = true;
        await response.body?.cancel();
        throw new DOMException("owned lost initialization response", "AbortError");
      }
      return response;
    },
  });
  const controller = createProjectSetupController({
    database,
    forge,
    forgeOwner: "factory-mutation",
    forgeOrigin: "http://127.0.0.1:33030",
    secrets: {
      configured: false,
      read: async () => undefined,
      create: async () => {
        throw new Error("must not write secrets");
      },
      remove: async () => {
        throw new Error("must not remove secrets");
      },
    },
    signingKey: "owned-starter-proof",
    importOrigins: [],
    onCreated: async () => {},
  });
  let setupID: string | undefined;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${manager},'Owned manager',${`${manager}@starter.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const draft = await controller.begin(manager);
    if (!draft) throw new Error("Owned draft missing");
    setupID = draft.id;
    const updated = await controller.save(manager, {
      id: draft.id,
      version: 1,
      name: "Turnkey product",
      slug: name,
      kind: "starter",
      sourceURL: "",
    });
    const result = await controller.create(manager, {
      id: draft.id,
      version: updated?.version,
      commandID: crypto.randomUUID(),
    });
    expect(lost).toBe(true);
    expect(result?.state).toBe("checking");
    await controller.recover();
    expect((await controller.view(manager))?.state).toBe("created");
    const repository = { owner: "factory-mutation", name };
    const head = await forge.getDefaultBranch(repository);
    const files = await starterFiles();
    expect(await forge.listFiles(repository, head.headSha)).toHaveLength(files.length);
    expect(await forge.getFile(repository, "src/auth.ts", head.headSha)).toContain(
      "drizzleAdapter",
    );
    expect(
      files.some(
        (file) =>
          file.path.startsWith("node_modules/") ||
          file.path.startsWith("dist/") ||
          file.path.startsWith(".env"),
      ),
    ).toBe(false);
    const [membership] =
      await database.client`SELECT role FROM factory.project_membership WHERE user_id=${manager}`;
    expect(membership?.["role"]).toBe("developer");
    expect((await database.client`SELECT manage_project FROM factory.project_membership WHERE user_id=${manager}`)[0]?.["manage_project"]).toBe(true);
  } finally {
    if (setupID) {
      const owned = await forge.setupRepository({ owner: "factory-mutation", name }, setupID);
      if (owned) {
        const response = await fetch(`${apiURL}repos/factory-mutation/${name}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.ok).toBe(true);
      }
    }
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 45_000);
