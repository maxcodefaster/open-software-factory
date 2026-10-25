import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { publishedRuntimeArtifacts, runtimeArtifactsSchema } from "../../scripts/factory/artifacts";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction, factoryFunctionRequest } from "../fixtures/server-functions";

const enabled = process.env["FACTORY_RUN_SOURCE_LIFECYCLE_PROOF"] === "1";
const sourceView = z.object({
  workspaceID: z.uuid(),
  state: z.string(),
  epoch: z.number(),
  serviceID: z.string(),
});
const sourceFile = z.object({ content: z.string(), version: z.string() });
async function kubectl(args: string[], input?: unknown) {
  const child = Bun.spawn(["kubectl", "--context", "orbstack", ...args], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  }
  const [output, _error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (status !== 0) throw new Error(`Owned source fixture ${args[0]} failed`);
  return output;
}
async function namespaceUIDs() {
  const resources = z
    .object({
      items: z.array(z.object({ metadata: z.object({ name: z.string(), uid: z.string() }) })),
    })
    .parse(JSON.parse(await kubectl(["get", "namespaces", "-o", "json"])));
  return resources.items.map(({ metadata }) => metadata);
}

function requireOwnedNamespace(
  current: { uid: string; labels: Record<string, string> },
  workspaceID: string,
  namespaceUID: string | undefined,
) {
  if (
    current.labels["factory.dev/runtime-owner"] !== workspaceID ||
    current.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    (namespaceUID && current.uid !== namespaceUID)
  )
    throw new Error("Refusing unrelated source fixture cleanup");
}

test.skipIf(!enabled)(
  "fresh canonical source, authenticated access, crash recovery and epoch Stop need no execution",
  async () => {
    const published = await publishedRuntimeArtifacts(resolve(".factory"));
    if (!published) throw new Error("Publish the exact runtime artifacts before the source proof");
    const images = runtimeArtifactsSchema.parse(published);
    const fixture = await factoryProcess(undefined, {
      FACTORY_HOST: "0.0.0.0",
      FACTORY_WORKSPACE_FILES_IMAGE: images["workspace-files"],
    });
    const database = fixture.connect();
    const kubernetes = createKubernetesClient();
    const projectID = crypto.randomUUID();
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/source-lifecycle", proofID);
    await mkdir(artifacts, { recursive: true });
    const previousNamespaces = await namespaceUIDs();
    let workspaceID = "";
    let namespace: string | undefined;
    let namespaceUID: string | undefined;
    let developerCookie = "";
    let adminCookie = "";
    let watcher: AbortController | undefined;
    const api = (path: string, cookie: string, body?: unknown, signal?: AbortSignal) =>
      fetch(`${fixture.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    try {
      let server = await fixture.start();
      adminCookie = await fixture.signIn();
      const userResponse = await serverCall(
        callFactoryFunction(
          fixture.base,
          "createAccount",
          [
            {
              name: "Source proof Developer",
              email: `source-${proofID}@factory.invalid`,
              password: "source-proof-password-not-a-secret",
            },
          ],
          { cookie: adminCookie },
        ),
      );
      z.object({ id: z.string() }).parse(userResponse);
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`source-lifecycle-${proofID.slice(0, 8)}`},'Source lifecycle proof',${`file://${resolve(".factory/runtime-fixture-repository")}`},'main','.devcontainer/devcontainer.json','01994a7d-0000-7000-8000-000000000001')`;
      expect(
        (
          await callFactoryFunction(
            fixture.base,
            "saveProjectMember",
            [
              projectID,
              {
                email: `source-${proofID}@factory.invalid`,
                role: "developer",
              },
            ],
            { cookie: adminCookie },
          )
        ).ok,
      ).toBe(true);
      const signIn = await api("/api/auth/sign-in/email", "", {
        email: `source-${proofID}@factory.invalid`,
        password: "source-proof-password-not-a-secret",
      });
      expect(signIn.ok).toBe(true);
      developerCookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(
        (
          await fetch(
            await factoryFunctionRequest(fixture.base, "ensurePersonalSource", [projectID], {
              cookie: "",
            }),
          )
        ).status,
      ).toBe(401);
      const admitted = await serverCall(
        callFactoryFunction(fixture.base, "ensurePersonalSource", [projectID], {
          cookie: developerCookie,
        }),
      );
      workspaceID = admitted.workspaceID;
      const [workspace] = await database.client<
        Array<{ namespace: string }>
      >`SELECT kubernetes_namespace AS namespace FROM factory.development_workspace WHERE id=${workspaceID}`;
      if (!workspace) throw new Error("Missing intended Workspace");
      namespace = workspace.namespace;
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({ proofID, projectID, workspaceID, namespace }),
      );
      await eventually(
        async () => {
          const view = await serverCall(
            callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
              cookie: developerCookie,
            }),
          );
          if (view.state === "failed") throw new Error("Fresh source initialization failed");
          return view;
        },
        (view) => view.state === "ready",
        "Independent source initialization did not finish",
        150_000,
      );
      const sourcePath = `/api/workspaces/${workspaceID}/source`;
      const [source] = await database.client<
        Array<{ namespaceUID: string; claimUID: string; podUID: string; node: string }>
      >`SELECT namespace_uid AS "namespaceUID",claim_uid AS "claimUID",pod_uid AS "podUID",storage_node AS node FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
      if (!source) throw new Error("Missing recorded source outcome");
      namespaceUID = source.namespaceUID;
      expect((await kubernetes.getNamespace(namespace))?.uid).toBe(namespaceUID);
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT id FROM factory.change WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      const originalResponse = await api(`${sourcePath}/read`, developerCookie, {
        path: "src/version.txt",
      });
      expect(originalResponse.ok).toBe(true);
      const original = sourceFile.parse(await originalResponse.json());
      const changed = Buffer.from(`human-source-${proofID}\n`).toString("base64");
      expect(
        (
          await api(`${sourcePath}/write`, developerCookie, {
            path: "src/version.txt",
            content: changed,
            version: original.version,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await api(`${sourcePath}/write`, developerCookie, {
            path: "src/version.txt",
            content: original.content,
            version: original.version,
          })
        ).status,
      ).toBe(409);
      expect(
        (await api(`${sourcePath}/read`, developerCookie, { path: ".git/config" })).status,
      ).toBe(403);
      expect(
        (await api(`${sourcePath}/read`, developerCookie, { path: "../outside" })).status,
      ).toBe(403);
      const search = await api(`${sourcePath}/search`, developerCookie, {
        path: "",
        search: { query: `human-source-${proofID}` },
      });
      expect(search.ok).toBe(true);
      const found = z
        .object({ results: z.array(z.object({ path: z.string() })) })
        .parse(await search.json());
      expect(found.results.map((file) => file.path)).toEqual(["src/version.txt"]);

      watcher = new AbortController();
      const events = await api(`${sourcePath}/events`, developerCookie, undefined, watcher.signal);
      expect(events.ok).toBe(true);
      const reader = events.body?.getReader();
      if (!reader) throw new Error("Missing authenticated source watch");
      expect((await reader.read()).done).toBe(false);
      const finishedWatch = (async () => {
        while (!(await reader.read()).done) {}
      })();
      expect(
        (
          await callFactoryFunction(
            fixture.base,
            "saveProjectMember",
            [
              projectID,
              {
                email: `source-${proofID}@factory.invalid`,
                role: "product-contributor",
              },
            ],
            { cookie: adminCookie },
          )
        ).ok,
      ).toBe(true);
      await Promise.race([
        finishedWatch,
        Bun.sleep(5_000).then(() => {
          throw new Error("Role downgrade did not close watch");
        }),
      ]);
      expect(
        (await api(`${sourcePath}/read`, developerCookie, { path: "src/version.txt" })).status,
      ).toBe(403);
      expect(
        await callFactoryFunction(fixture.base, "ensureWorkspaceSource", [workspaceID], {
          cookie: developerCookie,
        }),
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        (
          await callFactoryFunction(
            fixture.base,
            "saveProjectMember",
            [
              projectID,
              {
                email: `source-${proofID}@factory.invalid`,
                role: "developer",
              },
            ],
            { cookie: adminCookie },
          )
        ).ok,
      ).toBe(true);
      await fixture.kill(server);
      // Source access must not leave a tunnel process after Factory exits.
      await eventually(
        async () => {
          const child = Bun.spawn(["ps", "-Ao", "command"], { stdout: "pipe" });
          const output = await new Response(child.stdout).text();
          await child.exited;
          return output
            .split("\n")
            .filter(
              (line) =>
                line.includes(namespace ?? "missing-namespace") && line.includes("port-forward"),
            );
        },
        (commands) => commands.length === 0,
        "Factory crash orphaned a source connection",
        5_000,
      );
      server = await fixture.start();
      await eventually(
        async () =>
          sourceView.parse(
            await serverCall(
              callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
                cookie: developerCookie,
              }),
            ),
          ),
        (view) => view.state === "ready",
        "Restart did not retain source",
      );
      const recoveredPod = z
        .object({ metadata: z.object({ uid: z.string() }) })
        .parse(
          JSON.parse(await kubectl(["get", "pod", "source-1", "-n", namespace, "-o", "json"])),
        );
      expect(recoveredPod.metadata.uid).toBe(source.podUID);
      expect(
        sourceFile.parse(
          await (
            await api(`${sourcePath}/read`, developerCookie, { path: "src/version.txt" })
          ).json(),
        ).content,
      ).toBe(changed);
      expect(
        await callFactoryFunction(fixture.base, "stopWorkspaceSource", [workspaceID], {
          cookie: developerCookie,
        }),
      ).toMatchObject({ ok: true });
      await eventually(
        async () =>
          sourceView.parse(
            await serverCall(
              callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
                cookie: developerCookie,
              }),
            ),
          ),
        (view) => view.state === "stopped",
        "Owned source Stop did not finish",
      );
      expect(await kubernetes.getPod(namespace, "source-1")).toBeNull();
      expect((await kubernetes.getNamespace(namespace))?.uid).toBe(namespaceUID);
      const resumed = sourceView.parse(
        await serverCall(
          callFactoryFunction(fixture.base, "ensureWorkspaceSource", [workspaceID], {
            cookie: developerCookie,
          }),
        ),
      );
      expect(resumed.epoch).toBe(2);
      await eventually(
        async () =>
          sourceView.parse(
            await serverCall(
              callFactoryFunction(fixture.base, "getWorkspaceSource", [workspaceID], {
                cookie: developerCookie,
              }),
            ),
          ),
        (view) => view.state === "ready",
        "Source epoch 2 did not become ready",
        150_000,
      );
      expect(
        sourceFile.parse(
          await (
            await api(`${sourcePath}/read`, developerCookie, { path: "src/version.txt" })
          ).json(),
        ).content,
      ).toBe(changed);
      const [retained] = await database.client<
        Array<{ claimUID: string }>
      >`SELECT claim_uid AS "claimUID" FROM factory.workspace_source WHERE workspace_id=${workspaceID}`;
      expect(retained?.claimUID).toBe(source.claimUID);
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          projectID,
          workspaceID,
          source,
          epoch: 2,
          independent: true,
          roleRevocation: true,
          crashRecovery: true,
          retainedHumanSource: true,
        }),
      );
    } catch (cause) {
      if (namespace) {
        const pod = await kubectl(["get", "pods", "-n", namespace, "-o", "json"]).catch(() => "{}");
        const status = z
          .object({
            items: z
              .array(
                z.object({
                  metadata: z.object({ name: z.string() }),
                  status: z.unknown().optional(),
                }),
              )
              .optional(),
          })
          .parse(JSON.parse(pod));
        await writeFile(resolve(artifacts, "failure.json"), JSON.stringify(status));
      }
      throw cause;
    } finally {
      watcher?.abort();
      try {
        const ownedWorkspaceID = workspaceID;
        if (ownedWorkspaceID) {
          if (fixture.processes.at(-1)?.exitCode !== null) await fixture.start();
          await serverCall(
            callFactoryFunction(
              fixture.base,
              "saveProjectMember",
              [
                projectID,
                {
                  email: `source-${proofID}@factory.invalid`,
                  role: "developer",
                },
              ],
              { cookie: adminCookie },
            ),
          );
          await serverCall(
            callFactoryFunction(fixture.base, "stopWorkspaceSource", [workspaceID], {
              cookie: developerCookie,
            }),
          ).catch(() => null);
          await eventually(
            async () => {
              const [row] = await database.client<
                Array<{ state: string }>
              >`SELECT state FROM factory.workspace_source WHERE workspace_id=${ownedWorkspaceID}`;
              return row?.state;
            },
            (state) => state === "stopped",
            "Owned source cleanup is not confirmed",
            40_000,
          );
        }
        if (namespace && workspaceID) {
          const current = await kubernetes.getNamespace(namespace);
          if (current) {
            requireOwnedNamespace(current, workspaceID, namespaceUID);
            await kubectl(["delete", "--raw", `/api/v1/namespaces/${namespace}`, "-f", "-"], {
              apiVersion: "v1",
              kind: "DeleteOptions",
              preconditions: { uid: current.uid },
            });
            await eventually(
              () => kubernetes.getNamespace(namespace as string),
              (current) => current === null,
              "Owned namespace deletion is not confirmed",
              120_000,
            );
          }
        }
        const remaining = await namespaceUIDs();
        expect(
          previousNamespaces.every((before) =>
            remaining.some((after) => before.name === after.name && before.uid === after.uid),
          ),
        ).toBe(true);
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({
            projectID,
            workspaceID,
            namespace,
            removedOwnedFixture: true,
            unrelatedNamespacesUnchanged: true,
          }),
        );
      } finally {
        await database.client.end({ timeout: 2 });
        await fixture.dispose();
      }
    }
  },
  360_000,
);
