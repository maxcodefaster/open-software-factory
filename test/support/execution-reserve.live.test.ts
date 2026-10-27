import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { forgeUsername } from "../../packages/forge/src/access";
import {
  defaultReservePolicy,
  type ExecutionSlot,
} from "../../packages/runtime-domain/src/reserve";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  factoryboxWorkerIdentity,
  runFactoryboxKubernetes,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { factoryboxReserveInput } from "../../packages/runtime-kubernetes/src/reserve";
import upstream from "../../upstream.json";
import { editorFixtureNamespaces } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { removeOwnedFactoryboxFixture } from "../fixtures/factorybox-cleanup";
import { observeFactoryboxFixture } from "../fixtures/factorybox-runtime";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { runtimeAccessCookie } from "../fixtures/runtime-access";
import { ownedRuntimeRepository } from "../fixtures/runtime-repository";
import { authenticatedBootstrap, callFactoryFunction } from "../fixtures/server-functions";

test.skipIf(process.env["FACTORY_RUN_EXECUTION_RESERVE_PROOF"] !== "1")(
  "real Factory Staging produces paused Forks and recovers an assigned Fork across Factory process loss",
  async () => {
    const owner = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/execution-reserve", owner);
    const source = resolve(artifacts, "project");
    await mkdir(resolve(source, ".devcontainer"), { recursive: true });
    await mkdir(resolve(source, ".factory"));
    const progress = async (phase: string, detail: Record<string, unknown> = {}) => {
      const event = { at: new Date().toISOString(), owner, phase, ...detail };
      await appendFile(resolve(artifacts, "progress.jsonl"), `${JSON.stringify(event)}\n`, {
        mode: 0o600,
      });
      console.log(`Factory Staging proof: ${JSON.stringify(event)}`);
    };
    await progress("setup");
    await writeFile(
      resolve(source, "server.js"),
      'const nonce=require("node:crypto").randomUUID(),born=Date.now();let counter=0;setInterval(()=>counter++,25);require("node:http").createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({nonce,pid:process.pid,born,counter}));}).listen(19472,"0.0.0.0");',
    );
    await writeFile(
      resolve(source, ".factory/system.json"),
      JSON.stringify({
        version: 1,
        primaryApp: "web",
        apps: [
          { id: "web", label: "App", command: ["node", "server.js"], port: 19472, healthPath: "/" },
        ],
      }),
    );
    await writeFile(
      resolve(source, ".devcontainer/devcontainer.json"),
      JSON.stringify({
        image: upstream.node.image,
        workspaceFolder: "/workspace/project",
        workspaceMount: "source=/home/coder/project,target=/workspace/project,type=bind",
        remoteUser: "node",
        updateRemoteUserUID: false,
        overrideCommand: true,
        runArgs: ["--cap-drop=NET_RAW", "--cap-drop=SYS_PTRACE", "--cpus=1", "--memory=768m"],
      }),
    );
    for (const args of [
      ["init", "-b", "main"],
      ["add", "."],
      [
        "-c",
        "user.name=Factory",
        "-c",
        "user.email=factory@example.invalid",
        "commit",
        "-m",
        "owned Factory pool proof",
      ],
    ]) {
      const child = Bun.spawn(["git", "-C", source, ...args], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await child.exited) !== 0) throw new Error("Owned pool repository failed");
    }
    for (const [name, path] of [
      ["fixture-source.ts", "test/support/execution-reserve.live.test.ts"],
      ["pool-source.ts", "apps/factory/src/runtime/reserve-controller.ts"],
      ["runtime-source.ts", "apps/factory/src/runtime/controller.ts"],
    ] as const)
      await writeFile(resolve(artifacts, name), await readFile(path), { flag: "wx", mode: 0o400 });
    const image =
      process.env["FACTORY_RUNTIME_HOST_IMAGE"] ??
      (await readFile(".factory/runtime-host-image", "utf8")).trim();
    const images = { staging: image, verification: image };
    const profile = configuredFactoryboxRuntimeProfile();
    const postgres = await ownedPostgresServer();
    const previousPostgres = process.env["FACTORY_TEST_POSTGRES"];
    let forge: Awaited<ReturnType<typeof ownedRuntimeRepository>>;
    let host: Awaited<ReturnType<typeof factoryProcess>>;
    let disposeForge: (() => Promise<void>) | undefined;
    try {
      process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
      forge = await ownedRuntimeRepository(artifacts, owner, source);
      disposeForge = () => forge.dispose();
      host = await factoryProcess(
        { runtimeHostImage: image, forgejoToken: forge.token },
        {
          FACTORY_FORGEJO_ADMIN_TOKEN: forge.token,
          FACTORY_FORGEJO_API_URL: `${forge.origin}/api/v1/`,
          FACTORY_FORGEJO_OWNER: forge.owner,
          FACTORY_EXECUTION_RESERVE_TARGET: "2",
        },
      );
    } catch (cause) {
      const cleanup = await Promise.allSettled([disposeForge?.(), postgres.dispose()]);
      if (cleanup.some((result) => result.status === "rejected"))
        await progress("setup-cleanup-incomplete").catch(() => {});
      throw cause;
    } finally {
      if (previousPostgres === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
      else process.env["FACTORY_TEST_POSTGRES"] = previousPostgres;
    }
    const database = host.connect();
    const store = createReserveStore(defaultReservePolicy, images, profile);
    const before = await editorFixtureNamespaces();
    const projectID = crypto.randomUUID();
    const save = (name: string, value: unknown) =>
      writeFile(resolve(artifacts, name), JSON.stringify(value, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    let cookie = "";
    let passed = false;
    let preparationLock: ReturnType<typeof host.connect>["client"] | undefined;
    let slotLock: ReturnType<typeof host.connect>["client"] | undefined;
    let lockedSlot = "";
    let retiring: ReturnType<typeof createExecutionReserve> | undefined;
    const redact = (value: string) => value.replaceAll(forge.token, "<REDACTED>").slice(-4000);
    const headers = () => ({ cookie, origin: host.base, "content-type": "application/json" });
    async function slots() {
      const ids = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.execution_slot WHERE project_id=${projectID} ORDER BY created_at,id`;
      return (await Promise.all(ids.map((row) => store.get(database.client, row.id)))).filter(
        (row): row is ExecutionSlot => row !== null,
      );
    }
    async function attempts() {
      return z
        .object({ attempts: z.array(runtimeAttemptSchema) })
        .parse(
          await serverCall(
            callFactoryFunction(
              host.base,
              "getRuntimeAttempts",
              [projectID],
              headers(),
              AbortSignal.timeout(15_000),
            ),
          ),
        ).attempts;
    }
    async function ready(attemptID: string) {
      return eventually(
        async () => {
          const found = (await attempts()).find((attempt) => attempt.id === attemptID);
          if (found && ["failed", "cleanup-failed"].includes(found.state))
            throw new Error(`Owned Staging failed: ${redact(found.failure ?? found.state)}`);
          return found;
        },
        (value) => value?.state === "ready",
        "Original admitted Staging did not become ready",
        420_000,
      );
    }
    async function stop(attemptID: string) {
      await serverCall(
        callFactoryFunction(
          host.base,
          "stopRuntimeAttempt",
          [attemptID],
          headers(),
          AbortSignal.timeout(30_000),
        ),
      );
      await eventually(
        () => database.client<Array<{ state: string }>>`
        SELECT state FROM factory.runtime_attempt WHERE id=${attemptID}`,
        (rows) => rows[0]?.state === "stopped",
        "Owned Staging Stop remains unsettled",
        120_000,
      );
    }
    async function app(attemptID: string) {
      const access = await runtimeAccessCookie(host.base, cookie, attemptID, "app");
      const response = await fetch(`${host.base}/runtime/${attemptID}/app/`, {
        headers: { cookie: access },
      });
      expect(response.status).toBe(200);
      return z
        .object({ nonce: z.uuid(), pid: z.number(), born: z.number(), counter: z.number() })
        .parse(await response.json());
    }
    try {
      // Image prebuild has its own live lane. Hold its admission in this owned
      // database so a restart cannot add a third running Sandbox while this
      // proof exercises Staging plus its clean template.
      preparationLock = database.coordination();
      await preparationLock`SELECT pg_advisory_lock(hashtext('project-image-preparation'))`;
      let server = await host.start();
      cookie = await host.signIn();
      const session = z
        .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
        .parse(await authenticatedBootstrap(host.base, { cookie }));
      await forge.execute([
        "admin",
        "user",
        "create",
        "--username",
        forgeUsername(session.session.user.id),
        "--random-password",
        "--email",
        `${owner}@pool-proof.invalid`,
        "--must-change-password=false",
      ]);
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
        VALUES(${projectID},${`pool-${owner}`},'Owned Factory Staging',${forge.repositoryURL},'main',
          '.devcontainer/devcontainer.json',${session.session.user.id},'gulf-of-marseille')`;
      await save("intent.json", {
        owner,
        factoryID: host.id,
        projectID,
        repository: forge.repository,
        postgres: postgres.identity,
        profile,
        image,
        liveStagingRequired: true,
      });
      await progress("staging-requested", { projectID });

      // Discard the first client reply after intent is committed. Observe the
      // same admitted Attempt; never commission a second ensureStaging call.
      const response = new AbortController();
      const initialRequest = serverCall(
        callFactoryFunction(host.base, "ensureStaging", [projectID], headers(), response.signal),
      );
      void initialRequest.catch(() => {});
      const [initial] = await eventually(
        () => database.client<Array<{ id: string }>>`
        SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
        (rows) => rows.length === 1,
        "Initial Staging intent missing",
        30_000,
      );
      if (!initial) throw new Error("Initial Staging identity missing");
      response.abort();
      await initialRequest.catch(() => {});
      const firstReady = await ready(initial.id);
      if (!firstReady) throw new Error("Live first Staging missing");
      const firstApp = await app(initial.id);
      await progress("staging-ready", { attemptID: initial.id });
      const initialPool = await eventually(
        slots,
        (rows) => rows.filter((row) => row.templateID && row.state === "ready").length === 2,
        "Real healthy Staging never produced two paused Forks",
        420_000,
      );
      const poolReadyAt = Date.now();
      const template = initialPool.find((row) => !row.templateID && row.state === "ready");
      const unused = initialPool.filter((row) => row.templateID && row.state === "ready");
      const selected = unused[0];
      if (!template || !selected?.podUID)
        throw new Error("Owned ready pool has no immutable worker");
      expect(template.stagingAttemptID).toBe(initial.id);
      expect(template.revision).toBe(forge.commit);
      expect(new Set(initialPool.map((row) => row.workerID)).size).toBe(1);
      for (const slot of unused) {
        const state = await observeFactoryboxFixture({
          input: factoryboxReserveInput(slot),
          identity: factoryboxWorkerIdentity.parse(slot.factoryboxIdentity),
        });
        expect(state.record.phase).toBe("paused");
        expect(state.record["pause"]).toMatchObject({
          snapshot_id: slot.id.replaceAll("-", ""),
          after: { anon: 0 },
          snapshot: { resident_bytes_after: 0 },
        });
      }
      await save("initial-live-staging.json", {
        attemptID: initial.id,
        app: firstApp,
        templateID: template.id,
        unusedSlotIDs: unused.map((row) => row.id),
        poolReadyAt,
      });
      await progress("pool-ready", { templateID: template.id, unusedSlots: unused.length });

      // Stop only this owned first Staging before consuming the pool. This
      // keeps the native fixture below two running Sandboxes even while the
      // replacement and its background template are prepared concurrently.
      await stop(initial.id);
      await progress("original-staging-stopped");
      slotLock = database.coordination();
      lockedSlot = selected.id;
      await slotLock`SELECT pg_advisory_lock(hashtext(${`execution-slot:${lockedSlot}`}))`;
      const replacementRequest = serverCall(
        callFactoryFunction(
          host.base,
          "ensureStaging",
          [projectID],
          headers(),
          AbortSignal.timeout(420_000),
        ),
      );
      void replacementRequest.catch(() => {});
      const [assigned] = await eventually(
        () => database.client<Array<{ id: string; state: string; resumed: boolean }>>`
        SELECT attempt.id,attempt.state,slot.factorybox_resume_attempted AS resumed
        FROM factory.execution_slot slot JOIN factory.runtime_attempt attempt ON attempt.id=slot.assigned_attempt_id
        WHERE slot.id=${selected.id}`,
        (rows) => rows.length === 1,
        "Factory did not assign the owned Fork",
        30_000,
      );
      if (!assigned) throw new Error("Missing assigned Runtime Attempt");
      expect(assigned.state).toBe("create-intended");
      expect(assigned.resumed).toBe(false);
      await progress("fork-assigned-before-resume", {
        slotID: selected.id,
        attemptID: assigned.id,
      });
      await host.kill(server);
      await replacementRequest.catch(() => {});
      await slotLock`SELECT pg_advisory_unlock(hashtext(${`execution-slot:${lockedSlot}`}))`;
      await slotLock.end({ timeout: 1 });
      slotLock = undefined;
      lockedSlot = "";
      const resumedAt = performance.now();
      server = await host.start();
      await ready(assigned.id);
      const replacementApp = await app(assigned.id);
      const resumedToUsefulMS = Math.round(performance.now() - resumedAt);
      await progress("fork-ready-after-factory-restart", { resumedToUsefulMS });
      expect(replacementApp.born).toBeLessThan(poolReadyAt);
      expect(replacementApp.nonce).not.toBe(firstApp.nonce);
      const retained = await store.assigned(database.client, assigned.id);
      expect(retained).toMatchObject({
        id: selected.id,
        state: "assigned",
        assignedAttemptID: assigned.id,
        podUID: selected.podUID,
        claimUID: selected.claimUID,
        templateID: template.id,
      });
      const [execution] = await database.client<Array<{ sandboxID: string; prepared: unknown }>>`
        SELECT runtime.request->>'sandboxID' AS "sandboxID",operation.observation AS prepared
        FROM factory.factorybox_runtime runtime JOIN factory.factorybox_lifecycle_operation operation
          ON operation.runtime_attempt_id=runtime.runtime_attempt_id AND operation.action='prepare'
        WHERE runtime.runtime_attempt_id=${assigned.id}`;
      expect(execution?.sandboxID).toBe(`runtime-${selected.id.replaceAll("-", "")}`);
      expect(execution?.prepared).toMatchObject({ kind: "adopted-fork" });
      const [configuration] = await database.client<Array<{ declaration: unknown }>>`
        SELECT declaration FROM factory.staging_configuration WHERE runtime_attempt_id=${assigned.id}`;
      expect(configuration?.declaration).toMatchObject({
        devcontainerPath: ".devcontainer/devcontainer.json",
        processes: [{ name: "app", command: ["node", "server.js"] }],
      });
      const refilled = await eventually(
        slots,
        (rows) =>
          rows.filter(
            (row) =>
              row.templateID && row.state === "ready" && row.stagingAttemptID === assigned.id,
          ).length === 2,
        "Replacement healthy Staging did not refresh its two paused Forks",
        420_000,
      );
      expect(refilled.find((row) => row.id === selected.id)?.state).toBe("assigned");
      expect(
        await database.client`SELECT id FROM factory.development_workspace WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
      await progress("pool-refilled", { unusedSlots: 2 });
      await save("result.json", {
        passed: true,
        actualFactoryStagingProved: true,
        actualStagingReference: initial.id,
        replacementAttemptID: assigned.id,
        selectedSlotID: selected.id,
        firstApp,
        replacementApp,
        resumedToUsefulMS,
        preparedBeforeAssignment: true,
        factoryCrashBeforeActivation: true,
        discardedInitialReplyObservedWithoutCreateReplay: true,
        oneWorker: true,
        refreshedUnusedPausedForks: 2,
        noInference: true,
      });
      await progress("cleanup");
      await stop(assigned.id);
      await host.shutdown();
      retiring = createExecutionReserve(database, images, {
        ...defaultReservePolicy,
        readyTarget: 0,
      });
      await retiring.start();
      await eventually(
        slots,
        (rows) => rows.every((row) => row.state === "deleted"),
        "Owned pool retirement remains unsettled",
        420_000,
      );
      await retiring.close();
      retiring = undefined;
      await removeOwnedFactoryboxFixture(host, artifacts);
      const after = await editorFixtureNamespaces();
      for (const previous of before)
        expect(after.find((row) => row.name === previous.name)?.uid).toBe(previous.uid);
      await save("cleanup.json", {
        ownedWorkerRemoved: true,
        allPrivateBackingRetired: true,
        unrelatedNamespacesUnchanged: true,
      });
      await progress("cleanup-complete");
      passed = true;
    } catch (cause) {
      await progress("failed", {
        error: redact(cause instanceof Error ? cause.message : "Factory Staging proof failed"),
      }).catch(() => {});
      await save("failure.json", {
        error: redact(cause instanceof Error ? cause.message : "Factory Staging proof failed"),
      }).catch(() => {});
      throw cause;
    } finally {
      if (slotLock) {
        if (lockedSlot)
          await slotLock`SELECT pg_advisory_unlock(hashtext(${`execution-slot:${lockedSlot}`}))`;
        await slotLock.end({ timeout: 1 });
      }
      await retiring?.close();
      await host.shutdown();
      if (preparationLock) {
        await preparationLock`SELECT pg_advisory_unlock(hashtext('project-image-preparation'))`;
        await preparationLock.end({ timeout: 1 });
      }
      if (passed) {
        await database.client.end({ timeout: 2 });
        await host.dispose();
        await forge.dispose();
        await postgres.dispose();
      } else {
        const [worker] = await database.client<
          Array<{ id: string; namespaceUID: string | null; podUID: string | null }>
        >`
          SELECT id,namespace_uid AS "namespaceUID",pod_uid AS "podUID" FROM factory.factorybox_worker WHERE singleton`;
        await save("retained-failure.json", {
          owner,
          factoryID: host.id,
          databaseURL: host.databaseURL,
          postgres: postgres.identity,
          forgeContainer: forge.container,
          worker,
          slots: await slots(),
        }).catch(() => {});
        if (worker?.podUID && worker.namespaceUID) {
          const namespace = `factory-box-${worker.id.replaceAll("-", "")}`;
          const current = await runFactoryboxKubernetes([
            "get",
            "pod",
            "worker",
            "-n",
            namespace,
            "-o",
            "json",
          ]);
          if (current.exitCode === 0 && JSON.parse(current.stdout).metadata?.uid === worker.podUID)
            await save(
              "worker-fencing.json",
              await runFactoryboxKubernetes(
                ["delete", "--raw", `/api/v1/namespaces/${namespace}/pods/worker`, "-f", "-"],
                JSON.stringify({
                  apiVersion: "v1",
                  kind: "DeleteOptions",
                  preconditions: { uid: worker.podUID },
                  gracePeriodSeconds: 45,
                }),
                { timeoutMS: 60_000, outputBytes: 1024 ** 2 },
              ),
            );
        }
        await database.client.end({ timeout: 2 });
      }
    }
  },
  // Cold real Staging, pool preparation, process loss and refreshed Staging
  // are separate native phases. Each retains its 420-second operation bound.
  1_500_000,
);
