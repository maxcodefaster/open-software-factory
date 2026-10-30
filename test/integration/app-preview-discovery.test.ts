import { expect, test } from "bun:test";
import { createProjectAppPreviews } from "../../apps/factory/src/access/previews";
import { factoryProcess } from "../fixtures/factory-process";

test.each([
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
    const attempt = crypto.randomUUID();
    const revision = "a".repeat(40);
    const contract = {
      version: 1,
      primaryApp: "web",
      apps: ["web", "forms-web", "forms-api", "forms-admin"].map((id, index) => ({
        id,
        label: ["Website", "Forms editor", "Forms API", "Forms administration"][index],
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
        if (url.pathname === "/api/v1/repos/owned/adac/branches/main")
          return Response.json({ name: "main", commit: { id: revision } });
        if (url.pathname === "/api/v1/repos/owned/adac/contents/.factory/system.json") {
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
      FACTORY_FORGEJO_TOKEN: process.env["FACTORY_FORGEJO_TOKEN"],
      FACTORY_FORGEJO_OWNER: process.env["FACTORY_FORGEJO_OWNER"],
    };
    try {
      process.env["FACTORY_FORGEJO_API_URL"] = `${forge.url}api/v1/`;
      process.env["FACTORY_FORGEJO_TOKEN"] = "owned-preview-fixture";
      process.env["FACTORY_FORGEJO_OWNER"] = "owned";
      for (const id of [owner, contributor, stranger])
        await database.client`INSERT INTO auth."user"(id,name,email)
          VALUES(${id},'Owned preview reader',${`${id}@factory.local`})`;
      await database.client`INSERT INTO factory.project(
        id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${project},${`apps-${project}`},'Owned ADAC Preview',
          ${`${forge.url}owned/adac.git`},'main','.devcontainer/devcontainer.json',${owner})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${owner},'developer',${owner}),
          (${project},${contributor},'product-contributor',${owner})`;
      await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,state,command_id)
        VALUES(${project},'configuration','ready',${crypto.randomUUID()})`;
      const hasAttempt = !["first-open", "not-started"].includes(state);
      if (hasAttempt)
        await database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,isolated_kind,generation,revision,state,
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by,declared_apps)
          VALUES(${attempt},${project},'staging',1,${revision},${state},
            ${"c".repeat(64)},${"d".repeat(64)},now(),${owner},
            ${JSON.stringify(["app", "app-forms-web", "app-forms-api", "app-forms-admin"])}::text::jsonb)`;
      if (state !== "first-open")
        await database.client`INSERT INTO factory.staging_preview(project_id,revision,runtime_attempt_id)
          VALUES(${project},${revision},${hasAttempt ? attempt : null})`;
      const previews = createProjectAppPreviews(database, () => {
        throw new Error("Declared Apps must not require live Connector channels");
      });
      await expect(previews(project, stranger)).rejects.toThrow("Project not found");
      expect(calls).toEqual([]);
      const first = await previews(project, contributor);
      expect(first.map((app) => [app.channel, app.label])).toEqual([
        ["app", "Staging · Website"],
        ["app-forms-web", "Staging · Forms editor"],
        ["app-forms-api", "Staging · Forms API"],
        ["app-forms-admin", "Staging · Forms administration"],
      ]);
      for (const app of first) {
        expect(app.projectID).toBe(project);
        if (["starting", "ready", "paused"].includes(state)) expect(app.attemptID).toBe(attempt);
        else expect(app.attemptID).toBeUndefined();
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
        await database.client`SELECT project_id FROM factory.staging_preview WHERE project_id=${project}`,
      ).toHaveLength(state === "first-open" ? 0 : 1);
      if (hasAttempt) {
        const [retained] = await database.client<{ state: string }[]>`
          SELECT state FROM factory.runtime_attempt WHERE id=${attempt}`;
        expect(retained?.state).toBe(state);
      }
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
