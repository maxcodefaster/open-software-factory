import { expect, test } from "bun:test";
import type { SystemContract } from "#system-contract/system-contract";
import { createProjectAppPreviews } from "../../apps/factory/src/access/previews";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

test.each(["ready", "paused", "unavailable"] as const)(
  "Development App names come from their admitted revision without compute: %s",
  async (state) => {
    const factory = await factoryProcess();
    const database = factory.connect();
    const owner = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    const project = crypto.randomUUID();
    const workspace = crypto.randomUUID();
    const revision = "a".repeat(40);
    const calls: string[] = [];
    let sourceUnavailable = state === "unavailable";
    const forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.method).toBe("GET");
        const url = new URL(request.url);
        calls.push(url.pathname + url.search);
        expect(url.pathname).toBe("/api/v1/repos/owned/app/contents/.factory/system.json");
        expect(url.searchParams.get("ref")).toBe(revision);
        if (sourceUnavailable) return new Response(null, { status: 503 });
        return Response.json({
          encoding: "base64",
          sha: "b".repeat(40),
          content: Buffer.from(
            JSON.stringify({
              version: 1,
              primaryApp: "website",
              apps: [
                {
                  id: "website",
                  label: "Declared website",
                  command: ["node", "web.mjs"],
                  port: 4321,
                  healthPath: "/",
                },
                {
                  id: "editor",
                  label: "Declared visual editor",
                  command: ["node", "editor.mjs"],
                  port: 3002,
                  healthPath: "/",
                },
              ],
            }),
          ).toString("base64"),
        });
      },
    });
    const previous = {
      FACTORY_FORGEJO_API_URL: process.env["FACTORY_FORGEJO_API_URL"],
      FACTORY_FORGEJO_PUBLIC_URL: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
      FACTORY_FORGEJO_TOKEN: process.env["FACTORY_FORGEJO_TOKEN"],
      FACTORY_FORGEJO_OWNER: process.env["FACTORY_FORGEJO_OWNER"],
    };
    try {
      process.env["FACTORY_FORGEJO_API_URL"] = `${forge.url}api/v1/`;
      process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://owned-app-preview.invalid";
      process.env["FACTORY_FORGEJO_TOKEN"] = "owned-preview-label-fixture";
      process.env["FACTORY_FORGEJO_OWNER"] = "owned";
      for (const id of [owner, stranger])
        await database.client`INSERT INTO auth."user"(id,name,email)
          VALUES(${id},'Mara',${`${id}@factory.local`})`;
      await database.client`INSERT INTO factory.project(
        id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${project},${`labels-${project}`},'Owned App labels',${`${forge.url}owned/app.git`},
          'main','.factory/actor-template.json',${owner})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${owner},'developer',${owner})`;
      await database.client`INSERT INTO factory.development_workspace(
        id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        VALUES(${workspace},${project},'personal',${owner},'main',${revision},${owner})`;
      async function declaredAttempt(workspaceID: string, createdBy: string, paused = false) {
        const id = await recordUncreatedWorkspaceAttempt(database, {
          workspaceID,
          createdBy,
          generation: 1,
          parentHash: "c".repeat(64),
          childHash: "d".repeat(64),
          connectorURL: "wss://owned-app-preview.invalid/internal/runtime-connect",
        });
        await database.client`UPDATE factory.runtime_attempt
          SET state=${paused ? "paused" : "ready"},declared_apps='["app","app-editor"]'::jsonb
          WHERE id=${id}`;
        return id;
      }
      const attempt = await declaredAttempt(workspace, owner, state === "paused");
      const attempts: string[] = [attempt];
      if (state === "unavailable") {
        // More than one read batch must still share the same failed lookup.
        for (let index = 0; index < 5; index++) {
          const other = crypto.randomUUID();
          const otherWorkspace = crypto.randomUUID();
          await database.client`INSERT INTO auth."user"(id,name,email)
            VALUES(${other},'Mara',${`${other}@factory.local`})`;
          await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
            VALUES(${project},${other},'developer',${owner})`;
          await database.client`INSERT INTO factory.development_workspace(
            id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
            VALUES(${otherWorkspace},${project},'personal',${other},'main',${revision},${other})`;
          const otherAttempt = await declaredAttempt(otherWorkspace, other);
          attempts.push(otherAttempt);
          // Personal Previews are private. This batch deliberately includes only invited readers.
          await createWorkspaceSharing(database, () => {}).decide(other, {
            commandID: crypto.randomUUID(),
            workspaceID: otherWorkspace,
            userID: owner,
            permission: "observe",
            expectedVersion: 0,
          });
        }
      }
      const previews = createProjectAppPreviews(database, () => {
        throw new Error("Declared App names must not start or require a Connector");
      });
      await expect(previews(project, stranger)).rejects.toThrow("Project not found");
      expect(calls).toEqual([]);
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${stranger},'developer',${owner})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${stranger})`;
      expect(await previews(project, stranger)).toEqual([]);
      expect(calls).toEqual([]);
      const first = await previews(project, owner);
      expect(first.map((app) => [app.channel, app.label])).toEqual(
        state === "unavailable"
          ? attempts.flatMap(() => [
              ["app", "App · Mara"],
              ["app-editor", "editor · Mara"],
            ])
          : [
              ["app", "Declared website · Mara"],
              ["app-editor", "Declared visual editor · Mara"],
            ],
      );
      expect(
        first.every((app) => attempts.includes(app.attemptID ?? "") && app.projectID === project),
      ).toBe(true);
      expect(calls).toHaveLength(1);
      if (state !== "unavailable") {
        expect(await previews(project, owner)).toEqual(first);
        expect(calls).toHaveLength(1);
      } else {
        sourceUnavailable = false;
        const recovered = await previews(project, owner);
        expect(recovered.map((app) => [app.channel, app.label])).toEqual(
          attempts.flatMap(() => [
            ["app", "Declared website · Mara"],
            ["app-editor", "Declared visual editor · Mara"],
          ]),
        );
        expect(calls).toHaveLength(2);
      }
      if (state !== "unavailable") {
        const sharing = createWorkspaceSharing(database, () => {});
        const decide = (permission: "observe" | null, expectedVersion: number) =>
          sharing.decide(owner, {
            commandID: crypto.randomUUID(),
            workspaceID: workspace,
            userID: stranger,
            permission,
            expectedVersion,
          });
        await decide("observe", 0);
        expect(await previews(project, stranger)).toEqual(first);
        await database.client`DELETE FROM factory.administrator WHERE user_id=${stranger}`;
        await database.client`UPDATE factory.project_membership SET role='product-contributor'
          WHERE project_id=${project} AND user_id=${stranger}`;
        expect(await previews(project, stranger)).toEqual([]);
        await database.client`UPDATE factory.project_membership SET role='developer'
          WHERE project_id=${project} AND user_id=${stranger}`;
        await decide(null, 1);
        expect(await previews(project, stranger)).toEqual([]);
        expect(calls).toHaveLength(1);
      }
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${project}`,
      ).toHaveLength(0);
      const [retained] = await database.client<{ state: string; revision: string }[]>`
        SELECT state,revision FROM factory.runtime_attempt WHERE id=${attempt}`;
      expect(retained).toEqual({ state: state === "paused" ? "paused" : "ready", revision });
    } finally {
      for (const [name, value] of Object.entries(previous))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      forge.stop(true);
      await database.client.end({ timeout: 2 });
      await factory.dispose();
    }
  },
  60_000,
);

test.each([
  "unconfigured",
  "configuring",
  "first-open",
  "not-started",
  "stopped",
  "failed",
  "starting",
  "ready",
  "paused",
] as const)(
  "declared Project Apps are discoverable without commissioning compute: %s",
  async (state) => {
    const factory = await factoryProcess();
    const database = factory.connect();
    const owner = crypto.randomUUID();
    const contributor = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    const project = crypto.randomUUID();
    let attempt: string | null = null;
    let native: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
    const revision = "a".repeat(40);
    const contract: SystemContract = {
      version: 1,
      primaryApp: "web",
      apps: ["web", "forms-web", "forms-api", "forms-admin"].map((id, index) => ({
        id,
        label: ["Website", "Forms editor", "Forms API", "Forms administration"][index] ?? id,
        command: ["node", "dev.mjs"],
        port: 4300 + index,
        healthPath: "/",
      })),
    };
    const calls: string[] = [];
    const forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer owned-preview-fixture");
        const url = new URL(request.url);
        calls.push(url.pathname + url.search);
        if (url.pathname === "/api/v1/repos/owned/acme/branches/main")
          return Response.json({ name: "main", commit: { id: revision } });
        if (url.pathname === "/api/v1/repos/owned/acme/contents/.factory/system.json") {
          if (state === "unconfigured" || state === "configuring")
            return Response.json({ message: "Configuration is not confirmed" }, { status: 404 });
          expect(url.searchParams.get("ref")).toBe(revision);
          return Response.json({
            encoding: "base64",
            sha: "b".repeat(40),
            content: Buffer.from(JSON.stringify(contract)).toString("base64"),
          });
        }
        return new Response("Unexpected fixture request", { status: 404 });
      },
    });
    const previous = {
      FACTORY_FORGEJO_API_URL: process.env["FACTORY_FORGEJO_API_URL"],
      FACTORY_FORGEJO_PUBLIC_URL: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
      FACTORY_FORGEJO_TOKEN: process.env["FACTORY_FORGEJO_TOKEN"],
      FACTORY_FORGEJO_OWNER: process.env["FACTORY_FORGEJO_OWNER"],
    };
    try {
      process.env["FACTORY_FORGEJO_API_URL"] = `${forge.url}api/v1/`;
      process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://owned-app-preview.invalid";
      process.env["FACTORY_FORGEJO_TOKEN"] = "owned-preview-fixture";
      process.env["FACTORY_FORGEJO_OWNER"] = "owned";
      for (const id of [owner, contributor, stranger])
        await database.client`INSERT INTO auth."user"(id,name,email)
          VALUES(${id},'Owned preview reader',${`${id}@factory.local`})`;
      await database.client`INSERT INTO factory.project(
        id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${project},${`apps-${project}`},'Owned ACME Preview',
          'https://owned-app-preview.invalid/owned/acme.git','main','.factory/actor-template.json',${owner})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${owner},'developer',${owner}),
          (${project},${contributor},'product-contributor',${owner})`;
      if (state !== "unconfigured")
        await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
          VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${project},${`projects.setup_readiness:${project}:configuration`},${state === "configuring" ? "pending" : "ready"},${JSON.stringify({ task: "configuration", commandId: crypto.randomUUID() })}::jsonb,${owner},CASE WHEN ${state === "configuring"} THEN NULL ELSE now() END)`;
      const hasAttempt = !["unconfigured", "configuring", "first-open", "not-started"].includes(
        state,
      );
      if (state !== "first-open")
        await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
          VALUES(${crypto.randomUUID()},'delivery.staging_preview','project',${project},
            ${`delivery.staging_preview:${project}`},'pending',
            ${JSON.stringify({ projectId: project, revision, runtimeAttemptId: null })}::jsonb)`;
      if (hasAttempt) {
        native = await nativeJobsFixture(database, project, contract);
        attempt = await native.startStaging(owner);
        await database.client`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${attempt}`;
      }
      const nativeCalls = native?.calls.length ?? 0;
      const previews = createProjectAppPreviews(database, () => {
        throw new Error("Declared Apps must not require live Connector channels");
      });
      await expect(previews(project, stranger)).rejects.toThrow("Project not found");
      expect(calls).toEqual([]);
      const first = await previews(project, contributor);
      if (state === "unconfigured" || state === "configuring") {
        expect(first).toEqual([]);
        expect(calls).toEqual([]);
        expect(
          await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${project}`,
        ).toHaveLength(0);
        return;
      }
      expect(first.map((app) => [app.channel, app.label])).toEqual([
        ["app", "Staging · Website"],
        ["app-forms-web", "Staging · Forms editor"],
        ["app-forms-api", "Staging · Forms API"],
        ["app-forms-admin", "Staging · Forms administration"],
      ]);
      for (const app of first) {
        expect(app.projectID).toBe(project);
        if (["starting", "ready", "paused"].includes(state)) {
          if (!attempt) throw Error("The controlled native Staging owner did not bind its Attempt");
          expect(app.attemptID).toBe(attempt);
        } else expect(app.attemptID).toBeUndefined();
      }
      expect(await previews(project, contributor)).toEqual(first);
      expect(calls.filter((path) => path.includes("/contents/"))).toHaveLength(1);
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${project}`,
      ).toHaveLength(hasAttempt ? 1 : 0);
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${project}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT scope_id AS project_id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${project}`,
      ).toHaveLength(state === "first-open" ? 0 : 1);
      if (hasAttempt) {
        const [retained] = await database.client<{ state: string }[]>`
          SELECT state FROM factory.runtime_attempt WHERE id=${attempt}`;
        expect(retained?.state).toBe(state);
      }
      expect(native?.calls.length ?? 0).toBe(nativeCalls);
    } finally {
      await native?.close();
      for (const [name, value] of Object.entries(previous))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      forge.stop(true);
      await database.client.end({ timeout: 2 });
      await factory.dispose();
    }
  },
  60_000,
);
