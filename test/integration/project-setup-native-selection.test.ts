import { expect, test } from "bun:test";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { createForgejoClient, ForgeAmbiguousWriteError } from "../../packages/forge/src/forge";
import { factoryProcess } from "../fixtures/factory-process";

test("authenticated fresh setup reserves only its selected native Project and recovers exact Starter initialization", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
  const outsider = crypto.randomUUID();
  const projectID = crypto.randomUUID();
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
    for (const id of [manager, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned user',${`${id}@native-setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const initial = createProjectSetupController(options);
    const draft = await initial.begin(manager);
    if (!draft) throw new Error("Missing setup");
    const controller = createProjectSetupController({
      ...options,
      projectIdentity: { setupID: draft.id, projectID },
    });
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
      await database.client`SELECT project_id FROM factory.project_repository_intent WHERE setup_id=${draft.id}`;
    expect(intent?.["project_id"]).toBe(projectID);
    // Configuration changes cannot retarget already persisted creation intent.
    const changed = createProjectSetupController({
      ...options,
      projectIdentity: { setupID: draft.id, projectID: crypto.randomUUID() },
    });
    await expect(changed.create(manager, command)).rejects.toThrow("changed");
    expect(creates).toBe(1);
    const restarted = createProjectSetupController({
      ...options,
      projectIdentity: { setupID: draft.id, projectID },
    });
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
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

test("native setup refuses retained Project identity before any Forge effect and leaves its draft editable", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const manager = crypto.randomUUID();
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
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${manager},'Owned manager',${`${manager}@native-setup.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    await database.client`INSERT INTO factory.project(id,name,slug,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},'Retained','retained','https://git.native.test/owned/retained','main','.devcontainer/devcontainer.json',${manager})`;
    const controller = createProjectSetupController(options);
    const draft = await controller.begin(manager);
    if (!draft) throw new Error("Missing setup");
    const selected = createProjectSetupController({
      ...options,
      projectIdentity: { setupID: draft.id, projectID },
    });
    const saved = await selected.save(manager, {
      id: draft.id,
      version: draft.version,
      name: "New Starter",
      slug: "new-starter",
      kind: "starter",
      sourceURL: "",
    });
    await expect(
      selected.create(manager, {
        id: draft.id,
        version: saved?.version,
        commandID: crypto.randomUUID(),
      }),
    ).rejects.toThrow("changed");
    expect((await selected.view(manager))?.state).toBe("draft");
    expect(
      await database.client`SELECT command_id FROM factory.project_repository_intent`,
    ).toHaveLength(0);
    expect(
      (
        await database.client`SELECT repository_url FROM factory.project WHERE id=${projectID}`
      )[0]?.["repository_url"],
    ).toBe("https://git.native.test/owned/retained");
    // A different setup does not inherit the reservation.
    const unrelated = createProjectSetupController({
      ...options,
      projectIdentity: { setupID: crypto.randomUUID(), projectID },
    });
    await unrelated.create(manager, {
      id: draft.id,
      version: saved?.version,
      commandID: crypto.randomUUID(),
    });
    const [intent] =
      await database.client`SELECT project_id FROM factory.project_repository_intent`;
    expect(intent?.["project_id"]).not.toBe(projectID);
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);
