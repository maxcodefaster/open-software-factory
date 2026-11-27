import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeActor, nativeSnapshot } from "#runtime-kubernetes/substrate-control";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import {
  starterActiveObservationSchema,
  starterRetainedObservationSchema,
} from "../fixtures/starter-native-lifecycle";
import {
  readStarterRetainedObservation,
  type StarterLifecycleBinding,
  type StarterRuntimeJourneyInput,
  starterLifecycleRequest,
  starterProbeCommand,
  starterRetainedCycle,
  starterRuntimeJourney,
  starterRuntimeTerminalURL,
  starterSnapshotPreference,
} from "../fixtures/starter-runtime-journey";

const attemptID = "01994a7d-0000-7000-8000-000000000001";

function controlledInput(databaseName = "factory") {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let databaseCloses = 0;
  let browserCloses = 0;
  let nativeReads = 0;
  const client = Object.assign(
    async (sql: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: sql.join("?"), values });
      return sql.join("").includes("current_database") ? [{ name: databaseName }] : [];
    },
    { end: async () => databaseCloses++ },
  );
  const input: StarterRuntimeJourneyInput = {
    base: "https://owned-factory.example",
    cookie: "owned-session=not-a-production-secret",
    database: { client } as unknown as StarterRuntimeJourneyInput["database"],
    artifacts: {} as StarterRuntimeJourneyInput["artifacts"],
    artifactDirectory: "/owned/artifacts",
    nativeRead: async () => {
      nativeReads++;
      throw Error("No native access is permitted in this controlled guard check");
    },
    browser: {
      close: async () => browserCloses++,
      newContext: async () => {
        throw Error("No browser session is permitted in this controlled guard check");
      },
    } as unknown as StarterRuntimeJourneyInput["browser"],
    evidenceDirectory: join(".factory/test-results/starter-runtime-journey", crypto.randomUUID()),
    ownership: {
      factoryID: "owned-helm-namespace-uid",
      databaseName: "factory",
      slug: "owned-starter-12345678",
      projectID: crypto.randomUUID(),
      setupID: crypto.randomUUID(),
    },
  };
  return {
    input,
    queries,
    resources: () => ({ databaseCloses, browserCloses, nativeReads }),
  };
}

test.each([
  {
    base: "http://127.0.0.1:58000",
    app: "http://01994a7d000070008000000000000001-app.runtime.localhost:58000",
    terminal: "ws://127.0.0.1:58000",
  },
  {
    base: "https://owned-factory.example",
    app: "https://01994a7d000070008000000000000001-app.runtime.owned-factory.example",
    terminal: "wss://owned-factory.example",
  },
  {
    base: "https://owned-factory.example:8443",
    app: "https://01994a7d000070008000000000000001-app.runtime.owned-factory.example:8443",
    terminal: "wss://owned-factory.example:8443",
  },
])("Starter uses isolated App origins and the existing secure PTY route: $base", (input) => {
  expect(appRuntimeOrigin(input.base, attemptID, "app")).toBe(input.app);
  expect(starterRuntimeTerminalURL(input.base, attemptID)).toBe(
    `${input.terminal}/runtime/${attemptID}/ide/__factory/terminal/owned-browser-proof`,
  );
});

test("Starter PTY cannot accept a foreign protocol, credentials or a malformed Attempt", () => {
  for (const base of ["wss://factory.example", "https://user:password@factory.example"])
    expect(() => starterRuntimeTerminalURL(base, attemptID)).toThrow();
  expect(() => starterRuntimeTerminalURL("https://factory.example", "foreign")).toThrow();
});

test("installed journey refuses a foreign database before any product or resource access", async () => {
  const f = controlledInput("retained-unrelated-database");
  const before = { ...f.input.ownership };
  await expect(starterRuntimeJourney(f.input)).rejects.toThrow();
  expect(f.queries).toEqual([{ sql: "SELECT current_database() AS name", values: [] }]);
  expect(f.input.ownership).toEqual(before);
  expect(f.resources()).toEqual({ databaseCloses: 0, browserCloses: 0, nativeReads: 0 });
});

