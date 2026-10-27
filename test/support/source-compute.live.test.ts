import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  runtimeAttemptSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { forgeUsername } from "../../packages/forge/src/access";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  workspaceSourceCapability,
  workspaceSourceIdentity,
} from "../../packages/workspace-domain/src/source";
import { starterImagesSchema } from "../../scripts/factory/starter-images";
import upstream from "../../upstream.json";
import { automaticIDE, stopAutomaticIDE } from "../fixtures/automatic-ide";
import { editorFixtureKubectl, editorFixtureNamespaces } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { removeOwnedFactoryboxFixture } from "../fixtures/factorybox-cleanup";
import {
  factoryboxFixtureCommand,
  observeFactoryboxFixture,
  readFactoryboxFixtureTarget,
  requireFixtureWorkerPod,
} from "../fixtures/factorybox-runtime";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";
import { produceOwnedProjectPrebuild, projectPrebuildRecipe } from "../fixtures/project-prebuild";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { runtimeCacheObservation } from "../fixtures/runtime-cache-observation";
import { authenticatedBootstrap, callFactoryFunction } from "../fixtures/server-functions";
import { slice20StartupTargetFailures } from "./runtime-startup";

const prebuildEnabled = process.env["FACTORY_RUN_PROJECT_PREBUILD_PROOF"] === "1";
const ideEnabled = process.env["FACTORY_RUN_AUTOMATIC_IDE_PROOF"] === "1";
const idleEnabled = process.env["FACTORY_RUN_IDLE_COMPUTE_PROOF"] === "1" || ideEnabled;
const performanceEnabled = process.env["FACTORY_CHECK_SLICE20_STARTUP_TARGETS"] === "1";
const enabled =
  process.env["FACTORY_RUN_SOURCE_COMPUTE_PROOF"] === "1" || prebuildEnabled || idleEnabled;
const sourceFile = z.object({ content: z.string(), version: z.string() });

