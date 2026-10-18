import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type { StoredEnvironment } from "../../apps/factory/src/environments/openbao";
import { createSetupReadiness } from "../../apps/factory/src/setup/readiness";
import { factoryProcess } from "../fixtures/factory-process";

test("setup readiness separates protected environments, observes exact work and isolates failure and retry", async () => {
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
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`owned-${projectID}`},'Owned setup','https://example.invalid/owned','main','.devcontainer/devcontainer.json',${manager})`;
    for (const [userID, role] of [
      [manager, "developer"],
      [contributor, "product-contributor"],
    ])
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${projectID},${userID!},${role!},${userID === manager},${manager})`;
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
        await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
          VALUES(${id},${projectID},${revision},${manager})`;
        return id;
      },
      prepare: async () => {
        const result = { development: crypto.randomUUID(), preview: crypto.randomUUID() };
        for (const [id, environment] of [
          [result.development, "development"],
          [result.preview, "main-preview"],
        ])
          await database.client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version)
            VALUES(${id!},${projectID},${environment!},${revision},1)`;
        return result;
      },
      preview: async () => {
        throw new Error("runtime unavailable");
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
    expect(rows).toHaveLength(9);
    expect(rows.find((row) => row.task === "configuration")?.state).toBe("ready");
    expect(rows.find((row) => row.task === "hook")?.state).toBe("failed");
    expect(rows.find((row) => row.task === "development")?.state).toBe("running");
    expect(rows.find((row) => row.task === "main-preview")?.state).toBe("failed");
    expect(JSON.stringify(rows)).not.toContain("private diagnostics");
    expect(stored.size).toBe(2);
    const [development, preview] = [...stored.values()];
    expect(development?.bundle.variables.map((variable) => variable.name)).toEqual([
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
    ]);
    expect(development?.bundle.variables[0]?.value).not.toBe(preview?.bundle.variables[0]?.value);
    const persisted =
      await database.client`SELECT row_to_json(settings) FROM factory.project_environment settings WHERE project_id=${projectID}`;
    for (const environment of stored.values())
      for (const variable of environment.bundle.variables)
        expect(JSON.stringify(persisted)).not.toContain(variable.value);
    await coordinator.retry(projectID, manager, "hook", true);
    expect(hooks).toBe(2);
    expect(wikis).toBe(1);
    expect(wikiCalls).toEqual([true]);
    await database.client`UPDATE factory.knowledge_generation SET state='failed',completed_at=now()
      WHERE id=${wikiID}`;
    await coordinator.retry(projectID, manager, "wiki", true);
    expect(wikiCalls).toEqual([true, false]);
    const retriedWiki = (await coordinator.status(projectID, manager)).find(
      (row) => row.task === "wiki",
    );
    expect(retriedWiki?.operationID).not.toBe(wikiID);
    expect(retriedWiki?.state).toBe("running");
    const importID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${importID},${`owned-${importID}`},'Owned import','https://example.invalid/import','main','.devcontainer/devcontainer.json',${manager})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${importID},${manager},'developer',true,${manager})`;
    await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,command_id,state)
      VALUES(${importID},'configuration',${crypto.randomUUID()},'ready')`;
    let executions = 0;
    const imported = createSetupReadiness({
      ...input,
      hook: async () => {},
      protection: async () => {},
      requiredVariables: async () => ["API_KEY"],
      wiki: async () => {
        throw new Error("No model");
      },
      prepare: async () => {
        executions++;
        throw new Error("Must not start");
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
          build: false,
          verification: false,
        },
      ],
      registries: [],
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
    expect(stored.size).toBe(3);
    await expect(coordinator.retry(projectID, contributor, "hook", true)).rejects.toThrow(
      "Manager",
    );
    expect((await coordinator.status(projectID, contributor)).length).toBe(9);
    await database.client`UPDATE factory.knowledge_generation SET state='succeeded',completed_at=now(),page_count=0,conflict_count=0 WHERE id=${wikiID}`;
    expect(
      (await coordinator.status(projectID, manager)).find((row) => row.task === "wiki")?.state,
    ).toBe("running");
    await database.client`UPDATE factory.knowledge_generation SET state='succeeded',completed_at=now(),page_count=0,conflict_count=0
      WHERE id=${retriedWiki!.operationID!}`;
    expect(
      (await coordinator.status(projectID, manager)).find((row) => row.task === "wiki")?.state,
    ).toBe("ready");
    // Unacknowledged work after a genuine restart remains human-retryable.
    await database.client`UPDATE factory.project_setup_readiness SET state='running',operation_id=NULL WHERE project_id=${projectID} AND task='hook'`;
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
