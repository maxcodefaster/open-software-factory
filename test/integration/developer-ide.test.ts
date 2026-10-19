import { expect, test } from "bun:test";
import { createDeveloperIDEController } from "../../apps/factory/src/workspace/developer-ide-controller";
import type {
  DeveloperIDEClient,
  DeveloperIDEObservation,
} from "../../packages/runtime-kubernetes/src/developer-ide";
import { DeveloperIDEIntentConflict } from "../../packages/runtime-kubernetes/src/developer-ide";
import { eventually, factoryProcess } from "../fixtures/factory-process";

async function fixture(maxConnections = 10, developerID = crypto.randomUUID()) {
  const owned = await factoryProcess();
  const database = owned.connect(maxConnections);
  const contributorID = crypto.randomUUID();
  const projects = [crypto.randomUUID(), crypto.randomUUID()] as const;
  for (const id of [developerID, contributorID])
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Editor fixture',${`${id}@factory.invalid`})`;
  for (const id of projects) {
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${id},${`editor-${id}`},'Editor fixture','https://forge.invalid/editor.git','main','.devcontainer/devcontainer.json',${developerID})`;
    for (const [user, role] of [
      [developerID, "developer"],
      [contributorID, "product-contributor"],
    ] as const)
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${id},${user},${role},${developerID})`;
  }
  const previous = process.env["FACTORY_DEVELOPER_IDE_IMAGE"];
  process.env["FACTORY_DEVELOPER_IDE_IMAGE"] = `registry.invalid/editor@sha256:${"3".repeat(64)}`;
  return {
    database,
    developerID,
    contributorID,
    projectID: projects[0],
    secondProjectID: projects[1],
    async dispose() {
      if (previous === undefined) delete process.env["FACTORY_DEVELOPER_IDE_IMAGE"];
      else process.env["FACTORY_DEVELOPER_IDE_IMAGE"] = previous;
      await database.client.end({ timeout: 2 });
      await owned.dispose();
    },
  };
}

test("separate installations never share an editor namespace even with the same administrator identity", async () => {
  const administratorID = crypto.randomUUID();
  const first = await fixture(10, administratorID);
  const second = await fixture(10, administratorID);
  const namespaces: string[] = [];
  const adapter: DeveloperIDEClient = {
    async prepare(input) {
      namespaces.push(input.identity.namespace);
      return {
        namespaceUID: `namespace-${namespaces.length}`,
        podUID: `pod-${namespaces.length}`,
        ready: true,
        failed: false,
      };
    },
    async observe() {
      throw new Error("Initial creation should not re-observe an unrecorded Pod");
    },
    async endpoint() {
      return "http://127.0.0.1:4400";
    },
    async stop() {},
    close() {},
  };
  const controllers = [
    createDeveloperIDEController(first.database, adapter),
    createDeveloperIDEController(second.database, adapter),
  ];
  try {
    await controllers[0]!.ensure(first.projectID, administratorID);
    await controllers[1]!.ensure(second.projectID, administratorID);
    await eventually(
      async () => Promise.all(controllers.map((controller) => controller.get(administratorID))),
      (views) => views.every((view) => view.state === "ready"),
      "Both independent editor intents must become ready",
    );
    expect(namespaces).toHaveLength(2);
    expect(new Set(namespaces).size).toBe(2);
  } finally {
    for (const controller of controllers) await controller.close();
    await second.dispose();
    await first.dispose();
  }
}, 30_000);