test.skipIf(!enabled)(
  ideEnabled
    ? "the real IDE automatically starts compute and resumes its same paused Factorybox Sandbox"
    : "execution uses initialized canonical source and retains human/runtime edits through Stop and restart",
  async () => {
    if (performanceEnabled && idleEnabled)
      throw new Error(
        "Slice 20 startup targets require the explicit Stop/restart proof, not idle mode",
      );
    const image = async (name: string) =>
      (
        (name === "workspace-files"
          ? process.env["FACTORY_WORKSPACE_FILES_IMAGE"]
          : name === "runtime-host"
            ? process.env["FACTORY_RUNTIME_HOST_IMAGE"]
            : name === "developer-ide"
              ? process.env["FACTORY_DEVELOPER_IDE_IMAGE"]
              : undefined) ?? (await readFile(`.factory/${name}-image`, "utf8"))
      ).trim();
    const proofID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/source-compute", proofID);
    await mkdir(artifacts, { recursive: true });
    const recipe = prebuildEnabled ? await projectPrebuildRecipe(artifacts) : null;
    const localImages = starterImagesSchema.parse(
      JSON.parse(await readFile(".factory/starter-images.json", "utf8")),
    );
    const projectImages = recipe
      ? [upstream.nodeDevelopment.image, upstream.node.image]
      : [localImages.development, localImages.support];
    const repositoryDirectory = recipe?.directory ?? resolve(".factory/runtime-fixture-repository");
    const sharedPostgres = process.env["FACTORY_TEST_POSTGRES"]
      ? z.object({ owner: z.uuid() }).parse(JSON.parse(process.env["FACTORY_TEST_POSTGRES"]))
      : null;
    const forgeHost = await ownedMonitoringForge(
      artifacts,
      proofID,
      sharedPostgres ? `factory-test-postgres-${sharedPostgres.owner}` : undefined,
    );
    const repository = { owner: forgeHost.owner, name: `source-compute-${proofID.slice(0, 12)}` };
    const forge = createForgejoClient({
      apiURL: `${forgeHost.origin}/api/v1/`,
      token: forgeHost.token,
    });
    const fixture = await factoryProcess(
      {
        runtimeHostImage: await image("runtime-host"),
        forgejoToken: forgeHost.token,
      },
      {
        FACTORY_FORGEJO_ADMIN_TOKEN: forgeHost.token,
        FACTORY_FORGEJO_API_URL: `${forgeHost.origin}/api/v1/`,
        FACTORY_FORGEJO_OWNER: forgeHost.owner,
        FACTORY_WORKSPACE_FILES_IMAGE: await image("workspace-files"),
        FACTORY_DEVELOPER_IDE_IMAGE: await image("developer-ide"),
        ...(idleEnabled ? { FACTORY_EXECUTION_IDLE_MINUTES: "1" } : {}),
      },
    ).catch(async (cause) => {
      await forgeHost.dispose();
      throw cause;
    });
    const database = fixture.connect();
    const before = await editorFixtureNamespaces();
    let cookie = "";
    let workspaceID = "";
    let namespace = "";
    let namespaceUID = "";
    let cleaned = false;
    let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
    let ide: Awaited<ReturnType<typeof automaticIDE>> | undefined;
    let editorUserID = "";
    const api = (path: string, body?: unknown) =>
      fetch(`${fixture.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
    const readSource = async (path: string) =>
      sourceFile.parse(
        await (await api(`/api/workspaces/${workspaceID}/source/read`, { path })).json(),
      );
    const getAttempt = async (attemptID: string) => {
      const { attempts } = z
        .object({ attempts: z.array(runtimeAttemptSchema) })
        .parse(
          await serverCall(
            callFactoryFunction(
              fixture.base,
              "getRuntimeAttempts",
              [projectID],
              { cookie, origin: fixture.base, "content-type": "application/json" },
              AbortSignal.timeout(180_000),
            ),
          ),
        );
      const current = attempts.find((attempt) => attempt.id === attemptID);
      if (!current) throw new Error("Owned Runtime Attempt is missing");
      return current;
    };
    const ready = async (attemptID: string) =>
      eventually(
        async () => {
          const current = await getAttempt(attemptID);
          if (["failed", "cleanup-failed", "stopped"].includes(current.state))
            throw new Error(
              `Owned compute became ${current.state}: ${current.failure ?? "no detail"}`,
            );
          return current;
        },
        (current) => current.state === "ready",
        "Owned compute was not ready",
        300_000,
      );
    const stopCompute = async (attemptID: string) => {
      expect(
        (
          await callFactoryFunction(
            fixture.base,
            "stopRuntimeAttempt",
            [attemptID],
            { cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          )
        ).ok,
      ).toBe(true);
      await eventually(
        () => getAttempt(attemptID),
        (current) => current.state === "stopped",
        "Owned compute Stop incomplete",
        120_000,
      );
    };
    try {
      const server = await fixture.start();
      cookie = await fixture.signIn();
      const { session } = z
        .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
        .parse(await authenticatedBootstrap(fixture.base, { cookie }));
      await forgeHost.execute([
        "admin",
        "user",
        "create",
        "--username",
        forgeUsername(session.user.id),
        "--random-password",
        "--email",
        `${proofID}@source-compute.invalid`,
        "--must-change-password=false",
      ]);
      await forge.createSetupRepository({ repository, setupID: proofID });
      const tracked = Bun.spawn(["git", "ls-files"], {
        cwd: repositoryDirectory,
        stdout: "pipe",
        stderr: "ignore",
      });
      const paths = (await new Response(tracked.stdout).text()).trim().split("\n");
      if ((await tracked.exited) !== 0 || !paths.includes(".devcontainer/devcontainer.json"))
        throw new Error("Owned source/compute fixture repository is incomplete");
      await forge.createSetupFiles({
        repository,
        setupID: proofID,
        branch: "main",
        files: await Promise.all(
          paths.map(async (path) => ({
            path,
            content: await readFile(resolve(repositoryDirectory, path), "utf8"),
          })),
        ),
      });
      const sourceCommit = (await forge.getDefaultBranch(repository)).headSha;
      const repositoryURL = `${forgeHost.origin}/${repository.owner}/${repository.name}.git`;
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({
          projectID,
          proofID,
          repository,
          sourceCommit,
          factoryID: fixture.id,
          factoryOrigin: fixture.base,
          forgeContainer: forgeHost.container,
          forgeOrigin: forgeHost.origin,
        }),
      );
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`source-compute-${proofID}`},'Canonical compute proof',${repositoryURL},'main','.devcontainer/devcontainer.json',${session.user.id})`;
      const source = sourceWorkspaceViewSchema.parse(
        await serverCall(
          callFactoryFunction(fixture.base, "ensurePersonalSource", [projectID], {
            cookie: cookie,
          }),
        ),
      );
      workspaceID = source.workspaceID;
      await eventually(
        async () => {
          const current = sourceWorkspaceViewSchema.parse(
            await serverCall(
              callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
                cookie: cookie,
              }),
            ),
          );
          if (current.state === "failed")
            throw new Error(current.failure ?? "Owned canonical Source preparation failed");
          return current;
        },
        (current) => current.state === "ready",
        "Canonical source was not ready",
        // Cold PVC provisioning and image startup use the native preparation
        // window. Terminal Source failures still fail immediately above.
        420_000,
      );
      const [placement] = await database.client<
        Array<{
          namespace: string;
          namespaceUID: string;
          claimUID: string;
          node: string;
          podUID: string;
        }>
      >`SELECT workspace.kubernetes_namespace AS namespace,source.namespace_uid AS "namespaceUID",source.claim_uid AS "claimUID",source.storage_node AS node,source.pod_uid AS "podUID" FROM factory.development_workspace workspace JOIN factory.workspace_source source ON source.workspace_id=workspace.id WHERE workspace.id=${workspaceID}`;
      if (!placement) throw new Error("Canonical source placement missing");
      namespace = placement.namespace;
      namespaceUID = placement.namespaceUID;
      await writeFile(
        resolve(artifacts, "source-intent.json"),
        JSON.stringify({ workspaceID, ...placement }),
      );
      const original = await readSource("src/version.txt");
      const human = `human-before-compute-${proofID}\n`;
      expect(
        (
          await api(`/api/workspaces/${workspaceID}/source/write`, {
            path: "src/version.txt",
            version: original.version,
            content: Buffer.from(human).toString("base64"),
          })
        ).ok,
      ).toBe(true);
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      const started = performance.now();
      const initialStartedAt = new Date().toISOString();
      const attempt = ideEnabled
        ? await (async () => {
            editorUserID = session.user.id;
            ide = await automaticIDE({
              factory: fixture,
              projectID,
              workspaceID,
              userID: session.user.id,
              cookie,
              artifacts,
            });
            const created = await eventually(
              async () =>
                (
                  await database.client<Array<{ id: string }>>`
                    SELECT id FROM factory.runtime_attempt WHERE workspace_id=${workspaceID}`
                )[0],
              (current) => Boolean(current),
              "Opening the owned IDE did not automatically admit compute",
              30_000,
            );
            if (!created) throw new Error("Owned IDE did not admit its exact Workspace");
            return getAttempt(created.id);
          })()
        : runtimeAttemptSchema.parse(
            await serverCall(
              callFactoryFunction(
                fixture.base,
                "startPersonalWorkspace",
                [projectID],
                { cookie, origin: fixture.base, "content-type": "application/json" },
                AbortSignal.timeout(180_000),
              ),
            ),
          );
      await ready(attempt.id);
      const readyMS = Math.round(performance.now() - started);
      if (ide) {
        await ide.terminal("start");
        await ide.closeTerminals();
      }
      terminal = await ownedRuntimeTerminal(fixture.base, cookie, attempt.id);
      const connectedTerminalMS = Math.round(performance.now() - started);
      expect(await terminal.evaluate<string>("return process.cwd()")).toBe("/workspace/project");
      const executableTerminalMS = Math.round(performance.now() - started);
      const initialTarget = await readFactoryboxFixtureTarget(database, attempt.id);
      const pod = requireFixtureWorkerPod(
        JSON.parse(
          await editorFixtureKubectl(["get", "pod", "worker", "-n", namespace, "-o", "json"]),
        ),
        initialTarget,
      );
      expect(pod.spec.nodeName).toBe(placement.node);
      expect(pod.spec.nodeSelector).toEqual({
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": initialTarget.input.profile.architecture,
        "kubernetes.io/hostname": placement.node,
      });
      expect(
        await terminal.evaluate<boolean>('return require("fs").existsSync("/opt/factory/theia")'),
      ).toBe(false);
      expect(
        await terminal.evaluate<boolean>(
          'return require("fs").existsSync("/opt/factory/opencode")',
        ),
      ).toBe(false);
      expect(
        await terminal.evaluate<boolean>(
          'return require("fs").existsSync("/opt/factory/forgejo-runner")',
        ),
      ).toBe(false);
      const [artifactsIntent] = await database.client<
        Array<{ role: string; image: string; browser: string | null }>
      >`
        SELECT role,runtime_host_image AS image,browser_tools_image AS browser FROM factory.runtime_artifact_intent
        WHERE runtime_attempt_id=${attempt.id}`;
      expect(artifactsIntent).toEqual({
        role: "development",
        image: await image("runtime-host"),
        browser: null,
      });
      const initialCaches = await runtimeCacheObservation({
        target: initialTarget,
        startedAt: initialStartedAt,
        projectImages,
      });
      expect(initialCaches.kubelet.present).toBe(true);
      expect(initialCaches.kubelet.imageID).toContain("sha256:");
      expect(initialCaches.factoryboxBase.reference).toBe(await image("runtime-host"));
      for (const cached of initialCaches.privateDocker.project)
        expect(
          cached.digests.some((digest) =>
            digest.endsWith(cached.reference.slice(cached.reference.lastIndexOf("@"))),
          ),
        ).toBe(true);
      expect(initialCaches.phases.some((phase) => phase.phase === "project-images")).toBe(true);
      await writeFile(resolve(artifacts, "initial-caches.json"), JSON.stringify(initialCaches));
      if (recipe) {
        const prebuilt = await produceOwnedProjectPrebuild({
          target: initialTarget,
          projectID,
          commit: sourceCommit,
        });
        expect(prebuilt.seed).toEqual({
          feature: "exact committed Feature\n",
          dependency: "exact locked dependency",
        });
        expect(
          Buffer.from((await readSource("src/version.txt")).content, "base64").toString(),
        ).toBe(human);
        const compose = await readSource(".devcontainer/compose.yaml");
        const content = Buffer.from(compose.content, "base64")
          .toString()
          .replace(upstream.nodeDevelopment.image, prebuilt.image);
        expect(
          (
            await api(`/api/workspaces/${workspaceID}/source/write`, {
              path: ".devcontainer/compose.yaml",
              version: compose.version,
              content: Buffer.from(content).toString("base64"),
            })
          ).ok,
        ).toBe(true);
        await writeFile(resolve(artifacts, "project-prebuild.json"), JSON.stringify(prebuilt));
      }
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync("src/version.txt","utf8")',
        ),
      ).toBe(human);
      const runtimeText = `runtime-written-${proofID}\n`;
      await terminal.evaluate(
        `require("fs").writeFileSync("runtime-human.txt", ${JSON.stringify(runtimeText)}); return true;`,
      );
      expect(
        Buffer.from((await readSource("runtime-human.txt")).content, "base64").toString(),
      ).toBe(runtimeText);
      if (idleEnabled) {
        const ramServer =
          'const nonce=require("node:crypto").randomUUID();let counter=0;setInterval(()=>counter++,100);require("node:http").createServer((req,res)=>{res.end(JSON.stringify({nonce,pid:process.pid,counter}));}).listen(19471,"127.0.0.1");';
        await factoryboxFixtureCommand(initialTarget, [
          "node",
          "-e",
          `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(ramServer)}],{detached:true,stdio:"ignore"});child.unref();`,
        ]);
        const ramState = async () =>
          z
            .object({ nonce: z.uuid(), pid: z.number().int().positive(), counter: z.number() })
            .parse(
              JSON.parse(
                await factoryboxFixtureCommand(initialTarget, [
                  "node",
                  "-e",
                  'const req=require("node:http").get("http://127.0.0.1:19471",res=>res.pipe(process.stdout));req.setTimeout(5000,()=>req.destroy(new Error("actor timeout")));req.on("error",()=>process.exit(1));',
                ]),
              ),
            );
        const beforePause = await eventually(
          () => ramState().catch(() => null),
          (value) => value !== null,
          "Owned RAM actor did not start",
        );
        if (!beforePause) throw new Error("Owned RAM actor is missing");
        const appCookie = await runtimeAccessCookie(fixture.base, cookie, attempt.id, "app");
        console.info("Idle proof: real source/PTY writes pass; observing detached retained shell");
        const runtimeCookie = terminal.runtimeCookie;
        terminal.close();
        terminal = undefined;
        const detachedAt = performance.now();
        await eventually(
          async () => {
            expect((await getAttempt(attempt.id)).state).toBe("ready");
            await Bun.sleep(1000);
            return performance.now() - detachedAt;
          },
          (elapsed) => elapsed >= 65_000,
          "Detached retained PTY observation did not reach the idle deadline",
          75_000,
        );
        terminal = await ownedRuntimeTerminal(fixture.base, cookie, attempt.id);
        console.info(
          "Idle proof: compute retained beyond idle deadline; terminal attachment confirmed",
        );
        expect(
          await terminal.evaluate<string>(
            'return require("fs").readFileSync("runtime-human.txt","utf8")',
          ),
        ).toBe(runtimeText);
        const closedAt = performance.now();
        const detachedPTYRetainedMS = Math.round(closedAt - detachedAt);
        const closed = await fetch(
          `${fixture.base}/runtime/${attempt.id}/ide/__factory/terminals/owned-browser-proof`,
          {
            method: "DELETE",
            headers: { cookie: runtimeCookie, origin: fixture.base },
            signal: AbortSignal.timeout(30_000),
          },
        );
        expect(closed.ok).toBe(true);
        console.info("Idle proof: last PTY closed; waiting for automatic Factorybox Pause");
        terminal.close();
        terminal = undefined;
        await eventually(
          async () => {
            await Bun.sleep(1000);
            return getAttempt(attempt.id);
          },
          (current) => current.state === "paused",
          "Idle compute did not Pause after the last retained PTY closed",
          120_000,
        );
        const idlePauseMS = Math.round(performance.now() - closedAt);
        const paused = await observeFactoryboxFixture(initialTarget);
        expect(paused.record.phase).toBe("paused");
        expect(paused.record["pause"]).toMatchObject({
          after: { anon: 0 },
          snapshot: { resident_bytes_after: 0 },
        });
        expect(
          Buffer.from((await readSource("runtime-human.txt")).content, "base64").toString(),
        ).toBe(runtimeText);
        const afterIdle = await readSource("src/version.txt");
        expect(
          (
            await api(`/api/workspaces/${workspaceID}/source/write`, {
              path: "src/version.txt",
              version: afterIdle.version,
              content: Buffer.from(`editable-after-idle-${proofID}\n`).toString("base64"),
            })
          ).ok,
        ).toBe(true);
        const [retainedSource] = await database.client`
          SELECT namespace_uid AS "namespaceUID",claim_uid AS "claimUID",pod_uid AS "podUID"
          FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
        expect(retainedSource).toEqual({
          namespaceUID,
          claimUID: placement.claimUID,
          podUID: placement.podUID,
        });
        const healthWhilePaused = await fetch(`${fixture.base}/runtime/${attempt.id}/app/health`, {
          headers: { cookie: appCookie },
          signal: AbortSignal.timeout(15_000),
        });
        expect(healthWhilePaused.ok).toBe(false);
        expect((await getAttempt(attempt.id)).state).toBe("paused");
        const resumedAt = performance.now();
        if (ide) await ide.terminal("resume");
        // Merely opening the App must wake the original Attempt. No lifecycle
        // button, explicit start command or replacement Sandbox is involved.
        await eventually(
          async () =>
            fetch(`${fixture.base}/runtime/${attempt.id}/app/health`, {
              headers: { cookie: appCookie, "sec-fetch-mode": "navigate" },
              signal: AbortSignal.timeout(90_000),
            }),
          (response) => response.ok,
          "App access did not automatically Resume its paused Sandbox",
          120_000,
        );
        await ready(attempt.id);
        const afterResume = await ramState();
        expect(afterResume.nonce).toBe(beforePause.nonce);
        expect(afterResume.pid).toBe(beforePause.pid);
        expect(afterResume.counter).toBeGreaterThan(beforePause.counter);
        expect(await readFactoryboxFixtureTarget(database, attempt.id)).toEqual(initialTarget);
        expect(
          (
            await database.client<Array<{ id: string }>>`
              SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`
          ).map((row) => row.id),
        ).toEqual([attempt.id]);
        expect(
          await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
        ).toHaveLength(0);
        await writeFile(
          resolve(artifacts, "idle-result.json"),
          JSON.stringify({
            readyMS,
            connectedTerminalMS,
            executableTerminalMS,
            idleMinutes: 1,
            detachedPTYRetainedMS,
            idlePauseMS,
            ...(ide
              ? {
                  automaticIDEResumeMS: Math.round(performance.now() - resumedAt),
                  automaticIDESelectionMS: ide.selectedMS,
                  noStartButtonOrCentralStartCommand: true,
                }
              : { automaticAppResumeMS: Math.round(performance.now() - resumedAt) }),
            sameRAMActor: { beforePause, afterResume },
            pausedAnonymousAndSnapshotResidencyZero: true,
            exactAttempt: attempt.id,
            sourceIdentityRetained: true,
            sourceEditableAfterIdle: true,
            noInference: true,
            declaredResources: pod.spec.containers.map((container) => container.resources),
          }),
        );
        return;
      }
      terminal.close();
      terminal = undefined;
      await stopCompute(attempt.id);
      expect(
        (
          await callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
            cookie: cookie,
          })
        ).ok,
      ).toBe(true);
      const afterStop = await readSource("src/version.txt");
      const editedStopped = `human-while-stopped-${proofID}\n`;
      expect(
        (
          await api(`/api/workspaces/${workspaceID}/source/write`, {
            path: "src/version.txt",
            version: afterStop.version,
            content: Buffer.from(editedStopped).toString("base64"),
          })
        ).ok,
      ).toBe(true);
      const restarted = performance.now();
      const retainedStartedAt = new Date().toISOString();
      const second = runtimeAttemptSchema.parse(
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "startPersonalWorkspace",
            [projectID],
            { cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          ),
        ),
      );
      expect(second.id).not.toBe(attempt.id);
      await ready(second.id);
      const restartedReadyMS = Math.round(performance.now() - restarted);
      terminal = await ownedRuntimeTerminal(fixture.base, cookie, second.id);
      const restartedConnectedMS = Math.round(performance.now() - restarted);
      expect(await terminal.evaluate<string>("return process.cwd()")).toBe("/workspace/project");
      const restartedTerminalMS = Math.round(performance.now() - restarted);
      if (recipe) {
        expect(
          await terminal.evaluate<string>(
            'return require("./prebuilt-dependency/node_modules/proof-dependency")',
          ),
        ).toBe("exact locked dependency");
        expect(
          await terminal.evaluate<string>(
            'return require("fs").readFileSync("prebuild-hook.txt","utf8")',
          ),
        ).toBe("required hook ran\n");
        expect(
          await terminal.evaluate<boolean>(
            `const fs=require("fs");fs.writeFileSync("prebuilt-dependency/manual.txt","human install data");fs.writeFileSync("prebuilt-dependency/node_modules/proof-dependency/index.js",${JSON.stringify('module.exports="owner writable dependency";\n')});return true;`,
          ),
        ).toBe(true);
      }
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync("src/version.txt","utf8")',
        ),
      ).toBe(editedStopped);
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync("runtime-human.txt","utf8")',
        ),
      ).toBe(runtimeText);
      const [retained] = await database.client<
        Array<{ namespaceUID: string; claimUID: string; podUID: string }>
      >`SELECT namespace_uid AS "namespaceUID",claim_uid AS "claimUID",pod_uid AS "podUID" FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
      expect(retained).toEqual({
        namespaceUID,
        claimUID: placement.claimUID,
        podUID: placement.podUID,
      });
      const computeIdentity = async () => {
        const [identity] = await database.client<
          Array<{ podUID: string; namespaceUID: string }>
        >`SELECT kubernetes_uid AS "podUID",kubernetes_namespace_uid AS "namespaceUID" FROM factory.runtime_attempt WHERE id=${second.id}`;
        if (!identity?.podUID || !identity.namespaceUID)
          throw new Error("Owned compute identity is incomplete");
        return identity;
      };
      const computeBefore = await computeIdentity();
      const retainedTarget = await readFactoryboxFixtureTarget(database, second.id);
      const retainedCaches = await runtimeCacheObservation({
        target: retainedTarget,
        startedAt: retainedStartedAt,
        projectImages,
      });
      expect(retainedCaches.kubelet.present).toBe(true);
      expect(retainedCaches.factoryboxBase).toEqual(initialCaches.factoryboxBase);
      expect(retainedCaches.privateDocker.project).toEqual(initialCaches.privateDocker.project);
      // Stop discards the old Sandbox's private Docker graph. Only the worker
      // base import is shared; a new private daemon may reacquire Project images.
      await writeFile(resolve(artifacts, "retained-caches.json"), JSON.stringify(retainedCaches));
      terminal.close();
      terminal = undefined;
      await fixture.kill(server);
      const recoveredAt = performance.now();
      await fixture.start();
      terminal =
        (await eventually(
          async () => {
            const current = await getAttempt(second.id);
            // Restart explicitly marks the same live Attempt starting until both
            // authenticated Connector roles return. That is recovery, not replacement.
            if (current.state === "starting") return null;
            if (current.state !== "ready")
              throw new Error(`Restart changed the owned ready Attempt to ${current.state}`);
            return ownedRuntimeTerminal(fixture.base, cookie, second.id, "restart-proof").catch(
              () => null,
            );
          },
          (connected) => connected !== null,
          "Exact owned PTY did not reconnect after Factory restart",
          60_000,
        )) ?? undefined;
      if (!terminal) throw new Error("Recovered terminal is missing");
      const reconnectMS = Math.round(performance.now() - recoveredAt);
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync("runtime-human.txt","utf8")',
        ),
      ).toBe(runtimeText);
      // Observe beyond the recovery deadline, not only before its timer can fire.
      await eventually(
        async () => {
          if ((await getAttempt(second.id)).state !== "ready")
            throw new Error("Recovered exact Runtime Attempt stopped after reconnection");
          return performance.now() - recoveredAt;
        },
        (elapsed) => elapsed >= 65_000,
        "Restart recovery observation did not reach its deadline",
        70_000,
      );
      expect(await computeIdentity()).toEqual(computeBefore);
      const restartedPod = z
        .object({ metadata: z.object({ uid: z.string() }) })
        .parse(
          JSON.parse(
            await editorFixtureKubectl(["get", "pod", "worker", "-n", namespace, "-o", "json"]),
          ),
        );
      expect(restartedPod.metadata.uid).toBe(computeBefore.podUID);
      const [recoveredSource] = await database.client<
        Array<{ namespaceUID: string; claimUID: string; podUID: string }>
      >`SELECT namespace_uid AS "namespaceUID",claim_uid AS "claimUID",pod_uid AS "podUID" FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
      expect(recoveredSource).toEqual(retained);
      expect(Buffer.from((await readSource("src/version.txt")).content, "base64").toString()).toBe(
        editedStopped,
      );
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          readyMS,
          connectedTerminalMS,
          executableTerminalMS,
          restartedReadyMS,
          restartedConnectedMS,
          restartedTerminalMS,
          sameCanonicalSource: true,
          stoppedEditing: true,
          sourceServiceRetained: true,
          noRuntimeEditor: true,
          factoryRestartRetainedIdentities: true,
          reconnectMS,
          exactAttempts: [attempt.id, second.id],
          noInference: true,
        }),
      );
      if (performanceEnabled)
        expect(slice20StartupTargetFailures({ executableTerminalMS, restartedTerminalMS })).toEqual(
          [],
        );
    } catch (cause) {
      if (ide)
        await ide.page
          .screenshot({ path: resolve(artifacts, "automatic-ide-failure.png") })
          .catch(() => {});
      const attempts = await database.client<
        Array<{ id: string; state: string; failure: string | null }>
      >`SELECT id,state,failure FROM factory.runtime_attempt WHERE project_id=${projectID}`;
      const lifecycle = await database.client`SELECT operation.runtime_attempt_id,operation.action,
        operation.snapshot_id,operation.attempted_at,operation.completed_at,
        operation.observation->'record'->>'phase' AS phase,
        operation.observation#>>'{record,pause,completed_at}' AS pause_completed_at,
        operation.observation#>>'{record,pause,resume,completed_at}' AS resume_completed_at
        FROM factory.factorybox_lifecycle_operation operation
        JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
        WHERE attempt.project_id=${projectID} ORDER BY operation.intended_at`;
      const [source] = workspaceID
        ? await database.client<
            Array<{
              workspaceID: string;
              namespace: string;
              epoch: string;
              podUID: string | null;
              state: string;
              failure: string | null;
              filesImage: string;
            }>
          >`SELECT source.workspace_id AS "workspaceID",workspace.kubernetes_namespace AS namespace,
            source.access_epoch::text AS epoch,source.pod_uid AS "podUID",source.state,source.failure,
            source.files_image AS "filesImage" FROM factory.workspace_source source
            JOIN factory.development_workspace workspace ON workspace.id=source.workspace_id
            WHERE source.workspace_id=${workspaceID}`.catch(() => [])
        : [];
      let sourceDiagnostic = "";
      let sourcePodStatus: unknown = null;
      if (source?.podUID) {
        const identity = workspaceSourceIdentity(workspaceID, Number(source.epoch));
        try {
          const pod = JSON.parse(
            await editorFixtureKubectl([
              "get",
              "pod",
              identity.podName,
              "-n",
              source.namespace,
              "-o",
              "json",
            ]),
          );
          if (
            pod.metadata.uid !== source.podUID ||
            pod.metadata.labels?.["factory.dev/runtime-owner"] !== workspaceID
          )
            throw new Error("Owned Source diagnostic UID changed");
          sourcePodStatus = pod.status;
          const output = await editorFixtureKubectl([
            "logs",
            identity.podName,
            "-n",
            source.namespace,
            "-c",
            "source",
            "--tail=12",
          ]);
          const capability = workspaceSourceCapability(
            "owned-process-auth-secret-not-a-production-credential",
            identity,
          );
          // Source initialization emits bounded errors, not Git output. Still
          // redact both fixture capabilities before retaining compact evidence.
          sourceDiagnostic = output
            .replaceAll(capability, "<REDACTED>")
            .replaceAll(forgeHost.token, "<REDACTED>")
            .slice(-4000);
        } catch {
          sourceDiagnostic = "Original Source Pod diagnostics are unavailable";
        }
      }
      await writeFile(
        resolve(artifacts, "failure.json"),
        JSON.stringify({
          error: cause instanceof Error ? cause.message : String(cause),
          source,
          sourcePodStatus,
          sourceDiagnostic,
          attempts: Array.from(attempts),
          lifecycle: Array.from(lifecycle),
        }),
      );
      throw cause;
    } finally {
      terminal?.close();
      try {
        await ide?.close();
        if (editorUserID) await stopAutomaticIDE(fixture, editorUserID, cookie, artifacts);
        const attempts = await database.client<
          Array<{ id: string; state: string }>
        >`SELECT id,state FROM factory.runtime_attempt WHERE project_id=${projectID}`;
        for (const attempt of attempts)
          if (attempt.state !== "stopped") await stopCompute(attempt.id);
        if (workspaceID) {
          expect(
            await callFactoryFunction(fixture.base, "stopWorkspaceSource", [workspaceID], {
              cookie: cookie,
            }),
          ).toMatchObject({ ok: true });
          await eventually(
            async () =>
              sourceWorkspaceViewSchema.parse(
                await serverCall(
                  callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
                    cookie: cookie,
                  }),
                ),
              ),
            (current) => current.state === "stopped",
            "Source Stop incomplete",
            40_000,
          );
        }
        await removeOwnedFactoryboxFixture(fixture, artifacts);
        const after = await editorFixtureNamespaces();
        expect(
          before.every((item) =>
            after.some((current) => current.name === item.name && current.uid === item.uid),
          ),
        ).toBe(true);
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({ ownedSharedWorkerRemoved: true, unrelatedNamespacesUnchanged: true }),
        );
        cleaned = true;
      } finally {
        await database.client.end({ timeout: 2 });
        if (cleaned) {
          await fixture.dispose();
          await forgeHost.dispose();
        } else {
          await fixture.pause();
        }
      }
    }
  },
  840_000,
);
