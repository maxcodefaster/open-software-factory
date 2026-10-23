import { test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { createDatabase } from "../../packages/db/src/client";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { deleteFactoryProject, signIn, stopProjectRuntimes } from "../support/factory-fixture";

const enabled = process.env["FACTORY_RUN_SOURCE_STORAGE_PROOF"] === "1";

async function kubectl(args: string[], input?: unknown): Promise<string> {
  const command = spawn("kubectl", ["--context", "orbstack", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 90_000,
  });
  const result = new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    command.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    command.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    command.on("error", () => reject(new Error("Could not start Kubernetes fixture command")));
    command.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            stderr.includes("NotFound")
              ? "Kubernetes fixture resource was not found"
              : `Kubernetes fixture ${args[0]} failed`,
          ),
        );
    });
  });
  command.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return result;
}

async function forwardedPort(process: ChildProcess): Promise<number> {
  const stdout = process.stdout;
  if (!stdout) throw new Error("Missing port-forward output");
  let output = "";
  for await (const chunk of stdout.iterator({ destroyOnReturn: false })) {
    output += chunk.toString();
    const matched = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (matched?.[1]) {
      stdout.resume();
      return Number(matched[1]);
    }
    if (output.length > 4096) break;
  }
  throw new Error("Source fixture port-forward did not become ready");
}

function requireProofOwner(
  resource: { metadata: { labels?: Record<string, string> } },
  proofID: string,
): void {
  if (resource.metadata.labels?.["factory.dev/source-storage-proof"] !== proofID)
    throw new Error("Refusing unowned source fixture cleanup");
}