test("a retained conflicting editor changes resource identity only after explicit confirmed Stop", async () => {
  const owned = await fixture();
  const { database, developerID, projectID } = owned;
  const image = `registry.invalid/editor@sha256:${"3".repeat(64)}`;
  await database.client`INSERT INTO factory.developer_ide(user_id,resource_id,state,image,namespace_uid)
    VALUES(${developerID},${developerID},'failed',${image},'retained-namespace')`;
  const attempts: Array<{ namespace: string; resourceID: string }> = [];
  let stops = 0;
  const adapter: DeveloperIDEClient = {
    async prepare(input) {
      attempts.push(input.identity);
      if (input.identity.resourceID === developerID)
        throw new DeveloperIDEIntentConflict("occupied");
      expect(stops).toBe(1);
      expect(input.namespaceUID).toBeNull();
      return {
        namespaceUID: "separate-namespace",
        podUID: "separate-pod",
        ready: true,
        failed: false,
      };
    },
    async observe() {
      throw new DeveloperIDEIntentConflict("occupied");
    },
    async endpoint() {
      return "http://127.0.0.1:4400";
    },
    async stop(input) {
      expect(input.identity.resourceID).toBe(developerID);
      expect(input.podUID).toBeNull();
      stops++;
    },
    close() {},
  };
  const editors = createDeveloperIDEController(database, adapter);
  try {
    await editors.ensure(projectID, developerID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "failed",
      "A known identity conflict must fail without waiting for the startup deadline",
    );
    expect((await editors.get(developerID)).failure).toContain(
      "Existing resources were not changed",
    );
    expect(stops).toBe(0);
    expect(attempts[0]?.resourceID).toBe(developerID);
    await expect(
      (async () => {
        await database.client`UPDATE factory.developer_ide SET resource_id=${crypto.randomUUID()}
          WHERE user_id=${developerID}`;
      })(),
    ).rejects.toThrow("immutable");
    await editors.stop(developerID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "stopped",
      "The uncreated intent must be confirmed stopped",
    );
    await editors.ensure(projectID, developerID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "ready",
      "A separate resource identity must be ready after confirmed Stop",
    );
    expect(attempts[1]?.resourceID).not.toBe(developerID);
    expect(attempts[1]?.namespace).not.toBe(attempts[0]?.namespace);
    expect((await editors.get(developerID)).epoch).toBe(2);
  } finally {
    await editors.close();
    await owned.dispose();
  }
}, 20_000);

test("editor preparation keeps the application pool available with one connection", async () => {
  const owned = await fixture(1);
  const preparing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const editors = createDeveloperIDEController(owned.database, {
    async prepare() {
      preparing.resolve();
      await release.promise;
      return { namespaceUID: "pool-namespace", podUID: "pool-pod", ready: true, failed: false };
    },
    async observe() {
      return null;
    },
    async endpoint() {
      return "http://127.0.0.1:4400";
    },
    async stop() {},
    close() {},
  });
  try {
    await editors.ensure(owned.projectID, owned.developerID);
    await Promise.race([
      preparing.promise,
      Bun.sleep(1000).then(() => {
        throw new Error("Editor preparation deadlocked the application pool");
      }),
    ]);
    const current = await Promise.race([
      editors.get(owned.developerID),
      Bun.sleep(1000).then(() => {
        throw new Error("Editor preparation starved application reads");
      }),
    ]);
    expect(current.state).toBe("create-intended");
    await editors.stop(owned.developerID);
    release.resolve();
    await eventually(
      () => editors.get(owned.developerID),
      (value) => value.state === "stopped",
      "Preparation overrode Stop",
    );
  } finally {
    release.resolve();
    // A failing pool-deadlock regression cannot reach the adapter's release gate.
    // Terminate only this fixture's client before waiting for its worker cleanup.
    await owned.database.client.end({ timeout: 1 });
    await editors.close();
    await owned.dispose();
  }
}, 30_000);