test("retained journey must match the exact Project, slug and setup before compute access", async () => {
  const f = controlledInput();
  const before = { ...f.input.ownership };
  try {
    await expect(starterRuntimeJourney(f.input)).rejects.toThrow(
      "Retained Starter Project/setup ownership differs",
    );
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]?.values).toEqual([before.projectID, before.slug, before.setupID]);
    expect(f.queries[1]?.sql).toContain("factory.operation");
    expect(f.queries[1]?.sql).toContain("projects.repository_intent");
    expect(f.input.ownership).toEqual(before);
    expect(f.resources()).toEqual({ databaseCloses: 0, browserCloses: 0, nativeReads: 0 });
  } finally {
    await rm(f.input.evidenceDirectory, { recursive: true, force: true });
  }
});

test("explicit Preview recovery cannot create a new fixture or adopt a partial setup", async () => {
  const f = controlledInput();
  f.input.ownership.projectID = "";
  f.input.ownership.setupID = "";
  f.input.restartPreview = true;
  await expect(starterRuntimeJourney(f.input)).rejects.toThrow(
    "Preview recovery requires the exact retained installation",
  );
  expect(f.queries).toHaveLength(0);
  f.input.restartPreview = false;
  f.input.ownership.setupID = crypto.randomUUID();
  await expect(starterRuntimeJourney(f.input)).rejects.toThrow("unused setup identity");
  expect(f.queries).toHaveLength(0);
});

test("each owned Starter declares its native snapshot preference before first Start", () => {
  const project = {
    containers: [
      {
        name: "work",
        image: `registry.example/work@sha256:${"a".repeat(64)}`,
        volumeMounts: [{ name: "source", mountPath: "/workspace" }],
      },
    ],
    volumes: [{ name: "source", durableDir: {} }],
  };
  const content = JSON.stringify(project);
  expect(starterSnapshotPreference(content, "SNAPSHOT_FIDELITY_MEMORY")).toBe(content);
  const rootfs = starterSnapshotPreference(content, "SNAPSHOT_FIDELITY_ROOTFS");
  expect(JSON.parse(rootfs)).toEqual({
    ...project,
    snapshotConfig: { preferredFidelity: "SNAPSHOT_FIDELITY_ROOTFS" },
  });
  expect(starterSnapshotPreference(rootfs, "SNAPSHOT_FIDELITY_ROOTFS")).toBe(rootfs);
  expect(() => starterSnapshotPreference(rootfs, "SNAPSHOT_FIDELITY_MEMORY")).toThrow(
    "different snapshot preference",
  );
});

test("an unsupported restore preference fails before any owned Project operation", async () => {
  const f = controlledInput();
  f.input.restoreFidelity = "SNAPSHOT_FIDELITY_VOLUMES" as never;
  await expect(starterRuntimeJourney(f.input)).rejects.toThrow();
  expect(f.queries).toHaveLength(0);
  expect(f.resources()).toEqual({ databaseCloses: 0, browserCloses: 0, nativeReads: 0 });
});

