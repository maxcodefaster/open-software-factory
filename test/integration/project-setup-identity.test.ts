import { expect, test } from "bun:test";
import { createForgejoClient, ForgeAmbiguousWriteError } from "#forge/forge";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { factoryProcess } from "../fixtures/factory-process";
import { installControlledStarterCatalog } from "../fixtures/starter";

test("authenticated setup persists its own Project identity and recovers exact Starter initialization", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  let restoreStarterCatalog = () => {};
  let creates = 0;
  let initializes = 0;
  let ready = 0;
  let repository: { defaultBranch: string; empty: boolean } | null = null;
  let initialized: readonly { path: string; content: string }[] = [];
  const forge = createForgejoClient({
    apiURL: "http://127.0.0.1:9/api/v1",
    token: "unused",
    fetch: async () => {
      throw new Error("Uncontrolled Forge request");
    },
  });
  forge.setupRepository = async () => repository;
  forge.createSetupRepository = async () => {
    creates++;
    repository = { defaultBranch: "main", empty: true };
    return repository;
  };
  forge.getBranch = async () =>
    initialized.length ? { name: "main", headSha: "a".repeat(40) } : null;
  forge.createSetupFiles = async (input) => {
    initializes++;
    initialized = input.files;
    repository = { defaultBranch: "main", empty: false };
    throw new ForgeAmbiguousWriteError("Owned lost Starter response");
  };
  forge.listFiles = async () =>
    initialized.map((file) => ({
      path: file.path,
      sha: "a".repeat(40),
      size: Buffer.byteLength(file.content),
    }));
  forge.getFile = async (_repository, path) => {
    const file = initialized.find((file) => file.path === path);
    if (!file) throw new Error("Missing owned Starter file");
    return file.content;
  };
  const options = {
    database,
    forge,
    forgeOwner: "owned",
    forgeOrigin: "https://git.native.test",
    signingKey: "owned-native-setup",
    importOrigins: [],
    secrets: {
      configured: false,
      read: async () => undefined,
      create: async () => {
        throw new Error("No import credentials");
      },
      remove: async () => {
        throw new Error("No import credentials");
      },
    },
    onCreated: async () => {
      ready++;
    },
  };
  try {
    restoreStarterCatalog = await installControlledStarterCatalog(process.nativeConfiguration);
    for (const id of [manager, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned user',${`${id}@native-setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const initial = createProjectSetupController(options);
    const draft = await initial.begin(manager);
    if (!draft) throw new Error("Missing setup");
    const controller = initial;
    const saved = await controller.save(manager, {
      id: draft.id,
      version: draft.version,
      name: "Native Starter",
      slug: "native-starter",
      kind: "starter",
      sourceURL: "",
    });
    const command = { id: draft.id, version: saved?.version, commandID: crypto.randomUUID() };
    await expect(controller.create(outsider, command)).rejects.toThrow("System Manager");
    expect(creates).toBe(0);
    expect((await controller.create(manager, command))?.state).toBe("checking");
    expect(creates).toBe(1);
    expect(initializes).toBe(1);
    expect(initialized).toEqual(await starterFiles());
    const [intent] =
      await database.client`SELECT scope_id AS project_id FROM factory.operation WHERE kind='projects.repository_intent' AND payload->>'setupId'=${draft.id}`;
    const projectID = intent?.["project_id"];
    if (typeof projectID !== "string") throw new Error("Missing persisted Project identity");
    await expect(
      controller.create(manager, { ...command, commandID: crypto.randomUUID() }),
    ).rejects.toThrow("changed");
    expect(creates).toBe(1);
    const restarted = createProjectSetupController(options);
    await restarted.recover();
    expect((await restarted.view(manager))?.projectID).toBe(projectID);
    const [project] = await database.client`SELECT id,repository_url FROM factory.project`;
    expect(project?.["id"]).toBe(projectID);
    expect(project?.["repository_url"]).toBe("https://git.native.test/owned/native-starter");
    expect(ready).toBe(1);
    await restarted.create(manager, command);
    expect(creates).toBe(1);
    expect(initializes).toBe(1);
    expect((await restarted.begin(manager))?.id).not.toBe(draft.id);
  } finally {
    restoreStarterCatalog();
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

test("independent setup drafts allocate different Project identities without adopting an existing Project", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
  const otherManager = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const forge = createForgejoClient({
    apiURL: "http://127.0.0.1:9/api/v1",
    token: "unused",
    fetch: async () => {
      throw new Error("No Forge effect allowed");
    },
  });
  const options = {
    database,
    forge,
    forgeOwner: "owned",
    forgeOrigin: "https://git.native.test",
    signingKey: "owned-native-setup",
    importOrigins: [],
    secrets: {
      configured: false,
      read: async () => undefined,
      create: async () => {},
      remove: async () => {},
    },
    onCreated: async () => {},
  };
  try {
    for (const id of [manager, otherManager]) {
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned manager',${`${id}@native-setup.test`})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${id})`;
    }
    await database.client`INSERT INTO factory.project(id,name,slug,repository_url,default_branch,actor_template_path,created_by) VALUES(${projectID},'Retained','retained','https://git.native.test/owned/retained','main','.factory/actor-template.json',${manager})`;
    const controller = createProjectSetupController(options);
    for (const id of [manager, otherManager]) {
      const draft = await controller.begin(id);
      if (!draft) throw new Error("Missing setup");
      const saved = await controller.save(id, {
        id: draft.id,
        version: draft.version,
        name: "New Starter",
        slug: `new-starter-${id}`,
        kind: "starter",
        sourceURL: "",
      });
      await controller.create(id, {
        id: draft.id,
        version: saved?.version,
        commandID: crypto.randomUUID(),
      });
    }
    const intents = await database.client<{ projectID: string }[]>`
      SELECT scope_id AS "projectID" FROM factory.operation WHERE kind='projects.repository_intent'`;
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.projectID)).size).toBe(2);
    expect(intents.every((intent) => intent.projectID !== projectID)).toBe(true);
    expect(
      (
        await database.client`SELECT repository_url FROM factory.project WHERE id=${projectID}`
      )[0]?.["repository_url"],
    ).toBe("https://git.native.test/owned/retained");
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);