test("explicit editor retry observes a late ready Pod without replacing its recorded intent", async () => {
  const owned = await fixture();
  const { database, developerID, contributorID, projectID } = owned;
  const image = `registry.invalid/editor@sha256:${"3".repeat(64)}`;
  await database.client`INSERT INTO factory.developer_ide(user_id,state,image,namespace_uid,pod_uid,failure)
    VALUES(${developerID},'failed',${image},'retained-namespace','retained-pod','Editor preparation exceeded its deadline.')`;
  let observed = 0;
  const adapter: DeveloperIDEClient = {
    async prepare() {
      throw new Error("Retry must not replace an observed Pod");
    },
    async observe(input) {
      observed++;
      expect(input.namespaceUID).toBe("retained-namespace");
      expect(input.podUID).toBe("retained-pod");
      expect(input.identity.epoch).toBe(1);
      return {
        namespaceUID: "retained-namespace",
        podUID: "retained-pod",
        ready: true,
        failed: false,
      };
    },
    async endpoint() {
      return "http://127.0.0.1:4400";
    },
    async stop() {
      throw new Error("Retry must not Stop a late ready Pod");
    },
    close() {},
  };
  const editors = createDeveloperIDEController(database, adapter);
  try {
    await expect(editors.ensure(projectID, contributorID)).rejects.toThrow(
      "Developer access required",
    );
    await editors.ensure(projectID, developerID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "ready",
      "Explicit retry left the late ready editor failed",
      2_000,
    );
    expect(observed).toBeGreaterThan(0);
    expect(await editors.get(developerID)).toMatchObject({
      epoch: 1,
      state: "ready",
      failure: null,
    });
  } finally {
    await editors.close();
    await owned.dispose();
  }
}, 15_000);

test("developer editor persists intent, shares one backend across Projects and recovers lost acknowledgement", async () => {
  const owned = await fixture();
  const { database, developerID, contributorID, projectID, secondProjectID } = owned;
  let creates = 0;
  let live: DeveloperIDEObservation | null = null;
  const adapter: DeveloperIDEClient = {
    async prepare(input) {
      const [intent] = await database.client<
        Array<{ epoch: string; image: string }>
      >`SELECT service_epoch::text AS epoch,image FROM factory.developer_ide WHERE user_id=${input.identity.userID}`;
      expect(intent?.epoch).toBe(String(input.identity.epoch));
      expect(intent?.image).toBe(input.image);
      if (live) return live;
      live = {
        namespaceUID: "namespace",
        podUID: `pod-${input.identity.epoch}`,
        ready: true,
        failed: false,
      };
      creates++;
      if (creates === 1) throw new Error("Lost create acknowledgement");
      return live;
    },
    async observe() {
      return live;
    },
    async endpoint() {
      return "http://127.0.0.1:4400";
    },
    async stop(input) {
      expect(input.identity.userID).toBe(developerID);
      live = null;
    },
    close() {},
  };
  let editors = createDeveloperIDEController(database, adapter);
  try {
    const [a, b] = await Promise.all([
      editors.ensure(projectID, developerID),
      editors.ensure(secondProjectID, developerID),
    ]);
    expect(a.serviceID).toBe(b.serviceID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "ready",
      "Editor did not recover create",
    );
    expect(creates).toBe(1);
    await editors.close();
    editors = createDeveloperIDEController(database, adapter);
    await editors.recover();
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "ready",
      "Editor changed on recovery",
    );
    expect(creates).toBe(1);
    await expect(editors.ensure(projectID, contributorID)).rejects.toThrow(
      "Developer access required",
    );
    await expect(editors.get(contributorID)).rejects.toThrow("Developer access required");
    expect(
      await database.client`SELECT user_id FROM factory.developer_ide WHERE user_id=${contributorID}`,
    ).toHaveLength(0);
    for (const relation of ["runtime_attempt", "agent_turn", "change", "development_workspace"])
      expect(await database.client.unsafe(`SELECT 1 FROM factory.${relation}`)).toHaveLength(0);
    await expect(
      (async () => {
        await database.client`UPDATE factory.developer_ide SET pod_uid='replaced' WHERE user_id=${developerID}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await database.client`UPDATE factory.developer_ide SET service_epoch=2 WHERE user_id=${developerID}`;
      })(),
    ).rejects.toThrow("Stop the Developer IDE");
    await editors.stop(developerID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "stopped",
      "Editor Stop did not finish",
    );
    expect((await editors.ensure(secondProjectID, developerID)).epoch).toBe(2);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "ready",
      "New editor epoch did not start",
    );
    expect(creates).toBe(2);
    await database.client`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${developerID}`;
    await expect(editors.get(developerID)).rejects.toThrow("Account access is disabled");
    await database.client`UPDATE factory.account_access SET directory_disabled_at=NULL WHERE user_id=${developerID}`;
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${projectID} AND user_id=${developerID}`;
    await editors.revokeMember(projectID, developerID);
    expect((await editors.get(developerID)).state).toBe("ready");
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${secondProjectID} AND user_id=${developerID}`;
    await editors.revokeMember(secondProjectID, developerID);
    await expect(editors.get(developerID)).rejects.toThrow("Developer access required");
    await eventually(
      async () =>
        (
          await database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.developer_ide WHERE user_id=${developerID}`
        )[0]?.state,
      (state) => state === "stopped",
      "Last Developer revocation left editor running",
    );
  } finally {
    await editors.close();
    await owned.dispose();
  }
}, 30_000);

