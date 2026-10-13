import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import upstream from "../../upstream.json";
import { starterImagesSchema } from "../../scripts/factory/starter-images";
import {
  runtimeAttemptSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { ownedRuntimeTerminal } from "../fixtures/runtime-access";
import { runtimeCacheObservation } from "../fixtures/runtime-cache-observation";
import { projectPrebuildRecipe, produceOwnedProjectPrebuild } from "../fixtures/project-prebuild";
import { slice20StartupTargetFailures } from "./runtime-startup";
import {
  editorFixtureNamespaces,
  editorFixtureKubectl,
  removeStoppedEditorSourceNamespace,
} from "../fixtures/editor-source-resources";

const prebuildEnabled = process.env["FACTORY_RUN_PROJECT_PREBUILD_PROOF"] === "1";
const idleEnabled = process.env["FACTORY_RUN_IDLE_COMPUTE_PROOF"] === "1";
const performanceEnabled = process.env["FACTORY_CHECK_SLICE20_STARTUP_TARGETS"] === "1";
const enabled =
  process.env["FACTORY_RUN_SOURCE_COMPUTE_PROOF"] === "1" || prebuildEnabled || idleEnabled;
const sourceFile = z.object({ content: z.string(), version: z.string() });

test.skipIf(!enabled)(
  "execution uses initialized canonical source and retains human/runtime edits through Stop and restart",
  async () => {
    if (performanceEnabled && idleEnabled)
      throw new Error(
        "Slice 20 startup targets require the explicit Stop/restart proof, not idle mode",
      );
    const image = async (name: string) => (await readFile(`.factory/${name}-image`, "utf8")).trim();
    const fixture = await factoryProcess(
      {
        runtimeHostImage: await image("runtime-host"),
        forgejoToken: (await readFile(".factory/forgejo-token", "utf8")).trim(),
      },
      {
        FACTORY_WORKSPACE_FILES_IMAGE: await image("workspace-files"),
        FACTORY_DEVELOPER_IDE_IMAGE: await image("developer-ide"),
        ...(idleEnabled ? { FACTORY_EXECUTION_IDLE_MINUTES: "1" } : {}),
      },
    );
    const database = fixture.connect();
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
    const repository = recipe?.directory ?? resolve(".factory/runtime-fixture-repository");
    const before = await editorFixtureNamespaces();
    let cookie = "";
    let workspaceID = "";
    let namespace = "";
    let namespaceUID = "";
    let cleaned = false;
    let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
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
        .parse(await (await api(`/api/runtime-attempts?projectId=${projectID}`)).json());
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
      expect((await api(`/api/runtime-attempts/${attemptID}/stop`, {})).ok).toBe(true);
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
        .parse(await (await api("/api/session")).json());
      await writeFile(resolve(artifacts, "intent.json"), JSON.stringify({ projectID, proofID }));
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`source-compute-${proofID}`},'Canonical compute proof',${`file://${repository}`},'main','.devcontainer/devcontainer.json',${session.user.id})`;
      const source = sourceWorkspaceViewSchema.parse(
        await (await api(`/api/projects/${projectID}/source-workspace/ensure`, {})).json(),
      );
      workspaceID = source.workspaceID;
      await eventually(
        async () =>
          sourceWorkspaceViewSchema.parse(
            await (await api(`/api/workspaces/${workspaceID}/source`)).json(),
          ),
        (current) => current.state === "ready",
        "Canonical source was not ready",
        150_000,
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
      const attempt = runtimeAttemptSchema.parse(
        await (await api(`/api/projects/${projectID}/personal-workspace/ensure`, {})).json(),
      );
      await ready(attempt.id);
      const readyMS = Math.round(performance.now() - started);
      terminal = await ownedRuntimeTerminal(fixture.base, cookie, attempt.id);
      const connectedTerminalMS = Math.round(performance.now() - started);
      expect(await terminal.evaluate<string>("return process.cwd()")).toBe("/workspace/project");
      const executableTerminalMS = Math.round(performance.now() - started);
      const pod = z
        .object({
          metadata: z.object({ uid: z.string() }),
          spec: z.object({
            nodeName: z.string(),
            nodeSelector: z.record(z.string(), z.string()),
            containers: z.array(
              z.object({
                resources: z.object({
                  requests: z.record(z.string(), z.string()),
                  limits: z.record(z.string(), z.string()),
                }),
              }),
            ),
          }),
        })
        .parse(
          JSON.parse(
            await editorFixtureKubectl(["get", "pod", "runtime-1", "-n", namespace, "-o", "json"]),
          ),
        );
      expect(pod.spec.nodeName).toBe(placement.node);
      expect(pod.spec.nodeSelector["kubernetes.io/hostname"]).toBe(placement.node);
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
        namespace,
        podName: "runtime-1",
        podUID: pod.metadata.uid,
        attemptID: attempt.id,
        node: placement.node,
        runtimeHostImage: await image("runtime-host"),
        startedAt: initialStartedAt,
        projectImages,
      });
      expect(initialCaches.kubelet.present).toBe(true);
      expect(initialCaches.kubelet.imageID).toContain("sha256:");
      expect(initialCaches.envboxDocker.digests).toContain(await image("runtime-host"));
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
          namespace,
          podName: "runtime-1",
          podUID: pod.metadata.uid,
          attemptID: attempt.id,
          projectID,
          commit: recipe.commit,
          runtimeHostImage: await image("runtime-host"),
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
        console.info("Idle proof: last PTY closed; waiting for automatic compute Stop");
        terminal.close();
        terminal = undefined;
        await eventually(
          async () => {
            await Bun.sleep(1000);
            return getAttempt(attempt.id);
          },
          (current) => current.state === "stopped",
          "Idle compute did not Stop after the last retained PTY closed",
          120_000,
        );
        const idleStopMS = Math.round(performance.now() - closedAt);
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
            idleStopMS,
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
      expect((await api(`/api/workspaces/${workspaceID}/source`)).ok).toBe(true);
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
        await (await api(`/api/projects/${projectID}/personal-workspace/ensure`, {})).json(),
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
      const retainedCaches = await runtimeCacheObservation({
        namespace,
        podName: "runtime-2",
        podUID: computeBefore.podUID,
        attemptID: second.id,
        node: placement.node,
        runtimeHostImage: await image("runtime-host"),
        startedAt: retainedStartedAt,
        projectImages,
      });
      expect(retainedCaches.kubelet.present).toBe(true);
      expect(retainedCaches.envboxDocker).toEqual(initialCaches.envboxDocker);
      expect(retainedCaches.privateDocker.project).toEqual(initialCaches.privateDocker.project);
      expect(retainedCaches.privateDocker.pullsSinceAdmission).toEqual([]);
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
            await editorFixtureKubectl(["get", "pod", "runtime-2", "-n", namespace, "-o", "json"]),
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
      await writeFile(
        resolve(artifacts, "failure.json"),
        JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }),
      );
      throw cause;
    } finally {
      terminal?.close();
      try {
        const attempts = await database.client<
          Array<{ id: string; state: string }>
        >`SELECT id,state FROM factory.runtime_attempt WHERE project_id=${projectID}`;
        for (const attempt of attempts)
          if (attempt.state !== "stopped") await stopCompute(attempt.id);
        if (workspaceID) {
          expect((await api(`/api/workspaces/${workspaceID}/source/stop`, {})).status).toBe(202);
          await eventually(
            async () =>
              sourceWorkspaceViewSchema.parse(
                await (await api(`/api/workspaces/${workspaceID}/source`)).json(),
              ),
            (current) => current.state === "stopped",
            "Source Stop incomplete",
            40_000,
          );
          expect(namespace).not.toBe("");
          expect(namespaceUID).not.toBe("");
          await removeStoppedEditorSourceNamespace(namespace, {
            ownerID: workspaceID,
            uid: namespaceUID,
          });
        }
        const after = await editorFixtureNamespaces();
        expect(
          before.every((item) =>
            after.some((current) => current.name === item.name && current.uid === item.uid),
          ),
        ).toBe(true);
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({ ownedNamespaceRemoved: true, unrelatedNamespacesUnchanged: true }),
        );
        cleaned = true;
      } finally {
        await database.client.end({ timeout: 2 });
        if (cleaned) await fixture.dispose();
      }
    }
  },
  840_000,
);
