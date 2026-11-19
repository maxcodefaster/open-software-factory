import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type { StoredEnvironment } from "../../apps/factory/src/environments/openbao";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { createSetupReadiness } from "../../apps/factory/src/setup/readiness";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { callFactoryFunction } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

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
    prepare: async () => {
      throw new Error("Unconfirmed imported configuration must not start execution");
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
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`shutdown-${projectID}`},'Owned shutdown','https://example.invalid/owned','main','.devcontainer/devcontainer.json',${userID})`;
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
        await database.client`SELECT task FROM factory.project_setup_readiness WHERE project_id=${laterProjectID}`
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
            VALUES(${fixtureValue(id, "id")},${projectID},${fixtureValue(environment, "environment")},${revision},1)`;
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
    const developmentTask = rows.find((row) => row.task === "development");
    await database.client`UPDATE factory.project_image_preparation SET state='unsupported',
      failure='Prepared image publication is not configured for this installation. Normal Dev Container startup remains available.'
      WHERE id=${fixtureValue(developmentTask?.operationID, "development preparation")}`;
    const normalStartup = await coordinator.status(projectID, manager);
    expect(normalStartup.find((row) => row.task === "development")).toMatchObject({
      state: "ready",
      operationID: developmentTask?.operationID,
      failure: "This configuration uses normal startup instead of a prebuilt image.",
    });
    expect(normalStartup.find((row) => row.task === "preview-image")?.state).toBe("running");
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
      WHERE id=${fixtureValue(fixtureValue(retriedWiki, "retriedWiki").operationID, "retriedWiki!.operationID")}`;
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
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`wiki-retry-${projectID}`},'Wiki retry fixture',${`${forgeBase}/owned-process-fixture/fixture`},'main','.devcontainer/devcontainer.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${userID},'developer',false,${userID})`;
      await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by,state,completed_at,failure)
      VALUES(${original},${projectID},${"a".repeat(40)},${userID},'failed',now(),'Original retained failure')`;
      await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,command_id,state,operation_id,failure)
      VALUES(${projectID},'wiki',${crypto.randomUUID()},${setupState},${original},'Wiki generation needs retry.')`;
      // Already admitted work is returned by Generate. No source or provider request
      // is needed to test the authenticated retry's exact operation handoff.
      await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by,state)
      VALUES(${retried},${projectID},${"a".repeat(40)},${userID},'running')`;
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
        >`SELECT state FROM factory.project_setup_readiness
        WHERE project_id=${projectID} AND task='wiki'`;
        expect(unobserved?.state).toBe("running");
      }
      const retry = await serverCall(
        callFactoryFunction(fixture.base, "generateKnowledge", [projectID], { cookie }),
      );
      expect(retry?.id).toBe(retried);
      const linked = await status();
      expect(linked.operationID).toBe(retried);
      expect(linked.state).toBe("running");
      await database.client`UPDATE factory.knowledge_generation SET state='succeeded',completed_at=now(),
      page_count=0,conflict_count=0 WHERE id=${retried}`;
      const ready = await status();
      expect(ready.state).toBe("ready");
      expect(ready.failure).toBeNull();
      const [retained] = await database.client<
        Array<{ state: string; failure: string }>
      >`SELECT state,failure FROM factory.knowledge_generation WHERE id=${original}`;
      expect(retained?.state).toBe("failed");
      expect(retained?.failure).toBe("Original retained failure");
      expect(
        (
          await database.client`SELECT id FROM factory.knowledge_generation WHERE project_id=${projectID}`
        ).length,
      ).toBe(2);
      // Later unrelated generations never replace the explicitly linked operation.
      await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by,state,completed_at)
      VALUES(${crypto.randomUUID()},${projectID},${"b".repeat(40)},${userID},'failed',now())`;
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