test("one extracted journey owns Source-before-Preview and native proof; local caller owns cleanup", async () => {
  const journey = await readFile("test/fixtures/starter-runtime-journey.ts", "utf8");
  const caller = await readFile("test/integration/starter-runtime.live.test.ts", "utf8");
  expect(caller.match(/await starterRuntimeJourney\(/g)).toHaveLength(1);
  expect(caller).not.toContain('"ensurePersonalSource"');
  expect(journey.match(/"ensurePersonalSource"/g)).toHaveLength(1);
  const source = journey.indexOf('"ensurePersonalSource"');
  const template = journey.indexOf("requireStarterNativeContract(templateFile.content");
  const preview = journey.indexOf('"Starter setup preview did not become ready"');
  const work = journey.indexOf("await lifecycle.start(");
  expect(source).toBeGreaterThan(0);
  expect(source).toBeLessThan(template);
  expect(template).toBeLessThan(preview);
  expect(preview).toBeLessThan(work);
  expect(journey).toContain('appRuntimeOrigin(base, previewID, "app")');
  expect(journey).toContain(`\`\${appOrigin}/@vite/client\``);
  expect(journey).toContain(`page.goto(\`\${appOrigin}/\`)`);
  expect(journey).toContain('expect(checked.stdout).toContain("fail 0")');
  expect(journey).toContain('expect(checked.stdout).toContain("tsc --noEmit")');
  expect(journey).not.toContain("lifecycle.stop(");
  expect(journey).not.toContain("requireStarterActorAbsent");
  expect(journey).not.toContain("restartedBinding");
  expect(journey).not.toContain("savedReadWithoutWake: true");
  expect(journey).toContain("originalActorRetained: true");
  expect(journey).toContain("destructiveDisposal: false");
  expect(journey).toContain("fidelity: restoreFidelity");
  expect(journey.match(/await starterRetainedCycle\(/g)).toHaveLength(1);
  expect(journey).toContain("starterSnapshotPreference(templateFile.content, restoreFidelity)");
  expect(journey).toContain("before the owned Workspace's first Start");
  expect(journey).toContain("requireStarterRetainedLifecycleEvidence({");
  expect(journey).toContain("snapshot.fidelity !== fidelity");
  expect(journey).toContain("projectID = ownership.projectID = created.projectID");
  expect(journey).toContain("setupID = ownership.setupID = draft.id");
  expect(journey).not.toContain("process.env[");
  for (const operation of [
    "factoryProcess(",
    "localOpenBao(",
    "chromium.launch(",
    "factory.dispose(",
    "browser.close(",
    "database.client.end(",
  ])
    expect(journey).not.toContain(operation);
  for (const operation of [
    'process.env["FACTORY_RUN_STARTER_RUNTIME_PROOF"] !== "1"',
    'process.env["FACTORY_STARTER_DELIVERY_ONLY"] === "1"',
    'process.env["FACTORY_RUN_STARTER_DELIVERY_PROOF"] === "1"',
    "const retainedStarter =",
    "await factory.pause()",
    "await lifecycle.pause(attempt.workspaceID, requestID)",
    "destructiveDisposal: false",
    "if (projectID || setupID) await factory.pause()",
    "await factory.dispose()",
    "await bao.dispose()",
  ])
    expect(caller).toContain(operation);
  expect(caller).not.toContain("requireOwnedProjectSourceRetention");
  expect(caller).not.toContain('method: "DELETE"');
});

function controlledCycle(fidelity: "SNAPSHOT_FIDELITY_MEMORY" | "SNAPSHOT_FIDELITY_ROOTFS") {
  const f = controlledInput();
  const binding: StarterLifecycleBinding = {
    attemptID,
    projectID: f.input.ownership.projectID,
    workspaceID: crypto.randomUUID(),
    actorUID: crypto.randomUUID(),
    templateUID: crypto.randomUUID(),
    atespace: `fa-${attemptID.replaceAll("-", "")}`,
    actorName: `runtime-${attemptID.replaceAll("-", "")}`,
    generation: "1",
  };
  const sandboxRuntime = {
    sandboxClass: "gvisor",
    version: { schemaVersion: "v1", attributes: [{ key: "architecture", value: "amd64" }] },
  };
  const sourceContent = "owned saved source";
  const before = starterActiveObservationSchema.parse({
    ...binding,
    state: "ready",
    actor: nativeActor.parse({
      metadata: {
        uid: binding.actorUID,
        name: binding.actorName,
        atespace: binding.atespace,
        version: "2",
        createTime: "2026-11-25T00:00:00.000Z",
      },
      actorTemplate: { atespace: binding.atespace, name: "runtime" },
      status: { state: "ACTOR_STATE_RUNNING", workerAssignment: { sandboxRuntime } },
    }),
    source: {
      workspaceID: binding.workspaceID,
      actorUID: binding.actorUID,
      owner: "actor",
      writerEpoch: 3,
      generation: 1,
      writable: true,
      checkpointID: null,
    },
    inference: { agentTurns: 0, agentSessions: 0, modelOperations: 0, modelUsageEntries: 0 },
    dirtySource: {
      path: "src/db/schema.ts",
      sha256: createHash("sha256").update(sourceContent).digest("hex"),
      gitStatus: " M src/db/schema.ts",
    },
    stagedSource: { path: "staged.txt", sha256: "b".repeat(64), gitStatus: "A  staged.txt" },
    untrackedSource: {
      path: "untracked.txt",
      sha256: "c".repeat(64),
      gitStatus: "?? untracked.txt",
    },
    rootfs: {
      path: `/home/node/factory-starter-${crypto.randomUUID()}.rootfs`,
      sha256: "d".repeat(64),
      mtimeNs: "1795564800123456789",
    },
    process: {
      bootID: crypto.randomUUID(),
      pid: 123,
      instanceID: crypto.randomUUID(),
      memoryNonce: crypto.randomUUID(),
      challenge: crypto.randomUUID(),
      counter: 1,
    },
    compiler: {
      commandID: crypto.randomUUID(),
      workspaceID: binding.workspaceID,
      attemptID,
      state: "exited",
      exitCode: 0,
      stdout: "tsc --noEmit\nfail 0",
    },
    appStatus: 200,
  });
  const snapshot = nativeSnapshot.parse({
    uuid: crypto.randomUUID(),
    generation: 1,
    owner: "SNAPSHOT_OWNER_ACTOR",
    fidelity,
    actorTemplateUid: binding.templateUID,
    sandboxRuntime,
    durableSnapshot: {
      state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
      object: { snapshotUri: "s3://owned/pending" },
    },
  });
  snapshot.durableSnapshot.object.snapshotUri = `s3://owned/atespaces/${binding.atespace}/actors/${binding.actorUID}/snapshots/${snapshot.uuid}`;
  const paused = starterRetainedObservationSchema.parse(structuredClone(before));
  paused.state = "paused";
  paused.actor.status = {
    state: "ACTOR_STATE_SUSPENDED",
    snapshots: [snapshot],
    lastAssignedGeneration: 1,
  };
  const after = structuredClone(before);
  after.compiler.commandID = crypto.randomUUID();
  after.process.challenge = crypto.randomUUID();
  after.process.counter++;
  if (fidelity === "SNAPSHOT_FIDELITY_ROOTFS") {
    after.process.bootID = crypto.randomUUID();
    after.process.memoryNonce = crypto.randomUUID();
    after.process.instanceID = crypto.randomUUID();
  }
  const events: string[] = [];
  const request = async (
    phase: "memory-pause" | "memory-start" | "rootfs-pause",
    action: "start" | "pause",
  ) => {
    events.push(`request:${phase}`);
    return starterLifecycleRequest(f.input.evidenceDirectory, {
      factoryID: f.input.ownership.factoryID,
      databaseName: f.input.ownership.databaseName,
      projectID: binding.projectID,
      workspaceID: binding.workspaceID,
      phase,
      action,
    });
  };
  const view = {
    id: attemptID,
    projectId: binding.projectID,
    workspaceId: binding.workspaceID,
    state: "paused",
    native: {
      engine: "substrate" as const,
      actorUID: binding.actorUID,
      state: "ACTOR_STATE_SUSPENDED",
      coldRestart: true as const,
      portable: false as const,
      sourceHandoff: "pending" as const,
    },
  };
  const tools = {
    async pause(workspaceID: string, requestID: string) {
      const saved = JSON.parse(
        await readFile(
          join(
            f.input.evidenceDirectory,
            `lifecycle-${fidelity === "SNAPSHOT_FIDELITY_MEMORY" ? "memory" : "rootfs"}-pause.json`,
          ),
          "utf8",
        ),
      );
      expect(saved).toMatchObject({ workspaceID, requestID, action: "pause" });
      events.push("pause");
      return view;
    },
    async start(workspaceID: string, requestID: string) {
      expect(
        JSON.parse(
          await readFile(join(f.input.evidenceDirectory, "lifecycle-memory-start.json"), "utf8"),
        ),
      ).toMatchObject({ workspaceID, requestID, action: "start" });
      events.push("start");
      return { ...view, state: "ready" };
    },
    async workspace() {
      events.push("workspace");
      return { workspaceID: binding.workspaceID, runtime: view };
    },
    async currentFile(workspaceID: string, path: string) {
      expect(workspaceID).toBe(binding.workspaceID);
      expect(path).toBe("/workspace/project/src/db/schema.ts");
      events.push("current-file");
      return { content: sourceContent, version: "observed", nextOffset: null };
    },
  };
  const cycle = {
    binding,
    before,
    fidelity,
    tools,
    request,
    sourcePath: before.dirtySource.path,
    sourceContent,
    evidenceDirectory: f.input.evidenceDirectory,
    async observe() {
      events.push("observe");
      return paused;
    },
    async inspect(mode: "observe" | "restart") {
      events.push(`inspect:${mode}`);
      return after;
    },
    async ready() {
      events.push("ready");
    },
  };
  return { ...f, binding, cycle, before, paused, after, snapshot, events };
}

test.each(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"] as const)(
  "maintained cycle uses persisted public commands and the original binding: %s",
  async (fidelity) => {
    const f = controlledCycle(fidelity);
    try {
      const evidence = await starterRetainedCycle(f.cycle);
      expect(evidence.after.attemptID).toBe(f.binding.attemptID);
      expect(evidence.after.source).toEqual(f.before.source);
      expect(f.events).toEqual(
        fidelity === "SNAPSHOT_FIDELITY_MEMORY"
          ? [
              "request:memory-pause",
              "pause",
              "observe",
              "workspace",
              "request:memory-start",
              "start",
              "ready",
              "inspect:observe",
            ]
          : [
              "request:rootfs-pause",
              "pause",
              "observe",
              "workspace",
              "current-file",
              "ready",
              "inspect:restart",
            ],
      );
      expect(
        await Bun.file(
          join(
            f.cycle.evidenceDirectory,
            fidelity === "SNAPSHOT_FIDELITY_MEMORY"
              ? "native-memory-lifecycle.json"
              : "native-rootfs-lifecycle.json",
          ),
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(f.cycle.evidenceDirectory, { recursive: true, force: true });
    }
  },
);

test.each([
  "wrong-fidelity",
  "missing-metadata",
  "changed-epoch",
  "missing-staged",
  "inference",
] as const)("maintained ROOTFS qualification cannot turn %s into a native pass", async (fault) => {
  const f = controlledCycle("SNAPSHOT_FIDELITY_ROOTFS");
  if (fault === "wrong-fidelity") f.snapshot.fidelity = "SNAPSHOT_FIDELITY_MEMORY";
  if (fault === "wrong-fidelity") f.paused.actor.status.snapshots = [f.snapshot];
  if (fault === "missing-metadata")
    f.cycle.observe = async () => {
      throw Error("Source metadata unavailable");
    };
  if (fault === "changed-epoch") f.paused.source.writerEpoch++;
  if (fault === "missing-staged") f.after.stagedSource.gitStatus = "?? staged.txt";
  if (fault === "inference")
    f.cycle.inspect = async () =>
      starterActiveObservationSchema.parse({
        ...f.after,
        inference: { ...f.after.inference, modelOperations: 1 },
      });
  try {
    await expect(starterRetainedCycle(f.cycle)).rejects.toThrow();
    expect(
      await Bun.file(join(f.cycle.evidenceDirectory, "native-rootfs-lifecycle.json")).exists(),
    ).toBe(false);
    if (["wrong-fidelity", "missing-metadata", "changed-epoch"].includes(fault))
      expect(f.events).not.toContain("current-file");
    if (fault === "wrong-fidelity") {
      expect(
        await readFile(join(f.cycle.evidenceDirectory, "native-rootfs-paused.json"), "utf8"),
      ).toContain("SNAPSHOT_FIDELITY_MEMORY");
    }
  } finally {
    await rm(f.cycle.evidenceDirectory, { recursive: true, force: true });
  }
});

test("native transition observation polls without replaying Pause or touching files", async () => {
  const f = controlledCycle("SNAPSHOT_FIDELITY_MEMORY");
  let reads = 0;
  f.cycle.observe = async () => {
    reads++;
    return reads === 1 ? { ...f.paused, state: "pausing" } : f.paused;
  };
  try {
    await starterRetainedCycle(f.cycle);
    expect(reads).toBe(2);
    expect(f.events.filter((event) => event === "pause")).toHaveLength(1);
    expect(f.events).not.toContain("current-file");
  } finally {
    await rm(f.cycle.evidenceDirectory, { recursive: true, force: true });
  }
});

test("a released worker still pinned to its node is not a detached cold-start fixture", async () => {
  const f = controlledCycle("SNAPSHOT_FIDELITY_ROOTFS");
  let reads = 0;
  f.cycle.observe = async () => {
    reads++;
    return reads === 1
      ? {
          ...f.paused,
          actor: {
            ...f.paused.actor,
            status: { ...f.paused.actor.status, assignedNode: "owned-original-node" },
          },
        }
      : f.paused;
  };
  try {
    await starterRetainedCycle(f.cycle);
    expect(reads).toBe(2);
    expect(f.events.filter((event) => event === "pause")).toHaveLength(1);
  } finally {
    await rm(f.cycle.evidenceDirectory, { recursive: true, force: true });
  }
});

test("caller request receipts recover exactly and reject a foreign scope or unreadable intent", async () => {
  const f = controlledCycle("SNAPSHOT_FIDELITY_MEMORY");
  try {
    const id = await f.cycle.request("memory-pause", "pause");
    expect(await f.cycle.request("memory-pause", "pause")).toBe(id);
    const scope = {
      factoryID: f.input.ownership.factoryID,
      databaseName: f.input.ownership.databaseName,
      projectID: crypto.randomUUID(),
      workspaceID: f.binding.workspaceID,
      phase: "memory-pause" as const,
      action: "pause" as const,
    };
    await expect(starterLifecycleRequest(f.cycle.evidenceDirectory, scope)).rejects.toThrow();
    await writeFile(join(f.cycle.evidenceDirectory, "lifecycle-memory-pause.json"), "{}");
    await expect(f.cycle.request("memory-pause", "pause")).rejects.toThrow();
  } finally {
    await rm(f.cycle.evidenceDirectory, { recursive: true, force: true });
  }
});

test.each(["valid", "missing", "inference"] as const)(
  "private Source observation is real SQL plus exact GetActor, never a default epoch: %s",
  async (fault) => {
    const f = controlledCycle("SNAPSHOT_FIDELITY_MEMORY");
    const queries: string[] = [];
    let reads = 0;
    const database = {
      client: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(parts.join("?"));
        expect(values).toEqual([
          f.binding.attemptID,
          f.binding.projectID,
          f.binding.workspaceID,
          f.binding.generation,
          f.binding.actorUID,
          f.binding.atespace,
          f.binding.actorName,
          f.binding.templateUID,
        ]);
        return fault === "missing"
          ? []
          : [
              {
                ...f.before,
                actorUID: f.binding.actorUID,
                templateUID: f.binding.templateUID,
                inference: {
                  ...f.before.inference,
                  modelOperations: fault === "inference" ? 1 : 0,
                },
              },
            ];
      },
    } as unknown as StarterRuntimeJourneyInput["database"];
    const observation = readStarterRetainedObservation(
      database,
      async (method, request) => {
        reads++;
        expect(method).toBe("GetActor");
        expect(request).toEqual({
          actor: { atespace: f.binding.atespace, name: f.binding.actorName },
        });
        return f.before.actor;
      },
      f.binding,
    );
    if (fault === "valid") expect((await observation).source).toEqual(f.before.source);
    else await expect(observation).rejects.toThrow();
    expect(reads).toBe(fault === "missing" ? 0 : 1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^\s*SELECT/);
    expect(queries[0]).toContain("factory.substrate_source");
    expect(queries[0]).toContain("factory.usage_operation");
  },
);

test("the Work probe script preserves a real RAM nonce and requires loss before ROOTFS restart (local only)", async () => {
  const directory = join(".factory/test-results/starter-probe-unit", crypto.randomUUID());
  const probe = {
    id: crypto.randomUUID(),
    dirtyPath: "src/db/schema.ts",
    stagedPath: "staged.txt",
    untrackedPath: "untracked.txt",
    appURL: "",
    rootfsPath: "",
  };
  probe.rootfsPath = join(resolve(directory), `factory-starter-${probe.id}.rootfs`);
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("owned health"),
  });
  probe.appURL = `http://127.0.0.1:${app.port}/health`;
  let previousProcess: { pid: number; instanceID: string } | undefined;
  const run = async (mode: "create" | "observe" | "restart" | "dispose") => {
    const process = Bun.spawn(
      [
        "/bin/sh",
        "-ec",
        starterProbeCommand(
          {
            ...probe,
            ...(previousProcess ? { previousProcess } : {}),
          },
          mode,
        ),
      ],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        env: { PATH: globalThis.process.env["PATH"] ?? "/usr/bin:/bin" },
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  try {
    await mkdir(join(directory, "src/db"), { recursive: true });
    await writeFile(join(directory, probe.dirtyPath), "export {};\n");
    await Bun.$`git -C ${directory} init -b main`.quiet();
    await Bun.$`git -C ${directory} add -- ${probe.dirtyPath}`.quiet();
    await Bun.$`git -C ${directory} -c commit.gpgsign=false -c core.hooksPath=/dev/null -c user.name=Owned -c user.email=owned@example.invalid commit -m baseline`.quiet();
    await writeFile(join(directory, probe.dirtyPath), "export {};\n// retained dirty\n");
    await writeFile(join(directory, probe.stagedPath), "owned staged\n");
    await writeFile(join(directory, probe.untrackedPath), "owned untracked\n");
    await Bun.$`git -C ${directory} add -- ${probe.stagedPath}`.quiet();
    const created = await run("create");
    expect(created.stderr).toBe("");
    expect(created.exit).toBe(0);
    const before = JSON.parse(created.stdout);
    expect(before.dirtySource.gitStatus).toMatch(/^ M /);
    expect(before.stagedSource.gitStatus).toMatch(/^A {2}/);
    expect(before.untrackedSource.gitStatus).toMatch(/^\?\? /);
    expect(before.rootfs.path).toBe(probe.rootfsPath);
    expect(before.rootfs.mtimeNs).toMatch(/^[1-9][0-9]*$/);
    expect(before.process.bootID).toMatch(/^[a-f0-9-]{36}$/);
    const read = await run("observe");
    expect(read.exit).toBe(0);
    const continued = JSON.parse(read.stdout);
    previousProcess = { pid: continued.process.pid, instanceID: continued.process.instanceID };
    expect(continued.process.memoryNonce).toBe(before.process.memoryNonce);
    expect(continued.process.instanceID).toBe(before.process.instanceID);
    expect(continued.process.counter).toBeGreaterThan(before.process.counter);
    expect(continued.process.challenge).not.toBe(before.process.challenge);
    expect(continued.process.bootID).toBe(before.process.bootID);
    expect(continued.rootfs).toEqual(before.rootfs);
    const refused = await run("restart");
    expect(refused.exit).not.toBe(0);
    expect(refused.stderr).toContain("ROOTFS retained the old probe process");
    const args = await Bun.$`ps -p ${continued.process.pid} -o args=`.quiet().text();
    expect(args).toContain(continued.process.instanceID);
    process.kill(continued.process.pid, "SIGTERM");
    for (let tries = 0; tries < 100; tries++) {
      if ((await run("observe")).exit !== 0) break;
      await Bun.sleep(50);
    }
    const restarted = await run("restart");
    expect(restarted.exit).toBe(0);
    const after = JSON.parse(restarted.stdout);
    expect(after.process.memoryNonce).not.toBe(before.process.memoryNonce);
    expect(after.rootfs).toEqual(before.rootfs);
    // Killing a local process is not native ROOTFS restoration: the host boot
    // stays the same and cannot pass the maintained native evidence guard.
    expect(after.process.bootID).toBe(before.process.bootID);
  } finally {
    try {
      const disposed = await run("dispose");
      expect(disposed.exit).toBe(0);
      expect(JSON.parse(disposed.stdout)).toEqual({ disposed: true });
    } finally {
      app.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