test.skipIf(!enabled)(
  "canonical RWO source is shared with Sysbox and remains accessible after compute Stop",
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:3000" });
    const page = await context.newPage();
    const database = createDatabase(2);
    const kubernetes = createKubernetesClient();
    const projectID = randomUUID();
    const proofID = randomUUID();
    const slug = `source-storage-${projectID.slice(0, 8)}`;
    const artifacts = resolve(".factory/test-results/source-storage", proofID);
    await mkdir(artifacts, { recursive: true });
    const metadata: unknown = JSON.parse(
      await readFile(".factory/workspace-files-proof-metadata.json", "utf8"),
    );
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("containerimage.digest" in metadata) ||
      typeof metadata["containerimage.digest"] !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(metadata["containerimage.digest"])
    )
      throw new Error("Publish the exact source proof artifact first");
    const image = `registry.open-factory-envbox-smoke.svc.cluster.local:5000/open-factory/workspace-files@${metadata["containerimage.digest"]}`;
    let created = false;
    let runtime:
      | {
          id: string;
          workspaceID: string;
          namespace: string;
          pod: string;
          namespaceUID: string;
          generation: number;
        }
      | undefined;
    let sourceForward: ChildProcess | undefined;
    const sourcePod = "source-proof";
    const sourceSecret = "source-proof-assignment";
    const proofLabel = "factory.dev/source-storage-proof";
    let failed = false;
    let cleanupFailure: { cause: unknown } | undefined;
    try {
      await signIn(page);
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
      const { session } = await (await page.request.get("/api/session")).json();
      if (!session) throw new Error("Missing fixture owner");
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({ proofID, projectID, slug, image }),
      );
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES (${projectID},${slug},'Source storage proof','http://127.0.0.1:33030/factory-mutation/runtime-fixture.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
      created = true;
      const response = await page.request.post(
        `/api/projects/${projectID}/personal-workspace/ensure`,
        { headers: { origin: "http://127.0.0.1:3000" } },
      );
      expect(response.ok()).toBe(true);
      const attempt = runtimeAttemptSchema.parse(await response.json());
      await expect
        .poll(
          async () => {
            const [row] = await database.client<
              Array<{ state: string }>
            >`SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id}`;
            if (row?.state === "failed" || row?.state === "cleanup-failed")
              throw new Error("Owned compute preparation failed");
            return row?.state;
          },
          { timeout: 300_000, intervals: [1000] },
        )
        .toBe("ready");
      const [row] = await database.client<
        Array<{
          workspaceID: string;
          namespace: string;
          pod: string;
          namespaceUID: string;
          generation: string;
        }>
      >`SELECT workspace_id AS "workspaceID",kubernetes_namespace AS namespace,kubernetes_pod_name AS pod,kubernetes_namespace_uid AS "namespaceUID",generation FROM factory.runtime_attempt WHERE id=${attempt.id}`;
      if (!row) throw new Error("Missing exact runtime storage identity");
      runtime = { ...row, id: attempt.id, generation: Number(row.generation) };
      const namespace = await kubernetes.getNamespace(runtime.namespace);
      expect(namespace?.uid).toBe(runtime.namespaceUID);
      expect(namespace?.labels["factory.dev/runtime-owner"]).toBe(runtime.workspaceID);
      const outer = JSON.parse(
        await kubectl(["get", "pod", runtime.pod, "-n", runtime.namespace, "-o", "json"]),
      );
      const node = outer.spec.nodeName as string;
      expect(outer.metadata.labels["factory.dev/runtime-attempt"]).toBe(runtime.id);
      expect(node).toBeTruthy();
      const claim = JSON.parse(
        await kubectl(["get", "pvc", "runtime-data", "-n", runtime.namespace, "-o", "json"]),
      );
      expect(claim.spec.accessModes).toEqual(["ReadWriteOnce"]);
      const token = randomBytes(32).toString("hex");
      const serviceID = `source-${proofID.slice(0, 8)}`;
      const labels = {
        "app.kubernetes.io/managed-by": "open-software-factory",
        [proofLabel]: proofID,
        "factory.dev/runtime-owner": runtime.workspaceID,
      };
      await writeFile(
        resolve(artifacts, "source-intent.json"),
        JSON.stringify({ ...runtime, sourcePod, sourceSecret, node, image, serviceID }),
      );
      await kubectl(["create", "-f", "-"], {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: sourceSecret, namespace: runtime.namespace, labels },
        stringData: {
          "access.json": JSON.stringify({
            workspaceId: runtime.workspaceID,
            serviceId: serviceID,
            epoch: 1,
            token,
          }),
        },
      });
      await kubectl(["create", "-f", "-"], {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: sourcePod, namespace: runtime.namespace, labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeSelector: { "kubernetes.io/hostname": node },
          securityContext: {
            runAsUser: 101000,
            runAsGroup: 101000,
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "source",
              image,
              imagePullPolicy: "IfNotPresent",
              args: [
                "--root",
                "/source",
                "--assignment",
                "/assignment/access.json",
                "--listen",
                "0.0.0.0:4600",
              ],
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "250m", memory: "128Mi" },
              },
              securityContext: {
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [
                { name: "source", mountPath: "/source", subPath: "home/project" },
                { name: "assignment", mountPath: "/assignment", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "source", persistentVolumeClaim: { claimName: "runtime-data" } },
            { name: "assignment", secret: { secretName: sourceSecret, defaultMode: 292 } },
          ],
        },
      });
      await kubectl([
        "wait",
        "pod",
        sourcePod,
        "-n",
        runtime.namespace,
        "--for=condition=Ready",
        "--timeout=60s",
      ]);
      const source = JSON.parse(
        await kubectl(["get", "pod", sourcePod, "-n", runtime.namespace, "-o", "json"]),
      );
      expect(source.spec.nodeName).toBe(node);
      sourceForward = spawn(
        "kubectl",
        [
          "--context",
          "orbstack",
          "port-forward",
          "-n",
          runtime.namespace,
          `pod/${sourcePod}`,
          "--address",
          "127.0.0.1",
          "0:4600",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const port = await forwardedPort(sourceForward);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Factory-Source-Service": serviceID,
        "X-Factory-Source-Epoch": "1",
      };
      const endpoint = `http://127.0.0.1:${port}/v1/workspaces/${runtime.workspaceID}/`;
      const call = async (operation: string, input: unknown) =>
        fetch(`${endpoint}${operation}`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
      expect((await call("read", { path: "src/server.mjs" })).status).toBe(200);
      const active = runtime;
      const inner = async (...args: string[]) =>
        kubectl([
          "exec",
          active.pod,
          "-n",
          active.namespace,
          "--",
          "docker",
          "exec",
          "workspace_cvm",
          ...args,
        ]);
      expect(await inner("cat", "/proc/self/uid_map")).toMatch(/0\s+100000\s+65536/);
      expect(
        await kubectl([
          "exec",
          runtime.pod,
          "-n",
          runtime.namespace,
          "--",
          "stat",
          "-c",
          "%u:%g",
          "/home/coder/project",
        ]),
      ).toBe("101000:101000");
      const containerIDs = await inner(
        "docker",
        "ps",
        "-q",
        "--filter",
        `label=factory.dev/runtime-attempt=${runtime.id}`,
        "--filter",
        `label=factory.dev/runtime-generation=${runtime.generation}`,
      );
      const primaryIDs = containerIDs.split("\n").filter(Boolean);
      expect(primaryIDs).toHaveLength(1);
      const primary = primaryIDs[0];
      if (!primary) throw new Error("Missing exact Dev Container primary");
      const primaryNode = (code: string) =>
        inner(
          "docker",
          "exec",
          "--user",
          "1000:1000",
          "--workdir",
          "/workspace/project",
          primary,
          "node",
          "-e",
          code,
        );
      expect(
        await primaryNode(
          'process.stdout.write(process.getuid()+":"+require("fs").statSync(".").uid)',
        ),
      ).toBe("1000:1000");
      const watch = primaryNode(
        'const fs=require("fs");const watch=fs.watch(".",(_,name)=>{if(name==="source-proof.txt"){console.log("runtime-saw="+fs.readFileSync(name,"utf8"));watch.close();clearTimeout(timer)}});const timer=setTimeout(()=>{watch.close();process.exitCode=1},10000);fs.writeFileSync("source-watch-ready","ready")',
      );
      await expect
        .poll(async () => (await call("stat", { path: "source-watch-ready" })).status, {
          timeout: 5000,
        })
        .toBe(200);
      await expect
        .poll(
          async () =>
            (
              await call("write", {
                path: "source-proof.txt",
                content: Buffer.from("human").toString("base64"),
                version: "",
              })
            ).status,
          { timeout: 5000 },
        )
        .toBe(200);
      expect(await watch).toContain("runtime-saw=human");
      const eventStop = new AbortController();
      const events = await fetch(`${endpoint}events`, { headers, signal: eventStop.signal });
      const reader = events.body?.getReader();
      if (!reader) throw new Error("Missing native source event stream");
      try {
        await reader.read(); // Initial reconciliation.
        await primaryNode('require("fs").writeFileSync("source-proof.txt","runtime")');
        let observed = "";
        const deadline = performance.now() + 5000;
        while (!observed.includes('"path":"source-proof.txt"') && performance.now() < deadline) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Native watch event deadline")), 5000),
            ),
          ]);
          observed += new TextDecoder().decode(chunk.value);
        }
        expect(observed).toContain('"path":"source-proof.txt"');
      } finally {
        eventStop.abort();
        await reader.cancel().catch(() => {});
      }
      const runtimeWrite = await (await call("read", { path: "source-proof.txt" })).json();
      expect(Buffer.from(runtimeWrite.content, "base64").toString()).toBe("runtime");
      const stop = await page.request.post(`/api/runtime-attempts/${runtime.id}/stop`, {
        headers: { origin: "http://127.0.0.1:3000" },
      });
      expect(stop.ok()).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await database.client<
                Array<{ state: string }>
              >`SELECT state FROM factory.runtime_attempt WHERE id=${active.id}`
            )[0]?.state,
          { timeout: 120_000, intervals: [1000] },
        )
        .toBe("stopped");
      expect(await kubernetes.getPod(runtime.namespace, runtime.pod)).toBeNull();
      expect(
        (
          await call("write", {
            path: "source-proof.txt",
            content: Buffer.from("after-stop").toString("base64"),
            version: runtimeWrite.version,
          })
        ).status,
      ).toBe(200);
      const retained = await (await call("read", { path: "source-proof.txt" })).json();
      expect(Buffer.from(retained.content, "base64").toString()).toBe("after-stop");
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT id FROM factory.change WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          proofID,
          image,
          runtime,
          node,
          sourcePodUID: source.metadata.uid,
          claimUID: claim.metadata.uid,
          actualOuterUID: 101000,
          actualInnerUID: 1000,
          bidirectionalWatch: true,
          editingAfterStop: true,
        }),
      );
    } catch (error) {
      failed = true;
      await writeFile(
        resolve(artifacts, "failure.json"),
        JSON.stringify({ proofID, error: String(error), runtime }),
      );
      throw error;
    } finally {
      try {
        sourceForward?.kill();
        if (created) await stopProjectRuntimes(page.request, projectID);
        if (runtime) {
          const owned = runtime;
          for (const [plural, name] of [
            ["pods", sourcePod],
            ["secrets", sourceSecret],
          ] as const) {
            const raw = await kubectl([
              "get",
              plural,
              name,
              "-n",
              runtime.namespace,
              "-o",
              "json",
            ]).catch((error: unknown) => {
              if (
                error instanceof Error &&
                error.message === "Kubernetes fixture resource was not found"
              )
                return undefined;
              throw error;
            });
            if (!raw) continue;
            const resource = JSON.parse(raw);
            requireProofOwner(resource, proofID);
            await kubectl(
              [
                "delete",
                "--raw",
                `/api/v1/namespaces/${runtime.namespace}/${plural}/${name}`,
                "-f",
                "-",
              ],
              {
                apiVersion: "v1",
                kind: "DeleteOptions",
                preconditions: { uid: resource.metadata.uid },
              },
            );
          }
          await expect
            .poll(
              async () => {
                const pod = await kubernetes.getPod(owned.namespace, sourcePod);
                return pod === null;
              },
              { timeout: 60_000 },
            )
            .toBe(true);
          await kubernetes.deleteNamespace({
            namespace: runtime.namespace,
            namespaceUID: runtime.namespaceUID,
            podName: runtime.pod,
            attemptID: runtime.id,
            generation: runtime.generation,
            uid: null,
            ownerID: runtime.workspaceID,
          });
        }
        if (created) await deleteFactoryProject(projectID);
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({
            proofID,
            projectID,
            sourceNamespaceRemoved: runtime?.namespace ?? null,
          }),
        );
      } catch (error) {
        await writeFile(
          resolve(artifacts, "cleanup-failed.json"),
          JSON.stringify({ proofID, projectID, runtime, error: String(error) }),
        );
        cleanupFailure = { cause: error };
        if (failed) console.error("Owned storage fixture cleanup failed", String(error));
      } finally {
        await database.client.end({ timeout: 2 });
        await browser.close();
      }
    }
    if (cleanupFailure) throw cleanupFailure.cause;
  },
  480_000,
);
