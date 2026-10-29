import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { factoryProcess } from "../fixtures/factory-process";
import {
  createWikiSourceUpdates,
  wikiHookSecret,
} from "../../apps/factory/src/knowledge/source-updates";

test("Wiki webhook intent recovers ambiguous creates, coalesces signed pushes and fences stale heads", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const projectID = crypto.randomUUID(),
    userID = crypto.randomUUID();
  let hooks: Array<{
    id: number;
    active: boolean;
    events: string[];
    targetURL: string;
    branchFilter: string;
  }> = [];
  let creates = 0,
    head = "a".repeat(40),
    reconciles = 0;
  const signingKey = "owned-wiki-hook-key-not-a-real-secret";
  const controller = createWikiSourceUpdates({
    database,
    apiURL: "https://forge.example/api/v1",
    owner: "factory",
    receiverURL: "https://factory.example",
    signingKey,
    forge: {
      listPushHooks: async () => hooks,
      createPushHook: async (_repository, targetURL) => {
        expect(
          (
            await database.client`SELECT project_id FROM factory.wiki_source_update WHERE project_id=${projectID}`
          ).length,
        ).toBe(1);
        creates++;
        hooks = [{ id: 7, targetURL, active: true, events: ["push"], branchFilter: "main" }];
        throw new Error("Ambiguous transport after creation");
      },
      configurePushHook: async (_repo, id) => id,
      getDefaultBranch: async () => ({ name: "main", headSha: head }),
    },
    reconcile: async () => {
      reconciles++;
      await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,created_by,completed_at) VALUES(${crypto.randomUUID()},${projectID},${"a".repeat(40)},'succeeded',${userID},now())`;
    },
  });
  function request(overrides: object = {}, signature = true) {
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "b".repeat(40),
      repository: { full_name: "factory/app", default_branch: "main" },
      ...overrides,
    });
    return new Request("https://factory.example", {
      method: "POST",
      body,
      headers: {
        "x-forgejo-event": "push",
        "x-forgejo-signature": signature
          ? createHmac("sha256", wikiHookSecret(signingKey, projectID)).update(body).digest("hex")
          : "0".repeat(64),
      },
    });
  }
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Owned source author',${`source-${userID}@factory.local`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`hook-${projectID}`},'Hook fixture','https://forge.example/factory/app.git','main','.devcontainer/devcontainer.json',${userID})`;
    await controller.ensure(projectID);
    await controller.ensure(projectID);
    expect(creates).toBe(1);
    const [ready] =
      await database.client`SELECT hook_state,hook_id FROM factory.wiki_source_update WHERE project_id=${projectID}`;
    expect(ready?.["hook_state"]).toBe("ready");
    expect(Number(ready?.["hook_id"])).toBe(7);
    expect((await controller.receive(request({}, false), projectID)).status).toBe(403);
    expect(
      (
        await controller.receive(
          request({ repository: { full_name: "factory/other", default_branch: "main" } }),
          projectID,
        )
      ).status,
    ).toBe(403);
    expect((await controller.receive(request({ ref: "refs/heads/topic" }), projectID)).status).toBe(
      204,
    );
    expect((await controller.receive(request(), projectID)).status).toBe(202);
    expect((await controller.receive(request(), projectID)).status).toBe(202);
    // Settle receive's expendable wake before advancing the persisted retry time.
    // Otherwise drain() can join the earlier, not-yet-due read instead of this one.
    await controller.drain();
    await database.client`UPDATE factory.wiki_source_update SET next_attempt_at=now()-interval '1 second' WHERE project_id=${projectID}`;
    await controller.drain();
    expect(reconciles).toBe(1);
    let [row] =
      await database.client`SELECT event_version,handled_version FROM factory.wiki_source_update WHERE project_id=${projectID}`;
    expect(Number(row?.["event_version"])).toBe(2);
    expect(Number(row?.["handled_version"])).toBe(2);
    head = "c".repeat(40);
    await controller.receive(request(), projectID);
    await controller.drain();
    await database.client`UPDATE factory.wiki_source_update SET next_attempt_at=now()-interval '1 second' WHERE project_id=${projectID}`;
    await controller.drain();
    [row] =
      await database.client`SELECT event_version,handled_version FROM factory.wiki_source_update WHERE project_id=${projectID}`;
    expect(Number(row?.["event_version"])).toBe(3);
    expect(Number(row?.["handled_version"])).toBe(2);
  } finally {
    await controller.drain();
    await database.client.end();
    await owned.dispose();
  }
}, 60_000);
