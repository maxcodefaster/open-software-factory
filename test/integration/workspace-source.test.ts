import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { hashConnectorToken, runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import type {
  SourceResourceObservation,
  SourceResources,
  WorkspaceSourceClient,
} from "../../packages/runtime-kubernetes/src/workspace-source";
import { workspaceSourceIdentity } from "../../packages/workspace-domain/src/source";
import { ticketWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { eventually, factoryProcess } from "../fixtures/factory-process";

async function ownedSourceFixture(maxConnections = 10) {
  const processFixture = await factoryProcess();
  const database = processFixture.connect(maxConnections);
  const projectID = crypto.randomUUID();
  const developerID = crypto.randomUUID();
  const otherDeveloperID = crypto.randomUUID();
  const contributorID = crypto.randomUUID();
  const directory = resolve(".factory/test-results", `source-repository-${projectID}`);
  await mkdir(resolve(".factory/test-results"), { recursive: true });
  await mkdir(directory);
  await writeFile(resolve(directory, "owner"), projectID, { flag: "wx" });
  const repository = resolve(directory, "repository");
  for (const args of [
    ["init", "-b", "main", repository],
    [
      "-C",
      repository,
      "-c",
      "user.name=Source fixture",
      "-c",
      "user.email=source@factory.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Owned source fixture",
    ],
  ]) {
    const command = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe" });
    if (await command.exited)
      throw new Error(
        `Owned Source repository setup failed: ${await new Response(command.stderr).text()}`,
      );
  }
  for (const [id, role] of [
    [developerID, "developer"],
    [otherDeveloperID, "developer"],
    [contributorID, "product-contributor"],
  ] as const) {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Source fixture user',${`${id}@factory.invalid`})`;
    if (id === developerID)
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`source-${projectID}`},'Independent source',${`file://${repository}`},'main','.devcontainer/devcontainer.json',${developerID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${id},${role},${developerID})`;
  }
  const previousImages = {
    files: process.env["FACTORY_WORKSPACE_FILES_IMAGE"],
  };
  process.env["FACTORY_WORKSPACE_FILES_IMAGE"] = `registry.invalid/source@sha256:${"1".repeat(64)}`;
  return {
    processFixture,
    database,
    projectID,
    developerID,
    otherDeveloperID,
    contributorID,
    async dispose() {
      for (const [key, value] of [
        ["FACTORY_WORKSPACE_FILES_IMAGE", previousImages.files],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await database.client.end({ timeout: 2 });
      await processFixture.dispose();
      if ((await readFile(resolve(directory, "owner"), "utf8")) !== projectID)
        throw new Error("Owned source test repository changed before cleanup");
      await rm(directory, { recursive: true });
    },
  };
}

test("new Source placement uses the admitted Factorybox node before any execution exists", async () => {
  const fixture = await ownedSourceFixture();
  const previous = process.env["FACTORY_FACTORYBOX_NODE"];
  process.env["FACTORY_FACTORYBOX_NODE"] = "admitted-worker";
  const requested: SourceResources[] = [];
  const observed: SourceResourceObservation = {
    namespaceUID: "placement-namespace",
    claimUID: "placement-claim",
    podUID: "placement-pod",
    storageNode: "admitted-worker",
    ready: true,
    failed: false,
  };
  const sources = createWorkspaceSourceController(fixture.database, "source-placement-fixture", {
    async executionNode() {
      throw new Error("Source does not need running execution");
    },
    async prepare(input) {
      requested.push(input);
      return observed;
    },
    async observe() {
      return observed;
    },
    async connect() {},
    async stop() {},
    close() {},
    async request() {
      throw new Error("No file request needed");
    },
  });
  try {
    const first = await sources.ensurePersonal(fixture.projectID, fixture.developerID);
    await eventually(
      () => sources.get(first.workspaceID, fixture.developerID),
      (view) => view.state === "ready",
      "Source did not retain the admitted node",
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]?.storageNode).toBe("admitted-worker");
    const directory = `workspaces/${first.workspaceID.replaceAll("-", "")}/home`;
    expect(requested[0]?.sourceDirectory).toBe(directory);
    const [source] = await fixture.database.client<
      Array<{ node: string; directory: string; resourceKey: string }>
    >`SELECT storage_node AS node,source_directory AS directory,resource_key AS "resourceKey" FROM factory.workspace_source WHERE workspace_id=${first.workspaceID}`;
    expect(source?.node).toBe("admitted-worker");
    expect(source?.directory).toBe(directory);
    expect(source?.resourceKey).toBe(`${first.workspaceID.replaceAll("-", "")}-1`);
    expect(requested[0]?.identity).toEqual(workspaceSourceIdentity(first.workspaceID, 1));
    await expect(
      (async () => {
        await fixture.database
          .client`UPDATE factory.workspace_source SET source_directory='home' WHERE workspace_id=${first.workspaceID}`;
      })(),
    ).rejects.toThrow("can only be updated to DEFAULT");
    await expect(
      (async () => {
        await fixture.database
          .client`UPDATE factory.workspace_source SET resource_key='another-workspace-1' WHERE workspace_id=${first.workspaceID}`;
      })(),
    ).rejects.toThrow("can only be updated to DEFAULT");
  } finally {
    if (previous === undefined) delete process.env["FACTORY_FACTORYBOX_NODE"];
    else process.env["FACTORY_FACTORYBOX_NODE"] = previous;
    await sources.close();
    await fixture.dispose();
  }
}, 30000);

test("a Source layout without retained resource names cannot recreate or retarget recorded UIDs", async () => {
  const fixture = await ownedSourceFixture();
  let creates = 0;
  let stops = 0;
  let observed: SourceResourceObservation | null = null;
  const adapter: WorkspaceSourceClient = {
    async executionNode() {
      throw new Error("No execution is required");
    },
    async prepare(input) {
      creates++;
      observed = {
        namespaceUID: "retained-namespace",
        claimUID: "retained-claim",
        podUID: "retained-pod",
        storageNode: input.storageNode ?? "retained-node",
        ready: true,
        failed: false,
      };
      return observed;
    },
    async observe() {
      return observed;
    },
    async connect() {},
    async request() {
      throw new Error("No file request is required");
    },
    async stop() {
      stops++;
    },
    close() {},
  };
  let sources = createWorkspaceSourceController(fixture.database, "retained-source-names", adapter);
  try {
    const first = await sources.ensurePersonal(fixture.projectID, fixture.developerID);
    await eventually(
      () => sources.get(first.workspaceID, fixture.developerID),
      (view) => view.state === "ready",
      "Source did not retain its original resources",
    );
    await sources.close();
    const before = await fixture.database.client`
      SELECT workspace_id,state,access_epoch,namespace_uid,claim_uid,pod_uid,source_directory
      FROM factory.workspace_source WHERE workspace_id=${first.workspaceID}`;
    // This is only the fixture's disposable database, not a retained installation.
    await fixture.database.client`ALTER TABLE factory.workspace_source DROP COLUMN resource_key`;
    sources = createWorkspaceSourceController(fixture.database, "retained-source-names", adapter);
    await expect(sources.ensurePersonal(fixture.projectID, fixture.developerID)).rejects.toThrow(
      "resource_key",
    );
    expect(
      await fixture.database.client`
        SELECT workspace_id,state,access_epoch,namespace_uid,claim_uid,pod_uid,source_directory
        FROM factory.workspace_source WHERE workspace_id=${first.workspaceID}`,
    ).toEqual(before);
    expect(creates).toBe(1);
    expect(stops).toBe(0);
  } finally {
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("an interrupted observation worker retries the same source intent without a manual wakeup", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  let interrupted = false;
  let creates = 0;
  const observed: SourceResourceObservation = {
    namespaceUID: "retry-namespace",
    claimUID: "retry-claim",
    podUID: "retry-pod",
    storageNode: "retry-node",
    ready: true,
    failed: false,
  };
  const sources = createWorkspaceSourceController(
    {
      ...database,
      coordination() {
        if (!interrupted) {
          interrupted = true;
          throw new Error("Observation connection was interrupted before acquisition");
        }
        return database.coordination();
      },
    },
    "owned-source-secret",
    {
      async executionNode() {
        throw new Error("Browsing needs no execution");
      },
      async prepare() {
        creates++;
        return observed;
      },
      async observe() {
        return observed;
      },
      async connect() {},
      async request() {
        throw new Error("No browser file request should be necessary");
      },
      async stop() {},
      close() {},
    },
  );
  try {
    const first = await sources.ensurePersonal(projectID, developerID);
    const ready = await eventually(
      () => sources.get(first.workspaceID, developerID),
      (view) => view.state === "ready",
      "The original source intent was orphaned after its observer failed",
      3_000,
    );
    expect(interrupted).toBe(true);
    expect(ready.serviceID).toBe(first.serviceID);
    expect(ready.epoch).toBe(first.epoch);
    expect(creates).toBe(1);
    expect(await database.client`SELECT workspace_id FROM factory.workspace_source`).toHaveLength(
      1,
    );
  } finally {
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("persistent observation faults keep the existing unavailable bound and never create a replacement", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  let elapsed = 0;
  let observations = 0;
  const unexpected = async () => {
    throw new Error("Unavailable observations must not create resources");
  };
  const sources = createWorkspaceSourceController(
    {
      ...database,
      coordination() {
        observations++;
        elapsed += 180_000;
        throw new Error("Observation connection remains unavailable");
      },
    },
    "owned-source-secret",
    {
      executionNode: unexpected,
      prepare: unexpected,
      observe: unexpected,
      connect: unexpected,
      request: unexpected,
      stop: unexpected,
      close() {},
    },
    () => performance.now() + elapsed,
  );
  try {
    const first = await sources.ensurePersonal(projectID, developerID);
    const failed = await eventually(
      () => sources.get(first.workspaceID, developerID),
      (view) => view.state === "failed",
      "Unconfirmed observation failures kept the source worker alive indefinitely",
      4_000,
    );
    expect(observations).toBe(2);
    expect(failed.serviceID).toBe(first.serviceID);
    expect(failed.epoch).toBe(first.epoch);
    expect(failed.failure).toContain("could not be confirmed");
  } finally {
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("source connection warming leaves application reads and Stop available with one connection", async () => {
  const fixture = await ownedSourceFixture(1);
  const connecting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed: SourceResourceObservation = {
    namespaceUID: "pool-namespace",
    claimUID: "pool-claim",
    podUID: "pool-pod",
    storageNode: "pool-node",
    ready: true,
    failed: false,
  };
  const sources = createWorkspaceSourceController(fixture.database, "owned-source-secret", {
    async executionNode() {
      throw new Error("No execution needed");
    },
    async prepare() {
      return observed;
    },
    async observe() {
      return observed;
    },
    async connect() {
      connecting.resolve();
      await release.promise;
    },
    async request() {
      throw new Error("No file request needed");
    },
    async stop() {},
    close() {},
  });
  try {
    const initial = await sources.ensurePersonal(fixture.projectID, fixture.developerID);
    expect(initial.label).toBe("Personal · Independent source");
    await connecting.promise;
    const read = sources.get(initial.workspaceID, fixture.developerID);
    void read.catch(() => {});
    const current = await Promise.race([
      read,
      Bun.sleep(1000).then(() => {
        throw new Error("Source warming starved application reads");
      }),
    ]);
    expect(current.state).toBe("preparing");
    await sources.stop(initial.workspaceID, fixture.developerID);
    release.resolve();
    await eventually(
      () => sources.get(initial.workspaceID, fixture.developerID),
      (value) => value.state === "stopped",
      "Source warming overrode Stop",
    );
  } finally {
    release.resolve();
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("source readiness waits for its exact connection and Stop fences pending connection completion", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  const connecting = Promise.withResolvers<SourceResources>();
  const connected = Promise.withResolvers<void>();
  let connectionCalls = 0;
  let stopped = false;
  const observed: SourceResourceObservation = {
    namespaceUID: "connection-namespace",
    claimUID: "connection-claim",
    podUID: "connection-pod",
    storageNode: "connection-node",
    ready: true,
    failed: false,
  };
  const adapter = {
    async executionNode() {
      throw new Error("Browsing needs no execution");
    },
    async prepare() {
      return observed;
    },
    async observe() {
      return observed;
    },
    async connect(input: SourceResources) {
      connectionCalls++;
      connecting.resolve(input);
      await connected.promise;
    },
    async request() {
      throw new Error("Preparing source must not dispatch file operations");
    },
    async stop() {
      stopped = true;
    },
    close() {},
  };
  const sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
  try {
    const { workspaceID } = await sources.ensurePersonal(projectID, developerID);
    await eventually(
      async () => ({ connectionCalls, view: await sources.get(workspaceID, developerID) }),
      ({ connectionCalls, view }) => connectionCalls > 0 || view.state === "ready",
      "Source preparation did not reach connection readiness",
    );
    expect(connectionCalls).toBe(1);
    const input = await connecting.promise;
    expect(input.namespaceUID).toBe(observed.namespaceUID);
    expect(input.claimUID).toBe(observed.claimUID);
    expect(input.podUID).toBe(observed.podUID);
    expect(input.storageNode).toBe(observed.storageNode);
    expect((await sources.get(workspaceID, developerID)).state).toBe("preparing");
    await expect(
      sources.forward(
        workspaceID,
        developerID,
        "stat",
        new Request("http://factory.invalid/stat", { method: "POST", body: '{"path":""}' }),
      ),
    ).rejects.toThrow("preparing or stopped");
    await sources.stop(workspaceID, developerID);
    connected.resolve();
    await eventually(
      () => sources.get(workspaceID, developerID),
      (view) => view.state === "stopped",
      "Connection completion overrode source Stop",
    );
    expect(stopped).toBe(true);
    expect(connectionCalls).toBe(1);
  } finally {
    connected.resolve();
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("recovery withdraws persisted readiness until authenticated reconnection finishes", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  const reconnecting = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  const observing = Promise.withResolvers<void>();
  const observedReady = Promise.withResolvers<void>();
  let recovery = false;
  const observed: SourceResourceObservation = {
    namespaceUID: "recover-namespace",
    claimUID: "recover-claim",
    podUID: "recover-pod",
    storageNode: "recover-node",
    ready: true,
    failed: false,
  };
  const adapter: WorkspaceSourceClient = {
    async executionNode() {
      throw new Error("No execution");
    },
    async prepare() {
      return observed;
    },
    async observe() {
      if (recovery) {
        observing.resolve();
        await observedReady.promise;
      }
      return observed;
    },
    async connect() {
      if (recovery) {
        reconnecting.resolve();
        await connected.promise;
      }
    },
    async request() {
      return Response.json({});
    },
    async stop() {},
    close() {},
  };
  const sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
  try {
    const initial = await sources.ensurePersonal(projectID, developerID);
    await eventually(
      () => sources.get(initial.workspaceID, developerID),
      (view) => view.state === "ready",
      "Initial source not ready",
    );
    // Let the completed first worker retire before recovering this persisted outcome.
    await Bun.sleep(50);
    recovery = true;
    await sources.recover();
    await observing.promise;
    expect((await sources.get(initial.workspaceID, developerID)).state).toBe("preparing");
    observedReady.resolve();
    await reconnecting.promise;
    connected.resolve();
    const restored = await eventually(
      () => sources.get(initial.workspaceID, developerID),
      (view) => view.state === "ready",
      "Reconnection did not complete",
    );
    expect(restored.epoch).toBe(initial.epoch);
    expect(restored.serviceID).toBe(initial.serviceID);
  } finally {
    observedReady.resolve();
    connected.resolve();
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("explicit source retry observes late readiness without replacing its epoch or resources", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  let creates = 0;
  let connections = 0;
  const observed: SourceResourceObservation = {
    namespaceUID: "late-namespace",
    claimUID: "late-claim",
    podUID: "late-pod",
    storageNode: "late-node",
    ready: true,
    failed: false,
  };
  const adapter: WorkspaceSourceClient = {
    async executionNode() {
      throw new Error("No compute needed");
    },
    async prepare() {
      creates++;
      return observed;
    },
    async observe() {
      return observed;
    },
    async connect() {
      connections++;
    },
    async request() {
      return Response.json({});
    },
    async stop() {},
    close() {},
  };
  let sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
  try {
    const first = await sources.ensurePersonal(projectID, developerID);
    await eventually(
      () => sources.get(first.workspaceID, developerID),
      (view) => view.state === "ready",
      "Initial source preparation did not finish",
    );
    await sources.close();
    // Reproduce a preparation deadline retained in product state while the exact Pod is ready.
    await database.client`UPDATE factory.workspace_source SET state='failed',failure='Source preparation exceeded its deadline. Stop and retry source access.' WHERE workspace_id=${first.workspaceID}`;
    sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
    await sources.ensurePersonal(projectID, developerID);
    await eventually(
      () => sources.get(first.workspaceID, developerID),
      (view) => view.state === "ready",
      "Explicit source retry did not recover late readiness",
      2_000,
    );
    const [current] = await database.client<Array<{ epoch: number; pod: string; claim: string }>>`
      SELECT access_epoch::int AS epoch,pod_uid AS pod,claim_uid AS claim FROM factory.workspace_source WHERE workspace_id=${first.workspaceID}`;
    expect(current).toEqual({ epoch: first.epoch, pod: observed.podUID, claim: observed.claimUID });
    expect(connections).toBe(2);
    expect(creates).toBe(1);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect((await sources.get(first.workspaceID, developerID)).failure).toBeNull();
  } finally {
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("source admission persists intent, recovers lost create acknowledgement and creates no compute", async () => {
  const fixture = await ownedSourceFixture();
  const { database, developerID, projectID, otherDeveloperID, contributorID } = fixture;
  let created = 0;
  let connections = 0;
  let live: SourceResourceObservation | null = null;
  let assigned: SourceResources | undefined;
  const adapter: WorkspaceSourceClient = {
    async executionNode() {
      throw new Error("Source browsing must not need execution");
    },
    async prepare(input) {
      assigned = input;
      const [intent] = await database.client<
        Array<{ epoch: string; capabilityHash: string }>
      >`SELECT access_epoch::text AS epoch,capability_hash AS "capabilityHash" FROM factory.workspace_source WHERE workspace_id=${input.identity.workspaceID}`;
      expect(intent?.epoch).toBe(String(input.identity.epoch));
      expect(intent?.capabilityHash).toBe(hashConnectorToken(input.capability));
      if (live) return live;
      created++;
      live = {
        namespaceUID: "owned-namespace",
        claimUID: "owned-claim",
        podUID: `owned-pod-${input.identity.epoch}`,
        storageNode: "source-node",
        ready: true,
        failed: false,
      };
      if (created === 1) throw new Error("Create succeeded, acknowledgement was lost");
      return live;
    },
    async observe() {
      return live;
    },
    async connect(input) {
      connections++;
      const [recorded] = await database.client<Array<{ state: string; podUID: string }>>`
        SELECT state,pod_uid AS "podUID" FROM factory.workspace_source
        WHERE workspace_id=${input.identity.workspaceID}`;
      expect(recorded?.state).toBe("preparing");
      expect(recorded?.podUID).toBe(input.podUID ?? "missing-pod");
      if (connections === 1) throw new Error("Connection temporarily unavailable");
    },
    async request() {
      return Response.json({ content: "aHVtYW4=" });
    },
    async stop() {
      live = null;
    },
    close() {},
  };
  let sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
  try {
    const admitted = await sources.ensurePersonal(projectID, developerID);
    const workspaceID = admitted.workspaceID;
    await eventually(
      () => sources.get(workspaceID, developerID),
      (view) => view.state === "ready",
      "Source did not recover lost acknowledgement",
    );
    expect(created).toBe(1);
    expect(connections).toBe(2);
    const firstCapability = assigned?.capability;
    expect(JSON.stringify(await sources.get(workspaceID, developerID))).not.toContain(
      firstCapability ?? "server-only-capability",
    );
    await sources.ensurePersonal(projectID, developerID);
    await Bun.sleep(50);
    expect(connections).toBe(2);
    await sources.close();
    sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
    await sources.recover();
    await eventually(
      async () => ({ connections, view: await sources.get(workspaceID, developerID) }),
      ({ connections, view }) => connections === 3 && view.state === "ready",
      "Restart changed source state",
    );
    expect(created).toBe(1);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    await expect(sources.get(workspaceID, otherDeveloperID)).rejects.toThrow("Workspace not found");
    await expect(sources.ensurePersonal(projectID, contributorID)).rejects.toThrow(
      "Developer access required",
    );
    expect(
      await database.client`SELECT id FROM factory.development_workspace WHERE owner_user_id=${contributorID}`,
    ).toHaveLength(0);
    await expect(
      (async () => {
        await database.client`UPDATE factory.workspace_source SET pod_uid='different-pod' WHERE workspace_id=${workspaceID}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await database.client`UPDATE factory.workspace_source SET access_epoch=access_epoch+1 WHERE workspace_id=${workspaceID}`;
      })(),
    ).rejects.toThrow("Stop source access");
    await sources.stop(workspaceID, developerID);
    await eventually(
      () => sources.get(workspaceID, developerID),
      (view) => view.state === "stopped",
      "Source stop did not finish",
    );
    const next = await sources.ensure(workspaceID, developerID);
    expect(next.epoch).toBe(2);
    await eventually(
      () => sources.get(workspaceID, developerID),
      (view) => view.state === "ready",
      "Next source epoch did not start",
    );
    expect(created).toBe(2);
    expect(assigned?.capability).not.toBe(firstCapability);
    expect(assigned?.claimUID).toBe("owned-claim");
    expect(assigned?.identity).toEqual(workspaceSourceIdentity(workspaceID, 2));
    const [names] = await database.client<Array<{ key: string; directory: string }>>`
      SELECT resource_key AS key,source_directory AS directory FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
    expect(names).toEqual({
      key: `${workspaceID.replaceAll("-", "")}-2`,
      directory: `workspaces/${workspaceID.replaceAll("-", "")}/home`,
    });
  } finally {
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test.each([151_000, 721_000])(
  "admitted Contributor execution survives %ims first-volume placement without granting editing authority",
  async (placementMS) => {
    const fixture = await ownedSourceFixture();
    let sources: ReturnType<typeof createWorkspaceSourceController> | undefined;
    try {
      const { database, projectID, contributorID, developerID } = fixture;
      const ticketID = crypto.randomUUID();
      const revisionID = crypto.randomUUID();
      const approvalID = crypto.randomUUID();
      const changeID = crypto.randomUUID();
      const identity = ticketWorkspaceIdentity(changeID);
      const runtime = runtimeIdentity(identity.workspaceID, 1);
      const content = JSON.stringify({
        summary: "Owned source preparation",
        acceptanceCriteria: ["Shared checkout"],
        nonGoals: [],
      });
      await database.client`INSERT INTO factory.ticket(id,project_id,title,created_by) VALUES(${ticketID},${projectID},'Source admission',${contributorID})`;
      await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${contributorID})`;
      await database.client`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approvalID},${ticketID},${revisionID},${contributorID})`;
      const branchName = `factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`;
      await database.client`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${changeID},${projectID},${ticketID},${approvalID},${branchName},${"a".repeat(40)},'starting',${contributorID})`;
      await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,created_by) VALUES(${identity.workspaceID},${projectID},'ticket',${ticketID},${changeID},${branchName},${"a".repeat(40)},${contributorID})`;
      await database.client`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by) VALUES(${runtime.attemptID},${projectID},${changeID},${identity.workspaceID},1,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${contributorID})`;
      await database.client`UPDATE factory.change SET runtime_attempt_id=${runtime.attemptID} WHERE id=${changeID}`;
      let creates = 0;
      let elapsed = 0;
      sources = createWorkspaceSourceController(
        database,
        "owned-source-secret",
        {
          async executionNode() {
            throw new Error("Compute is absent");
          },
          async prepare(input) {
            creates++;
            const [intent] = await database.client<
              Array<{ state: string; kubernetes_uid: string | null }>
            >`SELECT state,kubernetes_uid FROM factory.runtime_attempt WHERE id=${runtime.attemptID}`;
            expect(intent?.state).toBe("create-intended");
            expect(intent?.kubernetes_uid).toBeNull();
            expect(input.identity.workspaceID).toBe(identity.workspaceID);
            expect(
              (
                await database.client<
                  Array<{ state: string }>
                >`SELECT state FROM factory.workspace_source WHERE workspace_id=${identity.workspaceID}`
              )[0]?.state,
            ).toBe("create-intended");
            // Infrastructure placement is not source initialization failure.
            // Observe the same Pod even when placement outlasts an observation window.
            elapsed += placementMS;
            return {
              namespaceUID: "source-namespace",
              claimUID: "source-claim",
              podUID: "source-pod",
              storageNode: "canonical-node",
              ready: false,
              failed: false,
            };
          },
          async observe() {
            return {
              namespaceUID: "source-namespace",
              claimUID: "source-claim",
              podUID: "source-pod",
              storageNode: "canonical-node",
              ready: true,
              failed: false,
            };
          },
          async request() {
            return Response.json({});
          },
          async connect() {},
          async stop() {},
          close() {},
        },
        () => performance.now() + elapsed,
      );
      expect(await sources.prepareExecution(runtime.attemptID)).toEqual({
        workspaceID: identity.workspaceID,
        namespaceUID: "source-namespace",
        claimUID: "source-claim",
        storageNode: "canonical-node",
      });
      expect(creates).toBe(1);
      await expect(sources.get(identity.workspaceID, contributorID)).rejects.toThrow(
        "Developer access required",
      );
      expect((await sources.get(identity.workspaceID, developerID)).state).toBe("ready");
      expect((await sources.get(identity.workspaceID, developerID)).label).toBe(
        "Ticket · Source admission",
      );
      await database.client`UPDATE factory.runtime_attempt SET state='stop-intended',stop_intended_at=now() WHERE id=${runtime.attemptID}`;
      await expect(sources.prepareExecution(runtime.attemptID)).rejects.toThrow("no longer active");
      expect(creates).toBe(1);
    } finally {
      await sources?.close();
      await fixture.dispose();
    }
  },
  30_000,
);

test("source operations use current Developer authority, order revocation after writes and close watches", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  const writeStarted = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  let calls = 0;
  let watchClosed = false;
  const adapter: WorkspaceSourceClient = {
    async executionNode() {
      throw new Error("No execution");
    },
    async prepare() {
      return {
        namespaceUID: "namespace",
        claimUID: "claim",
        podUID: "pod",
        storageNode: "source-node",
        ready: true,
        failed: false,
      };
    },
    async observe() {
      return null;
    },
    async connect() {},
    async request(_input, operation, _request, signal) {
      calls++;
      if (operation === "write") {
        writeStarted.resolve();
        await finishWrite.promise;
        return Response.json({ saved: true });
      }
      if (operation === "events")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"kind":"resync","path":""}\n\n'));
              signal.addEventListener(
                "abort",
                () => {
                  watchClosed = true;
                  controller.close();
                },
                { once: true },
              );
            },
          }),
        );
      return Response.json({ content: "aHVtYW4=" });
    },
    async stop() {},
    close() {},
  };
  const sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
  try {
    const { workspaceID } = await sources.ensurePersonal(projectID, developerID);
    await eventually(
      () => sources.get(workspaceID, developerID),
      (view) => view.state === "ready",
      "Source not ready",
    );
    let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        upload = controller;
      },
    });
    const slowWrite = sources.forward(
      workspaceID,
      developerID,
      "write",
      new Request("http://factory.invalid/write", { method: "POST", body: slowBody }),
    );
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${projectID} AND user_id=${developerID}`;
    upload?.enqueue(new TextEncoder().encode('{"path":"app.ts"}'));
    upload?.close();
    await expect(slowWrite).rejects.toThrow("Developer access required");
    expect(calls).toBe(0);
    await database.client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${projectID} AND user_id=${developerID}`;
    const watch = await sources.forward(
      workspaceID,
      developerID,
      "events",
      new Request("http://factory.invalid/events"),
    );
    const reader = watch.body?.getReader();
    if (!reader) throw new Error("Missing source watch");
    expect((await reader.read()).done).toBe(false);
    await sources.reconcileUserAccess(developerID);
    await sources.reconcileUserAccess(developerID);
    expect(watchClosed).toBe(false);
    const write = sources.forward(
      workspaceID,
      developerID,
      "write",
      new Request("http://factory.invalid/write", { method: "POST", body: '{"path":"app.ts"}' }),
    );
    await writeStarted.promise;
    let revoked = false;
    const downgrade = (async () => {
      await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${projectID} AND user_id=${developerID}`;
      revoked = true;
      // A directory/account event need not retain a deleted membership's former Project.
      await sources.reconcileUserAccess(developerID);
    })();
    await Bun.sleep(50);
    expect(revoked).toBe(false);
    finishWrite.resolve();
    expect((await write).status).toBe(200);
    await downgrade;
    expect(watchClosed).toBe(true);
    expect((await reader.read()).done).toBe(true);
    const before = calls;
    await expect(
      sources.forward(
        workspaceID,
        developerID,
        "read",
        new Request("http://factory.invalid/read", { method: "POST", body: '{"path":"app.ts"}' }),
      ),
    ).rejects.toThrow("Developer access required");
    expect(calls).toBe(before);
  } finally {
    finishWrite.resolve();
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);

