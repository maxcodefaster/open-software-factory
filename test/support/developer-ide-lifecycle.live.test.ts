import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { recordedEditorIdentity } from "../fixtures/editor-source-resources";
import { createDeveloperIDEClient } from "../../packages/runtime-kubernetes/src/developer-ide";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";

const enabled = process.env["FACTORY_RUN_DEVELOPER_IDE_PROOF"] === "1";
const viewSchema = z.object({ state: z.string(), serviceID: z.string(), epoch: z.number() });
async function kubectl(args: string[], input?: unknown) {
  const process = Bun.spawn(["kubectl", "--context", "orbstack", ...args], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => process.kill(), 30_000);
  if (input !== undefined && process.stdin && typeof process.stdin !== "number") {
    process.stdin.write(JSON.stringify(input));
    process.stdin.end();
  }
  const [output, _error, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  clearTimeout(timer);
  if (status !== 0) throw new Error(`Owned editor fixture ${args[0]} failed`);
  return output;
}
async function namespaces() {
  return z
    .object({
      items: z.array(z.object({ metadata: z.object({ name: z.string(), uid: z.string() }) })),
    })
    .parse(JSON.parse(await kubectl(["get", "namespaces", "-o", "json"])))
    .items.map((item) => item.metadata);
}

function requireOwnedEditorNamespace(
  current: { uid: string; labels: Record<string, string> },
  userID: string,
  namespaceUID: string | undefined,
) {
  if (
    current.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    current.labels["factory.dev/runtime-owner"] !== userID ||
    (namespaceUID && current.uid !== namespaceUID)
  )
    throw new Error("Refusing unowned editor cleanup");
}

test.skipIf(!enabled)(
  "authenticated Developer IDE has one real warm backend independent of Projects and compute",
  async () => {
    const image =
      process.env["FACTORY_TEST_DEVELOPER_IDE_IMAGE"] ??
      (await readFile(".factory/developer-ide-image", "utf8")).trim();
    const fixture = await factoryProcess(undefined, { FACTORY_DEVELOPER_IDE_IMAGE: image });
    const database = fixture.connect();
    const kubernetes = createKubernetesClient();
    const client = createDeveloperIDEClient();
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/developer-ide-lifecycle", proofID);
    await mkdir(artifacts, { recursive: true });
    const previousNamespaces = await namespaces();
    const projectID = crypto.randomUUID();
    const secondProjectID = crypto.randomUUID();
    let userID: string | undefined;
    let namespace: string | undefined;
    let namespaceUID: string | undefined;
    let adminCookie = "";
    let developerCookie = "";
    const email = `editor-${proofID}@factory.invalid`;
    const password = "editor-proof-password-not-a-secret";
    const api = (path: string, cookie: string, body?: unknown) =>
      fetch(`${fixture.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    try {
      let server = await fixture.start();
      adminCookie = await fixture.signIn();
      const userResponse = await api("/api/admin/users", adminCookie, {
        name: "Independent editor Developer",
        email,
        password,
      });
      expect(userResponse.status).toBe(201);
      userID = z.object({ id: z.uuid() }).parse(await userResponse.json()).id;
      for (const id of [projectID, secondProjectID]) {
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${id},${`editor-${id}`},'Independent editor proof','https://forge.invalid/editor.git','main','.devcontainer/devcontainer.json',${userID})`;
        expect(
          (await api(`/api/projects/${id}/members`, adminCookie, { email, role: "developer" })).ok,
        ).toBe(true);
      }
      const signIn = await api("/api/auth/sign-in/email", "", { email, password });
      expect(signIn.ok).toBe(true);
      developerCookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect((await api(`/api/projects/${projectID}/developer-ide/ensure`, "", {})).status).toBe(
        401,
      );
      const started = performance.now();
      const first = viewSchema.parse(
        await (
          await api(`/api/projects/${projectID}/developer-ide/ensure`, developerCookie, {})
        ).json(),
      );
      const identity = await recordedEditorIdentity(database, userID);
      if (!identity) throw new Error("Missing recorded editor identity");
      namespace = identity.namespace;
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({
          proofID,
          userID,
          projectID,
          secondProjectID,
          namespace,
          image,
          serviceID: first.serviceID,
        }),
      );
      await eventually(
        async () =>
          viewSchema.parse(await (await api("/api/developer-ide", developerCookie)).json()),
        (view) => view.state === "ready",
        "Real editor Pod did not become ready",
        120_000,
      );
      const [outcome] = await database.client<
        Array<{ namespaceUID: string; podUID: string }>
      >`SELECT namespace_uid AS "namespaceUID",pod_uid AS "podUID" FROM factory.developer_ide WHERE user_id=${userID}`;
      if (!outcome) throw new Error("Editor create outcome not recorded");
      namespaceUID = outcome.namespaceUID;
      const resources = { identity, image, ...outcome };
      const endpoint = await client.endpoint(resources);
      const native = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
      expect(native.status).toBe(200);
      expect(await native.text()).toContain("theia");
      const backendReadyMS = performance.now() - started;
      const second = viewSchema.parse(
        await (
          await api(`/api/projects/${secondProjectID}/developer-ide/ensure`, developerCookie, {})
        ).json(),
      );
      expect(second.serviceID).toBe(first.serviceID);
      expect((await kubernetes.getPod(namespace, "editor-1"))?.uid).toBe(outcome.podUID);
      for (const relation of ["runtime_attempt", "change", "agent_turn", "development_workspace"])
        expect(await database.client.unsafe(`SELECT 1 FROM factory.${relation}`)).toHaveLength(0);
      await fixture.kill(server);
      server = await fixture.start();
      await eventually(
        async () =>
          viewSchema.parse(await (await api("/api/developer-ide", developerCookie)).json()),
        (view) => view.state === "ready",
        "Editor did not recover after Factory crash",
      );
      expect((await kubernetes.getPod(namespace, "editor-1"))?.uid).toBe(outcome.podUID);
      expect((await client.observe(resources))?.ready).toBe(true);
      expect((await api("/api/developer-ide/stop", developerCookie, {})).status).toBe(202);
      await eventually(
        async () =>
          viewSchema.parse(await (await api("/api/developer-ide", developerCookie)).json()),
        (view) => view.state === "stopped",
        "Editor Stop did not complete",
        40_000,
      );
      expect(await kubernetes.getPod(namespace, "editor-1")).toBeNull();
      expect((await kubernetes.getNamespace(namespace))?.uid).toBe(namespaceUID);
      const restarted = viewSchema.parse(
        await (
          await api(`/api/projects/${projectID}/developer-ide/ensure`, developerCookie, {})
        ).json(),
      );
      expect(restarted.epoch).toBe(2);
      await eventually(
        async () =>
          viewSchema.parse(await (await api("/api/developer-ide", developerCookie)).json()),
        (view) => view.state === "ready",
        "Editor epoch 2 did not start",
        120_000,
      );
      expect((await kubernetes.getPod(namespace, "editor-2"))?.uid).not.toBe(outcome.podUID);
      for (const id of [projectID, secondProjectID])
        expect(
          (
            await api(`/api/projects/${id}/members`, adminCookie, {
              email,
              role: "product-contributor",
            })
          ).ok,
        ).toBe(true);
      expect((await api("/api/developer-ide", developerCookie)).status).toBe(403);
      expect(
        (await api(`/api/projects/${projectID}/developer-ide/ensure`, developerCookie, {})).status,
      ).toBe(403);
      const ownedUserID = userID;
      await eventually(
        async () =>
          (
            await database.client<
              Array<{ state: string }>
            >`SELECT state FROM factory.developer_ide WHERE user_id=${ownedUserID}`
          )[0]?.state,
        (state) => state === "stopped",
        "Revocation did not stop the owned editor",
        40_000,
      );
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          backendReadyMS,
          image,
          first,
          restarted,
          namespaceUID,
          podUID: outcome.podUID,
          retainedAcrossFactoryCrash: true,
          noExecution: true,
          revocationStopsEditor: true,
        }),
      );
    } catch (cause) {
      if (namespace) {
        const raw = await kubectl(["get", "pods", "-n", namespace, "-o", "json"]).catch(() => "{}");
        await writeFile(resolve(artifacts, "failure.json"), raw);
      }
      throw cause;
    } finally {
      client.close();
      try {
        if (userID) {
          namespace ??= (await recordedEditorIdentity(database, userID))?.namespace;
          if (fixture.processes.at(-1)?.exitCode !== null) await fixture.start();
          await api("/api/developer-ide/stop", developerCookie, {}).catch(() => null);
          const ownedUserID = userID;
          await eventually(
            async () =>
              (
                await database.client<
                  Array<{ state: string }>
                >`SELECT state FROM factory.developer_ide WHERE user_id=${ownedUserID}`
              )[0]?.state,
            (state) => state === "stopped" || state === undefined,
            "Owned editor cleanup failed",
            40_000,
          );
        }
        if (namespace && userID) {
          const current = await kubernetes.getNamespace(namespace);
          if (current) {
            requireOwnedEditorNamespace(current, userID, namespaceUID);
            await kubectl(["delete", "--raw", `/api/v1/namespaces/${namespace}`, "-f", "-"], {
              apiVersion: "v1",
              kind: "DeleteOptions",
              preconditions: { uid: current.uid },
            });
            const ownedNamespace = namespace;
            await eventually(
              () => kubernetes.getNamespace(ownedNamespace),
              (current) => current === null,
              "Owned editor namespace remained",
              120_000,
            );
          }
        }
        const remaining = await namespaces();
        expect(
          previousNamespaces.every((before) =>
            remaining.some((after) => after.name === before.name && after.uid === before.uid),
          ),
        ).toBe(true);
        await writeFile(
          resolve(artifacts, "cleanup.json"),
          JSON.stringify({
            userID,
            namespace,
            namespaceUID,
            ownedFixtureRemoved: true,
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