test("recorded editor readiness uses observation without repeating resource preparation", async () => {
  const owned = await fixture();
  const { database, developerID, projectID } = owned;
  let preparations = 0;
  let observations = 0;
  const adapter: DeveloperIDEClient = {
    async prepare() {
      preparations++;
      return { namespaceUID: "namespace", podUID: "pod", ready: false, failed: false };
    },
    async observe(input) {
      observations++;
      expect(input.namespaceUID).toBe("namespace");
      expect(input.podUID).toBe("pod");
      return { namespaceUID: "namespace", podUID: "pod", ready: true, failed: false };
    },
    async endpoint() {
      return "http://127.0.0.1:4400";
    },
    async stop() {},
    close() {},
  };
  let editors = createDeveloperIDEController(database, adapter);
  try {
    await editors.ensure(projectID, developerID);
    await eventually(
      () => editors.get(developerID),
      (view) => view.state === "ready",
      "Recorded editor was not observed ready",
    );
    await editors.close();
    editors = createDeveloperIDEController(database, adapter);
    await editors.recover();
    await eventually(
      async () => observations,
      (count) => count >= 2,
      "Editor recovery did not observe recorded identity",
    );
    expect(preparations).toBe(1);
  } finally {
    await editors.close();
    await owned.dispose();
  }
}, 30_000);

test("Stop during editor create fences its outcome; failed teardown needs an explicit retry", async () => {
  const owned = await fixture();
  const { database, developerID, projectID } = owned;
  const creating = Promise.withResolvers<void>();
  const finishCreate = Promise.withResolvers<void>();
  let stops = 0;
  let failStop = true;
  const adapter: DeveloperIDEClient = {
    async prepare() {
      creating.resolve();
      await finishCreate.promise;
      return { namespaceUID: "namespace", podUID: "pod", ready: true, failed: false };
    },
    async observe() {
      return null;
    },
    async endpoint() {
      throw new Error("Not admitted");
    },
    async stop() {
      stops++;
      if (failStop) throw new Error("Stop failed");
    },
    close() {},
  };
  const editors = createDeveloperIDEController(database, adapter);
  try {
    await editors.ensure(projectID, developerID);
    await creating.promise;
    await editors.stop(developerID);
    finishCreate.resolve();
    await eventually(
      async () =>
        (
          await database.client<
            Array<{ state: string; failure: string | null }>
          >`SELECT state,failure FROM factory.developer_ide WHERE user_id=${developerID}`
        )[0],
      (value) => stops === 1 && value?.state === "stop-intended" && Boolean(value.failure),
      "Stop failure not retained",
    );
    const count = stops;
    await Bun.sleep(600);
    expect(stops).toBe(count);
    expect(stops).toBe(1);
    expect((await editors.get(developerID)).state).not.toBe("ready");
    failStop = false;
    await editors.stop(developerID);
    await eventually(
      () => editors.get(developerID),
      (value) => value.state === "stopped",
      "Explicit Stop retry failed",
    );
  } finally {
    finishCreate.resolve();
    await editors.close();
    await owned.dispose();
  }
}, 30_000);
