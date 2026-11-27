import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type { StoredEnvironment } from "../../apps/factory/src/environments/openbao";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createSetupReadiness } from "../../apps/factory/src/setup/readiness";
import { createSetupService } from "../../apps/factory/src/setup/service";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction } from "../fixtures/server-functions";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";
import { fixtureValue } from "../fixtures/value";

function knowledgeGenerationPayload(input: {
  id: string;
  projectId: string;
  sourceCommitSha: string;
  createdBy: string;
  failure?: string | null;
}) {
  return JSON.stringify({
    id: input.id,
    projectId: input.projectId,
    sourceCommitSha: input.sourceCommitSha,
    pageCount: null,
    conflictCount: null,
    failure: input.failure ?? null,
    createdBy: input.createdBy,
    modelId: null,
    attemptId: null,
    modelConnectionId: null,
    modelConnectionVersion: null,
    progress: null,
  });
}

test("setup service retries read the retained repository kind only within authorized Project scope", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const userID = crypto.randomUUID(),
    outsider = crypto.randomUUID();
  const requested: boolean[] = [];
  const unused = async () => {
    throw new Error("This service projection must not start work");
  };
  type Options = Parameters<typeof createSetupService>[0];
  const service = createSetupService({
    database,
    drafts: {} as Options["drafts"],
    inspection: {} as Options["inspection"],
    readiness: {
      retry: async (_projectID, _userID, _task, starter) => {
        requested.push(starter);
      },
      status: async () => [],
      start: unused,
      recover: unused,
      observeWikiRetry: unused,
      close: async () => {},
    },
  });
  try {
    for (const id of [userID, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned setup reader',${`${id}@setup.test`})`;
    for (const kind of ["starter", "import"] as const) {
      const projectID = crypto.randomUUID();
      await database.client`INSERT INTO factory.project
        (id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`kind-${projectID}`},'Owned kind','https://example.invalid/owned','main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${projectID},${userID},'developer',true,${userID})`;
      await database.client`INSERT INTO factory.operation
        (id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
        VALUES(${crypto.randomUUID()},'projects.repository_intent','project',${projectID},${`projects.repository_intent:${projectID}`},'committed',${JSON.stringify({ setupId: crypto.randomUUID(), name: "Owned kind", slug: `kind-${projectID}`, kind, sourceUrl: "https://example.invalid/owned", credentialKey: null, fingerprint: "a".repeat(64) })}::jsonb,${userID},now())`;
      expect(await service.retryTask(userID, projectID, "hook")).toEqual([]);
      await expect(service.retryTask(outsider, projectID, "hook")).rejects.toThrow(
        "Project not found",
      );
    }
    expect(requested).toEqual([true, false]);
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 30_000);

test("setup coordination leaves a one-connection pool available and joins admitted work before shutdown", async () => {
  const host = await factoryProcess();
  const database = host.connect(1);
  const userID = crypto.randomUUID();
  const projects = [crypto.randomUUID(), crypto.randomUUID()];
  const release = Promise.withResolvers<void>();
  const hooks: string[] = [];
  const coordinator = createSetupReadiness({
    database,
    environments: createEnvironmentController(
      database,
      { configured: true, read: async () => undefined, create: async () => {} },
      "owned-readiness-shutdown",
    ),
    signingKey: "owned-readiness-shutdown",
    protection: async () => {},
    hook: async (projectID) => {
      hooks.push(projectID);
      await release.promise;
    },
    wiki: async () => {
      throw new Error("Owned fixture has no model");
    },
    preview: async () => {
      throw new Error("Unconfirmed imported configuration must not start execution");
    },
  });
  let work: Promise<unknown> | undefined;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned shutdown',${`${userID}@setup.test`})`;
    for (const projectID of projects) {
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`shutdown-${projectID}`},'Owned shutdown','https://example.invalid/owned','main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${projectID},${userID},'developer',true,${userID})`;
    }
    const projectID = fixtureValue(projects[0], "first owned Project");
    const laterProjectID = fixtureValue(projects[1], "later owned Project");
    // Capture failure for cleanup too, so a failed assertion leaves no unjoined work.
    work = coordinator.start(projectID, userID, false).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await eventually(
      async () => hooks.length,
      (count) => count === 1,
      "Setup coordinator exhausted its own task pool",
      2000,
    );
    expect(
      (await coordinator.status(projectID, userID)).find((task) => task.task === "hook"),
    ).toMatchObject({ state: "running" });
    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    expect(coordinator.close()).toBe(coordinator.close());
    await Bun.sleep(10);
    expect(closed).toBe(false);
    await expect(coordinator.start(laterProjectID, userID, false)).rejects.toThrow("shutting down");
    expect(
      (
        await database.client`SELECT id FROM factory.operation WHERE kind='projects.setup_readiness' AND scope_id=${laterProjectID}`
      ).length,
    ).toBe(0);
    release.resolve();
    expect(await work).toBeUndefined();
    await closing;
    expect(closed).toBe(true);
    expect(hooks).toEqual([projectID]);
    expect(
      (await coordinator.status(projectID, userID)).find((task) => task.task === "hook"),
    ).toMatchObject({ state: "ready" });
  } finally {
    release.resolve();
    await work;
    await coordinator.close();
    await database.client.end({ timeout: 1 });
    await host.dispose();
  }
}, 10_000);

test("native setup needs no image producer, separates protected environments and isolates failure and retry", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const projectID = crypto.randomUUID();
  const manager = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const wikiID = crypto.randomUUID();
  const revision = "a".repeat(40);
  const stored = new Map<string, StoredEnvironment>();
  let hooks = 0;
  let wikis = 0;
  const wikiCalls: boolean[] = [];
  let protections = 0;
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  try {
    for (const userID of [manager, contributor])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${userID},'Owned setup',${`${userID}@setup.test`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectID},${`owned-${projectID}`},'Owned setup','https://example.invalid/owned','main','.factory/actor-template.json',${manager})`;
    for (const [userID, role] of [
      [manager, "developer"],
      [contributor, "product-contributor"],
    ])
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${projectID},${fixtureValue(userID, "userID")},${fixtureValue(role, "role")},${userID === manager},${manager})`;
    const environments = createEnvironmentController(
      database,
      {
        configured: true,
        read: async (key) => stored.get(key),
        create: async (key, value) => {
          stored.set(key, value);
        },
      },
      "owned-readiness-secret",
    );
    const input = {
      database,
      environments,
      signingKey: "owned-readiness-secret",
      protection: async () => {
        protections++;
      },
      hook: async () => {
        hooks++;
        if (hooks === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("private diagnostics");
        }
      },
      wiki: async (_projectID: string, _userID: string, automatic: boolean) => {
        wikis++;
        wikiCalls.push(automatic);
        const id = wikis === 1 ? wikiID : crypto.randomUUID();
        await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
          VALUES(${id},'knowledge.generation','project',${projectID},${`knowledge.generation:${id}`},${`knowledge.generation:${projectID}`},'pending',${knowledgeGenerationPayload({ id, projectId: projectID, sourceCommitSha: revision, createdBy: manager })}::text::jsonb,${manager})`;
        return id;
      },
      preview: async () => {
        throw new Error("Native Actor Work preparation failed");
      },
    };
    const coordinator = createSetupReadiness(input);
    const start = coordinator.start(projectID, manager, true);
    await entered.promise;
    // A second process must not mark live work interrupted or duplicate paid work.
    await createSetupReadiness(input).start(projectID, manager, true, true);
    expect(
      (await coordinator.status(projectID, manager)).find((row) => row.task === "hook")?.state,
    ).toBe("running");
    release.resolve();
    await start;
    const rows = await coordinator.status(projectID, manager);
    expect(rows.map((row) => row.task)).toEqual([
      "configuration",
      "development-secrets",
      "hook",
      "main-preview",
      "preview-secrets",
      "protection",
      "wiki",
    ]);
    expect(rows.find((row) => row.task === "configuration")?.state).toBe("ready");
    expect(rows.find((row) => row.task === "hook")?.state).toBe("failed");
    expect(rows.find((row) => row.task === "main-preview")).toMatchObject({
      state: "failed",
      operationID: null,
      failure: "This step needs attention. Other work stays available.",
    });
    expect(JSON.stringify(rows)).not.toContain("private diagnostics");
    expect(hooks).toBe(1);
    expect(wikis).toBe(1);
    expect(stored.size).toBe(2);
    const [development, preview] = [...stored.values()];
    expect(development?.bundle.variables.map((variable) => variable.name)).toEqual([
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
    ]);
    expect(development?.bundle.variables[0]?.value).not.toBe(preview?.bundle.variables[0]?.value);
    for (const environment of [development, preview]) {
      const password = environment?.bundle.variables.find(
        (variable) => variable.name === "POSTGRES_PASSWORD",
      );
      const connection = environment?.bundle.variables.find(
        (variable) => variable.name === "DATABASE_URL",
      );
      expect(password?.value).toMatch(/^[a-f0-9]{64}$/);
      expect(connection).toMatchObject({
        value: `postgresql://app:${password?.value}@127.0.0.1:5432/app`,
        runtime: true,
        verification: true,
      });
      expect(password).toMatchObject({ runtime: true, verification: true });
    }
    const persisted =
      await database.client`SELECT row_to_json(settings) FROM factory.operation settings WHERE kind='environments.environment' AND scope_type='project' AND scope_id=${projectID}`;
    for (const environment of stored.values())
      for (const variable of environment.bundle.variables)
        expect(JSON.stringify(persisted)).not.toContain(variable.value);
    // A changed default is not a migration. Explicit saved settings retain even
    // their previous hostname when the same setup task is retried.
    const savedDevelopment = await environments.get(projectID, manager, "development");
    const retainedURL = "postgresql://app:owned-retained-password@postgres:5432/app";
    await environments.save(projectID, manager, "development", {
      commandID: crypto.randomUUID(),
      version: savedDevelopment.version,
      variables: [
        {
          name: "DATABASE_URL",
          value: retainedURL,
          runtime: true,
          verification: true,
        },
      ],
    });
    const savedVersion = (await environments.get(projectID, manager, "development")).version;
    const savedEntries = stored.size;
    await database.client`UPDATE factory.operation SET state='failed'
      WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:development-secrets`}`;
    await coordinator.retry(projectID, manager, "development-secrets", true);
    expect((await environments.get(projectID, manager, "development")).version).toBe(savedVersion);
    expect(stored.size).toBe(savedEntries);
    expect(
      [...stored.values()].some((value) =>
        value.bundle.variables.some((variable) => variable.value === retainedURL),
      ),
    ).toBe(true);
    await coordinator.retry(projectID, manager, "hook", true);
    expect(hooks).toBe(2);
    expect(wikis).toBe(1);
    expect(wikiCalls).toEqual([true]);
    await database.client`UPDATE factory.operation SET state='failed',active_key=NULL,completed_at=now(),updated_at=now()
      WHERE id=${wikiID} AND kind='knowledge.generation'`;
    await coordinator.retry(projectID, manager, "wiki", true);
    expect(wikiCalls).toEqual([true, false]);
    const retriedWiki = (await coordinator.status(projectID, manager)).find(
      (row) => row.task === "wiki",
    );
    expect(retriedWiki?.operationID).not.toBe(wikiID);
    expect(retriedWiki?.state).toBe("running");
    const importID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${importID},${`owned-${importID}`},'Owned import','https://example.invalid/import','main','.factory/actor-template.json',${manager})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${importID},${manager},'developer',true,${manager})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
      VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${importID},${`projects.setup_readiness:${importID}:configuration`},'ready',${JSON.stringify({ task: "configuration", commandId: crypto.randomUUID() })}::jsonb,${manager},now())`;
    let executions = 0;
    const imported = createSetupReadiness({
      ...input,
      hook: async () => {},
      protection: async () => {},
      requiredVariables: async () => ["API_KEY"],
      wiki: async () => {
        throw new Error("No model");
      },
      preview: async () => {
        executions++;
        throw new Error("Must not start");
      },
    });
    await imported.start(importID, manager, false);
    expect(
      (await imported.status(importID, manager)).find((row) => row.task === "development-secrets")
        ?.state,
    ).toBe("failed");
    expect(executions).toBe(0);
    await environments.save(importID, manager, "development", {
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [
        {
          name: "API_KEY",
          value: "owned-import-secret",
          runtime: true,
          verification: false,
        },
      ],
    });
    await imported.retry(importID, manager, "development-secrets", false);
    expect(
      (await imported.status(importID, manager)).find((row) => row.task === "development-secrets")
        ?.state,
    ).toBe("ready");
    expect(
      (await imported.status(importID, manager)).find((row) => row.task === "preview-secrets")
        ?.state,
    ).toBe("failed");
    expect(executions).toBe(0);
    expect(protections).toBe(1);
    expect(stored.size).toBe(4);
    await expect(coordinator.retry(projectID, contributor, "hook", true)).rejects.toThrow(
      "Manager",
    );
    expect((await coordinator.status(projectID, contributor)).length).toBe(7);
    await database.client`UPDATE factory.operation SET state='succeeded',active_key=NULL,completed_at=now(),updated_at=now(),payload=payload || ${JSON.stringify({ pageCount: 0, conflictCount: 0 })}::text::jsonb WHERE id=${wikiID} AND kind='knowledge.generation'`;
    expect(
      (await coordinator.status(projectID, manager)).find((row) => row.task === "wiki")?.state,
    ).toBe("running");
    await database.client`UPDATE factory.operation SET state='succeeded',active_key=NULL,completed_at=now(),updated_at=now(),payload=payload || ${JSON.stringify({ pageCount: 0, conflictCount: 0 })}::text::jsonb
      WHERE id=${fixtureValue(fixtureValue(retriedWiki, "retriedWiki").operationID, "retriedWiki!.operationID")} AND kind='knowledge.generation'`;
    expect(
      (await coordinator.status(projectID, manager)).find((row) => row.task === "wiki")?.state,
    ).toBe("ready");
    // Unacknowledged work after a genuine restart remains human-retryable.
    await database.client`UPDATE factory.operation SET state='running',result=NULL,completed_at=NULL WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:hook`}`;
    await createSetupReadiness(input).start(projectID, manager, true, true);
    expect(
      (await coordinator.status(projectID, manager)).find((row) => row.task === "hook")?.state,
    ).toBe("failed");
    expect(hooks).toBe(2);
    expect(wikis).toBe(2);
  } finally {
    release.resolve();
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 30_000);

test("setup readiness joins only its exact Project operations and fences Wiki retry replacement", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const foreignProjectID = crypto.randomUUID();
  const originalWiki = crypto.randomUUID();
  const retriedWiki = crypto.randomUUID();
  const foreignWiki = crypto.randomUUID();
  const attempts: string[] = [];
  const recoveredHooks: string[] = [];
  const coordinator = createSetupReadiness({
    database,
    environments: createEnvironmentController(
      database,
      { configured: false, read: async () => undefined, create: async () => {} },
      "owned-operation-joins",
    ),
    signingKey: "owned-operation-joins",
    protection: async () => {},
    hook: async (id) => {
      recoveredHooks.push(id);
    },
    wiki: async () => {
      throw new Error("Observation must not commission inference");
    },
    preview: async () => {
      throw new Error("Observation must not start execution");
    },
  });
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned operation joins',${`${userID}@setup.test`})`;
    for (const id of [projectID, foreignProjectID]) {
      await database.client`INSERT INTO factory.project
        (id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${id},${`joins-${id}`},'Owned joins','https://example.invalid/owned','main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership
        (project_id,user_id,role,manage_project,updated_by)
        VALUES(${id},${userID},'developer',true,${userID})`;
      const workspaceID = crypto.randomUUID();
      await database.client`INSERT INTO factory.development_workspace
        (id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
        VALUES(${workspaceID},${id},'personal',${userID},'main',${"a".repeat(40)},${userID})`;
      attempts.push(
        await recordUncreatedWorkspaceAttempt(database, {
          workspaceID,
          generation: 1,
          createdBy: userID,
          parentHash: "1".repeat(64),
          childHash: "2".repeat(64),
          connectorURL: "wss://factory.invalid/internal/runtime-connect",
        }),
      );
    }
    await database.client`INSERT INTO factory.operation
      (id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by,completed_at)
      VALUES(${originalWiki},'knowledge.generation','project',${projectID},${`knowledge.generation:${originalWiki}`},NULL,'failed',${knowledgeGenerationPayload({ id: originalWiki, projectId: projectID, sourceCommitSha: "a".repeat(40), createdBy: userID })}::text::jsonb,${userID},now()),
        (${foreignWiki},'knowledge.generation','project',${foreignProjectID},${`knowledge.generation:${foreignWiki}`},NULL,'succeeded',${knowledgeGenerationPayload({ id: foreignWiki, projectId: foreignProjectID, sourceCommitSha: "a".repeat(40), createdBy: userID })}::text::jsonb,${userID},now())`;
    await database.client`INSERT INTO factory.operation
      (id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${retriedWiki},'knowledge.generation','project',${projectID},${`knowledge.generation:${retriedWiki}`},${`knowledge.generation:${projectID}`},'running',${knowledgeGenerationPayload({ id: retriedWiki, projectId: projectID, sourceCommitSha: "a".repeat(40), createdBy: userID })}::text::jsonb,${userID})`;
    const ownAttempt = fixtureValue(attempts[0], "own attempt");
    const foreignAttempt = fixtureValue(attempts[1], "foreign attempt");
    for (const [task, operationID] of [
      ["wiki", originalWiki],
      ["main-preview", foreignAttempt],
    ]) {
      const taskName = fixtureValue(task, "task");
      await database.client`INSERT INTO factory.operation
        (id,kind,scope_type,scope_id,idempotency_key,state,payload,result,created_by)
        VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${projectID},${`projects.setup_readiness:${projectID}:${taskName}`},'running',${JSON.stringify({ task: taskName, commandId: crypto.randomUUID() })}::jsonb,${JSON.stringify({ operationId: fixtureValue(operationID, "operation") })}::jsonb,${userID})`;
    }
    const retained = async () =>
      database.client`SELECT state,result->>'operationId' AS operation_id,error AS failure FROM factory.operation
        WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:wiki`}`;
    const before = await retained();
    await coordinator.observeWikiRetry(projectID, userID, foreignWiki);
    expect([...(await retained())]).toEqual([...before]);
    await coordinator.observeWikiRetry(projectID, userID, retriedWiki);
    await coordinator.observeWikiRetry(projectID, userID, originalWiki);
    const observed = await coordinator.status(projectID, userID);
    expect(observed.map((task) => task.task)).toEqual(["main-preview", "wiki"]);
    expect(observed.every((task) => task.state === "running")).toBe(true);
    expect(observed.find((task) => task.task === "wiki")?.operationID).toBe(retriedWiki);
    await database.client`UPDATE factory.operation
      SET state='failed' WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:wiki`}`;
    await coordinator.observeWikiRetry(projectID, userID, originalWiki);
    expect((await retained())[0]).toMatchObject({
      state: "failed",
      operation_id: originalWiki,
      failure: "Wiki generation needs retry.",
    });
    await coordinator.observeWikiRetry(projectID, userID, retriedWiki);
    await database.client`UPDATE factory.operation
      SET state='succeeded',active_key=NULL,completed_at=now(),updated_at=now()
      WHERE id=${retriedWiki} AND kind='knowledge.generation'`;
    await coordinator.status(projectID, userID);
    await coordinator.observeWikiRetry(projectID, userID, originalWiki);
    expect(
      (await coordinator.status(projectID, userID)).find((task) => task.task === "wiki"),
    ).toMatchObject({ state: "ready", operationID: retriedWiki, failure: null });
    await database.client`UPDATE factory.operation
      SET result=${JSON.stringify({ operationId: ownAttempt })}::jsonb WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:main-preview`}`;
    for (const state of ["ready", "failed", "cleanup-failed", "stopped", "starting"]) {
      await database.client`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${ownAttempt}`;
      await database.client`UPDATE factory.operation
        SET state='running',completed_at=NULL WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:main-preview`}`;
      const failed = ["failed", "cleanup-failed", "stopped"].includes(state);
      expect(
        (await coordinator.status(projectID, userID)).find((task) => task.task === "main-preview"),
      ).toMatchObject({
        state: state === "ready" ? "ready" : failed ? "failed" : "running",
        operationID: ownAttempt,
        failure: failed ? "Main-Preview startup needs retry." : null,
      });
    }
    const unrelatedID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project
      (id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${unrelatedID},${`unrelated-${unrelatedID}`},'Unrelated','https://example.invalid/other','main','.factory/actor-template.json',${userID})`;
    await database.client`INSERT INTO factory.operation
      (id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by,completed_at)
      VALUES(${crypto.randomUUID()},'projects.repository_intent','project',${foreignProjectID},${`projects.repository_intent:${foreignProjectID}`},'committed',${JSON.stringify({ setupId: crypto.randomUUID(), name: "Owned recovery", slug: `recovery-${foreignProjectID}`, kind: "import", sourceUrl: "https://github.com/owned/import", credentialKey: null, fingerprint: "5".repeat(64) })}::jsonb,${userID},now())`;
    await coordinator.recover();
    await coordinator.close();
    expect(recoveredHooks.sort()).toEqual([projectID, foreignProjectID].sort());
    expect(
      (
        await database.client`SELECT id FROM factory.operation WHERE kind='projects.setup_readiness' AND scope_id=${unrelatedID}`
      ).length,
    ).toBe(0);
  } finally {
    await coordinator.close();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 20_000);

test.each(["failed", "running"] as const)(
  "an explicit Wiki retry hands failed setup readiness to that exact generation without commissioning another, observed=%s",
  async (setupState) => {
    const forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/repos/owned-process-fixture/fixture")
          return Response.json({
            name: "fixture",
            owner: { login: "owned-process-fixture" },
            default_branch: "main",
          });
        if (path.endsWith("/branches/main"))
          return Response.json({ name: "main", commit: { id: "a".repeat(40) } });
        if (path.includes("/git/trees/"))
          return Response.json({ tree: [], truncated: false, total_count: 0 });
        return new Response(null, { status: 404 });
      },
    });
    const forgeBase = `http://127.0.0.1:${forge.port}`;
    const fixture = await factoryProcess(undefined, {
      FACTORY_FORGEJO_API_URL: `${forgeBase}/api/v1/`,
    });
    const database = fixture.connect();
    const projectID = crypto.randomUUID();
    const original = crypto.randomUUID(),
      retried = crypto.randomUUID();
    const email = `wiki-retry-${projectID}@factory.invalid`;
    const password = "owned-readiness-password-not-a-secret";
    const request = (path: string, cookie: string, body?: unknown) =>
      fetch(`${fixture.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      await fixture.start();
      const admin = await fixture.signIn();
      const create = await serverCall(
        callFactoryFunction(
          fixture.base,
          "createAccount",
          [
            {
              name: "Wiki retry Developer",
              email,
              password,
            },
          ],
          { cookie: admin },
        ),
      );
      const { id: userID } = create;
      const signIn = await request("/api/auth/sign-in/email", "", { email, password });
      expect(signIn.ok).toBe(true);
      const cookie = signIn.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectID},${`wiki-retry-${projectID}`},'Wiki retry fixture',${`${forgeBase}/owned-process-fixture/fixture`},'main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${userID},'developer',false,${userID})`;
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,error,payload,created_by,completed_at)
      VALUES(${original},'knowledge.generation','project',${projectID},${`knowledge.generation:${original}`},NULL,'failed','Original retained failure',${knowledgeGenerationPayload({ id: original, projectId: projectID, sourceCommitSha: "a".repeat(40), createdBy: userID, failure: "Original retained failure" })}::text::jsonb,${userID},now())`;
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,result,error,created_by)
      VALUES(${crypto.randomUUID()},'projects.setup_readiness','project',${projectID},${`projects.setup_readiness:${projectID}:wiki`},${setupState},${JSON.stringify({ task: "wiki", commandId: crypto.randomUUID() })}::jsonb,${JSON.stringify({ operationId: original })}::jsonb,'Wiki generation needs retry.',${userID})`;
      // Already admitted work is returned by Generate. No source or provider request
      // is needed to test the authenticated retry's exact operation handoff.
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${retried},'knowledge.generation','project',${projectID},${`knowledge.generation:${retried}`},${`knowledge.generation:${projectID}`},'running',${knowledgeGenerationPayload({ id: retried, projectId: projectID, sourceCommitSha: "a".repeat(40), createdBy: userID })}::text::jsonb,${userID})`;
      const status = async () => {
        const response = await serverCall(
          callFactoryFunction(fixture.base, "getSetupReadiness", [projectID], { cookie }),
        );
        const row = response.find((task) => task.task === "wiki");
        if (!row) throw new Error("Owned Wiki preparation status missing");
        return row;
      };
      if (setupState === "failed") expect((await status()).operationID).toBe(original);
      else {
        const [unobserved] = await database.client<
          Array<{ state: string }>
        >`SELECT state FROM factory.operation
        WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:wiki`}`;
        expect(unobserved?.state).toBe("running");
      }
      const retry = await serverCall(
        callFactoryFunction(fixture.base, "generateKnowledge", [projectID], { cookie }),
      );
      expect(retry?.id).toBe(retried);
      const linked = await status();
      expect(linked.operationID).toBe(retried);
      expect(linked.state).toBe("running");
      await database.client`UPDATE factory.operation SET state='succeeded',active_key=NULL,completed_at=now(),updated_at=now(),
      payload=payload || ${JSON.stringify({ pageCount: 0, conflictCount: 0 })}::text::jsonb WHERE id=${retried} AND kind='knowledge.generation'`;
      const ready = await status();
      expect(ready.state).toBe("ready");
      expect(ready.failure).toBeNull();
      const [retained] = await database.client<
        Array<{ state: string; failure: string }>
      >`SELECT state,error AS failure FROM factory.operation WHERE id=${original} AND kind='knowledge.generation'`;
      expect(retained?.state).toBe("failed");
      expect(retained?.failure).toBe("Original retained failure");
      expect(
        (
          await database.client`SELECT id FROM factory.operation WHERE kind='knowledge.generation' AND scope_type='project' AND scope_id=${projectID}`
        ).length,
      ).toBe(2);
      // Later unrelated generations never replace the explicitly linked operation.
      const laterID = crypto.randomUUID();
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by,completed_at)
      VALUES(${laterID},'knowledge.generation','project',${projectID},${`knowledge.generation:${laterID}`},NULL,'failed',${knowledgeGenerationPayload({ id: laterID, projectId: projectID, sourceCommitSha: "b".repeat(40), createdBy: userID })}::text::jsonb,${userID},now())`;
      expect((await status()).operationID).toBe(retried);
      expect((await status()).state).toBe("ready");
    } finally {
      await database.client.end({ timeout: 2 });
      await fixture.dispose();
      await forge.stop(true);
    }
  },
  30_000,
);
