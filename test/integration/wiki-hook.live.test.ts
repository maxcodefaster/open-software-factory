import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createForgejoClient } from "#forge/forge";
import { createWikiSourceUpdates } from "../../apps/factory/src/knowledge/source-updates";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test.skipIf(process.env["FACTORY_WIKI_HOOK_LIVE"] !== "1")(
  "real Forgejo push reaches signed durable Wiki admission without image production",
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
    let reconciles = 0;
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
      reconcile: async () => {
        reconciles++;
      },
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
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by) VALUES(${projectID},${name},'Owned live hook',${`http://127.0.0.1:33030/${owner}/${name}.git`},'main','.factory/actor-template.json',${userID})`;
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
            await database.client<Array<{ version: number }>>`
              SELECT (payload->>'eventVersion')::integer AS version
              FROM factory.operation
              WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`
          )[0]?.version,
        (value) => (value ?? 0) > 0,
        "Real signed Forgejo push was not admitted",
        30_000,
      );
      expect(received).toBe(1);
      await controller.drain();
      const before = reconciles;
      await database.client`UPDATE factory.operation
        SET payload=payload || jsonb_build_object('nextAttemptAt', now()-interval '1 second')
        WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
      await controller.drain();
      expect(reconciles).toBe(before + 1);
      const [pending] = await database.client`
        SELECT (payload->>'eventVersion')::integer AS event,
          (payload->>'handledVersion')::integer AS handled,
          (payload->>'nextAttemptAt')::timestamptz > now() AS retry
        FROM factory.operation
        WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
      expect(pending).toEqual({ event: 1, handled: 0, retry: true });
      // Source admission does not authorize inference or start native Actors.
      expect(
        await database.client`SELECT id FROM factory.operation WHERE kind='knowledge.generation' AND scope_type='project' AND scope_id=${projectID}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
      ).toHaveLength(0);
    } finally {
      await listener.stop(true);
      await controller.drain();
      await database.client.end();
      await owned.dispose();
      if (created) await command(`repos/${owner}/${name}`, "DELETE");
    }
  },
  60_000,
);
