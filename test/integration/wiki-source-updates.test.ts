import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createWikiSourceUpdates,
  wikiHookSecret,
} from "../../apps/factory/src/knowledge/source-updates";
import { factoryProcess } from "../fixtures/factory-process";

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
  let imagePreparations = 0;
  // A stale caller must not let a signed Wiki push or hook repair commission
  // the retired image producer. This is deliberately not a controller option.
  const retiredProducer = {
    prepareProject: async () => {
      imagePreparations++;
      throw new Error("Factory has no image producer");
    },
  };
  const signingKey = "owned-wiki-hook-key-not-a-real-secret";
  const controller = createWikiSourceUpdates({
    database,
    apiURL: "https://forge.example/api/v1",
    owner: "factory",
    receiverURL: "https://factory.example",
    signingKey,
    ...retiredProducer,
    forge: {
      listPushHooks: async () => hooks,
      createPushHook: async (_repository, targetURL) => {
        expect(
          (
            await database.client`SELECT scope_id AS project_id FROM factory.operation
              WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`
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
      const genID = crypto.randomUUID();
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,completed_at,payload)
        VALUES(${genID},'knowledge.generation','project',${projectID},${`knowledge.generation:${genID}`},NULL,'succeeded',${userID},now(),
          ${JSON.stringify({ id: genID, projectId: projectID, sourceCommitSha: "a".repeat(40), pageCount: null, conflictCount: null, failure: null, createdBy: userID, modelId: null, attemptId: null, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
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
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by) VALUES(${projectID},${`hook-${projectID}`},'Hook fixture','https://forge.example/factory/app.git','main','.factory/actor-template.json',${userID})`;
    await controller.ensure(projectID);
    await controller.ensure(projectID);
    expect(creates).toBe(1);
    const [ready] =
      await database.client`SELECT state AS hook_state, (payload->>'hookId')::bigint AS hook_id
      FROM factory.operation
      WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
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
    await database.client`UPDATE factory.operation
      SET payload=payload || jsonb_build_object('nextAttemptAt', now()-interval '1 second')
      WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
    await controller.drain();
    expect(reconciles).toBe(1);
    let [row] = await database.client`SELECT payload->>'eventVersion' AS event_version,
      payload->>'handledVersion' AS handled_version
      FROM factory.operation
      WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
    expect(Number(row?.["event_version"])).toBe(2);
    expect(Number(row?.["handled_version"])).toBe(2);
    head = "c".repeat(40);
    await controller.receive(request(), projectID);
    await controller.drain();
    await database.client`UPDATE factory.operation
      SET payload=payload || jsonb_build_object('nextAttemptAt', now()-interval '1 second')
      WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
    await controller.drain();
    [row] = await database.client`SELECT payload->>'eventVersion' AS event_version,
      payload->>'handledVersion' AS handled_version
      FROM factory.operation
      WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
    expect(Number(row?.["event_version"])).toBe(3);
    expect(Number(row?.["handled_version"])).toBe(2);
    await controller.repair();
    expect(imagePreparations).toBe(0);
  } finally {
    await controller.drain();
    await database.client.end();
    await owned.dispose();
  }
}, 60_000);

test("Wiki drain retains a newer signed event while acknowledging its captured bigint version", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const projectID = crypto.randomUUID();
  const userID = crypto.randomUUID();
  const commit = "a".repeat(40);
  const signingKey = "owned-wiki-hook-key-not-a-real-secret";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const controller = createWikiSourceUpdates({
    database,
    apiURL: "https://forge.example/api/v1",
    owner: "factory",
    receiverURL: "https://factory.example",
    signingKey,
    forge: {
      listPushHooks: async () => [],
      createPushHook: async () => 7,
      configurePushHook: async (_repository, id) => id,
      getDefaultBranch: async () => ({ name: "main", headSha: commit }),
    },
    reconcile: async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned source author',${`${userID}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectID},${`counter-${projectID}`},'Source counter','https://forge.example/factory/app.git',
        'main','.factory/actor-template.json',${userID})`;
    await controller.ensure(projectID);
    const genID = crypto.randomUUID();
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,completed_at,payload)
      VALUES(${genID},'knowledge.generation','project',${projectID},${`knowledge.generation:${genID}`},NULL,'succeeded',${userID},now(),
        ${JSON.stringify({ id: genID, projectId: projectID, sourceCommitSha: commit, pageCount: null, conflictCount: null, failure: null, createdBy: userID, modelId: null, attemptId: null, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
    await database.client`UPDATE factory.operation
      SET payload=payload || jsonb_build_object(
        'eventVersion', '9007199254740993',
        'handledVersion', '9007199254740992',
        'nextAttemptAt', now()-interval '1 second'
      )
      WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
    const first = controller.drain();
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("The pending source event was not claimed");
      }),
    ]);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: commit,
      repository: { full_name: "factory/app", default_branch: "main" },
    });
    try {
      const response = await controller.receive(
        new Request("https://factory.example", {
          method: "POST",
          body,
          headers: {
            "x-forgejo-event": "push",
            "x-forgejo-signature": createHmac("sha256", wikiHookSecret(signingKey, projectID))
              .update(body)
              .digest("hex"),
          },
        }),
        projectID,
      );
      expect(response.status).toBe(202);
    } finally {
      release.resolve();
    }
    await first;
    const read = async () => {
      const [row] = await database.client<{ event: string; handled: string }[]>`
        SELECT payload->>'eventVersion' AS event, payload->>'handledVersion' AS handled
        FROM factory.operation
        WHERE kind='knowledge.source_update' AND scope_type='project' AND scope_id=${projectID}`;
      return row;
    };
    expect(await read()).toEqual({ event: "9007199254740994", handled: "9007199254740993" });
    await controller.drain();
    expect(await read()).toEqual({ event: "9007199254740994", handled: "9007199254740994" });
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    await controller.drain();
    await database.client.end();
    await owned.dispose();
  }
}, 60_000);