test("Stop fences an in-flight source create and failed teardown needs an explicit retry", async () => {
  const fixture = await ownedSourceFixture();
  const { database, projectID, developerID } = fixture;
  const creating = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  let stopCalls = 0;
  let createCalls = 0;
  const adapter: WorkspaceSourceClient = {
    async executionNode() {
      throw new Error("No execution");
    },
    async prepare() {
      createCalls++;
      creating.resolve();
      await acknowledge.promise;
      return {
        namespaceUID: "namespace",
        claimUID: "claim",
        podUID: "pod",
        storageNode: "node",
        ready: true,
        failed: false,
      };
    },
    async observe() {
      return null;
    },
    async connect() {},
    async request() {
      throw new Error("Stopped source must not dispatch");
    },
    async stop() {
      stopCalls++;
      if (stopCalls === 1) throw new Error("Infrastructure teardown is unavailable");
    },
    close() {},
  };
  const sources = createWorkspaceSourceController(database, "owned-source-secret", adapter);
  try {
    const { workspaceID } = await sources.ensurePersonal(projectID, developerID);
    await creating.promise;
    await sources.stop(workspaceID, developerID);
    acknowledge.resolve();
    await eventually(
      async () => stopCalls,
      (count) => count === 1,
      "Stop did not observe the in-flight create",
    );
    await Bun.sleep(700);
    expect(stopCalls).toBe(1);
    expect(createCalls).toBe(1);
    const pending = await sources.get(workspaceID, developerID);
    expect(pending.state).toBe("stop-intended");
    expect(pending.epoch).toBe(1);
    expect(pending.failure).not.toBeNull();
    await sources.stop(workspaceID, developerID);
    await eventually(
      () => sources.get(workspaceID, developerID),
      (view) => view.state === "stopped",
      "Explicit Stop retry did not recover",
    );
    expect(stopCalls).toBe(2);
    expect(createCalls).toBe(1);
  } finally {
    acknowledge.resolve();
    await sources.close();
    await fixture.dispose();
  }
}, 30_000);
