import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { createWikiSourceUpdates } from "../../apps/factory/src/knowledge/source-updates";
import { createProjectPreparation } from "../../apps/factory/src/runtime/project-preparation";

test.skipIf(process.env["FACTORY_WIKI_HOOK_LIVE"] !== "1")(
  "real Forgejo push reaches signed durable Wiki admission without Click-Ops",
  async () => {
    const owned = await factoryProcess();
    const database = owned.connect();
    const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const apiURL = "http://127.0.0.1:33030/api/v1/",
      owner = "factory-mutation";
    const name = `wiki-hook-${crypto.randomUUID().slice(0, 8)}`,
      projectID = crypto.randomUUID(),
      userID = crypto.randomUUID();
    let created = false;
    const forge = createForgejoClient({ apiURL, token });
    const preparation = createProjectPreparation({
      database,
      head: async () => (await forge.getDefaultBranch({ owner, name })).headSha,
      start: async () => {},
    });
    let controller: ReturnType<typeof createWikiSourceUpdates>;
    const listener = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch: (request) => controller.receive(request, projectID),
    });
    controller = createWikiSourceUpdates({
      database,
      forge,
      apiURL,
      owner,
      receiverURL: `http://host.docker.internal:${listener.port}`,
      signingKey: "owned-live-hook-signing-key-not-production",
      reconcile: async () => {},
      prepareProject: preparation.ensure,
    });
    async function command(path: string, method: string, body?: unknown) {
      const response = await fetch(`${apiURL}${path}`, {
        method,
        headers: { authorization: `token ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`Owned Forgejo hook ${method} HTTP ${response.status}`);
      return response.status === 204 ? null : response.json();
    }
    try {
      await command("user/repos", "POST", {
        name,
        private: true,
        auto_init: true,
        default_branch: "main",
      });
      created = true;
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Owned hook author',${`hook-${userID}@factory.local`},true)`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${name},'Owned live hook',${`http://127.0.0.1:33030/${owner}/${name}.git`},'main','.devcontainer/devcontainer.json',${userID})`;
      await controller.ensure(projectID);
      await controller.ensure(projectID);
      expect((await forge.listPushHooks({ owner, name })).length).toBe(1);
      await command(`repos/${owner}/${name}/contents/docs/hook-proof.md`, "POST", {
        branch: "main",
        message: "Owned push proof",
        content: Buffer.from("# Hook proof\n\nA real default branch push.").toString("base64"),
      });
      const received = await eventually(
        async () =>
          (
            await database.client<
              Array<{ version: number }>
            >`SELECT event_version::integer AS version FROM factory.wiki_source_update WHERE project_id=${projectID}`
          )[0]?.version,
        (value) => (value ?? 0) > 0,
        "Real signed Forgejo push was not admitted",
        30_000,
      );
      expect(received).toBe(1);
      const head = (await forge.getDefaultBranch({ owner, name })).headSha;
      await eventually(
        () =>
          database.client`SELECT id FROM factory.project_image_preparation WHERE project_id=${projectID} AND revision=${head}`,
        (rows) => rows.length === 2,
        "Signed push did not admit both environment preparations",
      );
      expect(
        await database.client`SELECT id FROM factory.project_image_preparation WHERE project_id=${projectID} AND revision=${head}`,
      ).toHaveLength(2);
    } finally {
      await listener.stop(true);
      await database.client.end();
      await owned.dispose();
      if (created) await command(`repos/${owner}/${name}`, "DELETE");
    }
  },
  60_000,
);
