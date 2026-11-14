import { expect, test } from "bun:test";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeProcessProtocol } from "../fixtures/native-process-protocol";

test("isolated Factory grants stay on its listener and refuse disconnected Apps", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  let native: Awaited<ReturnType<typeof nativeProcessProtocol>> | undefined;
  try {
    native = await nativeProcessProtocol(process, database);
    await process.start();
    const cookie = await process.signIn();
    const [administrator] = await database.client<{ id: string }[]>`
      SELECT user_id AS id FROM factory.administrator`;
    if (!administrator) throw Error("Owned Factory administrator missing");
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`access-${projectID}`},'Owned runtime access','https://example.invalid/fixture.git','main','.devcontainer/devcontainer.json',${administrator.id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${projectID},${administrator.id},'developer',${administrator.id})`;
    // Retained source revision avoids any real Forge/Git/network dependency.
    const workspaceID = personalWorkspaceIdentity(projectID, administrator.id).workspaceID;
    await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${workspaceID},${projectID},'personal',${administrator.id},'main',${"a".repeat(40)},${administrator.id})`;
    const attemptID = await native.startWorkspace(projectID, administrator.id, {
      version: 1,
      primaryApp: "forms-preview",
      apps: [
        {
          id: "forms-preview",
          label: "Owned forms",
          command: ["node", "web.js"],
          port: 4321,
          healthPath: "/",
        },
      ],
    });
    const owned = { attemptID };
    const [binding] = await database.client<{ actorUID: string; created: boolean }[]>`
      SELECT actor_uid AS "actorUID",create_attempted_at IS NOT NULL AS created
      FROM factory.substrate_binding WHERE runtime_attempt_id=${attemptID}`;
    expect(binding).toMatchObject({ actorUID: expect.any(String), created: true });
    const creates = native.calls.filter((call) => call.method.startsWith("Create"));
    // Deliberately stale saved readiness must not substitute for transport.
    await database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${attemptID}`;
    try {
      const path = `/runtime/${owned.attemptID}/preview/app/forms-preview/drafts/owned?revision=1&route=%2Fforms%2F`;
      const appOrigin = appRuntimeOrigin(process.base, owned.attemptID, "app");
      const navigation = await fetch(`${process.base}${path}`, {
        headers: {
          host: new URL(appOrigin).host,
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        redirect: "manual",
      });
      expect(navigation.status).toBe(302);
      const issuer = new URL(navigation.headers.get("location") ?? "");
      expect(issuer.origin).toBe(process.base);
      expect(issuer.pathname).toBe("/api/runtime-access");
      expect(issuer.searchParams.get("path")).toBe(path);
      const anonymous = await fetch(issuer, { redirect: "manual" });
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("location")).toBeNull();
      const disconnected = await fetch(issuer, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(disconnected.status).toBe(409);
      expect(disconnected.headers.get("location")).toBeNull();
      for (const channel of ["ide"] as const) {
        const path = `/runtime/${owned.attemptID}/${channel}/`;
        const response = await fetch(
          `${process.base}/api/runtime-access?${new URLSearchParams({ path })}`,
          { headers: { cookie }, redirect: "manual" },
        );
        expect(response.status).toBe(302);
        const destination = new URL(response.headers.get("location") ?? "");
        expect(destination.port).toBe(new URL(process.base).port);
        expect(destination.hostname).toBe(
          `${owned.attemptID.replaceAll("-", "")}-${channel}.runtime.localhost`,
        );
        expect(destination.pathname).toBe(path);
        expect(destination.searchParams.has("factory-grant")).toBe(true);
      }
      // The protocol peer reports a RUNNING original Actor, but has no Parent
      // or Child transport. Native observation alone must not issue an App grant.
      const app = await fetch(
        `${process.base}/api/runtime-access?${new URLSearchParams({ path: `/runtime/${owned.attemptID}/app/` })}`,
        { headers: { cookie }, redirect: "manual" },
      );
      expect(app.status).toBe(409);
      expect(await app.json()).toEqual({ error: "Runtime is not ready" });
      expect(app.headers.get("location")).toBeNull();
      expect(native.calls.some((call) => call.method === "GetActor")).toBe(true);
      expect(native.calls.filter((call) => call.method.startsWith("Create"))).toEqual(creates);
    } finally {
      await process.shutdown();
    }
  } finally {
    await process.shutdown();
    await native?.close();
    await database.client.end({ timeout: 1 });
    await process.dispose();
  }
}, 30_000);
