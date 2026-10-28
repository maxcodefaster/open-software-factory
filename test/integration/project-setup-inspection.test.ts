import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configurationPath } from "../../apps/factory/src/setup/configuration";
import { requireSetupReady } from "../../apps/factory/src/setup/execution-gate";
import { createSetupInspection } from "../../apps/factory/src/setup/inspection";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";

test("setup inference does not retain the application's only pooled database connection", async () => {
  const isolated = await factoryProcess();
  const database = isolated.connect(1);
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let work: Promise<unknown> | undefined;
  let controller: ReturnType<typeof createSetupInspection> | undefined;
  const commandID = crypto.randomUUID();
  let generations = 0;
  let latestAnswers: Record<string, string> | undefined;
  let latestContext: readonly { question: string; answer: string }[] | undefined;
  const configuration = (await starterFiles()).filter((file) => configurationPath(file.path));
  let sourceCommit = "a".repeat(40);
  try {
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${userID},'Owned pool proof',${`${userID}@pool.test`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`pool-${projectID.slice(0, 8)}`},'Pool proof','https://forge.test/owned/pool','main','.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${userID},'developer',true,${userID})`;
    const forge = createForgejoClient({
      apiURL: "https://forge.test/api/v1/",
      token: "owned-fixture",
      fetch: async (url) => {
        const path = String(url);
        if (path.endsWith("/branches/main"))
          return Response.json({ name: "main", commit: { id: sourceCommit } });
        if (path.includes("/git/trees/"))
          return Response.json({
            sha: "a".repeat(40),
            truncated: false,
            tree: [{ path: "package.json", type: "blob", sha: "b".repeat(40), size: 40 }],
          });
        if (path.endsWith("/repos/owned/pool"))
          return Response.json({ name: "pool", owner: { login: "owned" }, default_branch: "main" });
        throw new Error(`Unsupported owned fixture path: ${new URL(path).pathname}`);
      },
    });
    controller = createSetupInspection({
      database,
      forge,
      forgeURL: "https://forge.test",
      forgeOwner: "owned",
      model: async () => ({ modelID: "owned-model", connectionID: null, connectionVersion: null }),
      connection: async () => ({ apiKey: "owned-key" }),
      ready: async () => {},
      generate: async (input) => {
        generations++;
        latestAnswers = input.answers;
        latestContext = input.context;
        entered.resolve();
        await release.promise;
        return {
          purpose: "Owned application",
          services: [],
          uncertainty: [],
          questions:
            generations === 1
              ? [
                  { id: "port", question: "Which port should the app use?" },
                  { id: "health", question: "Which existing health path is available?" },
                ]
              : [],
          files: generations === 1 ? [] : configuration,
        };
      },
    });
    work = controller.start(projectID, userID, commandID);
    await Promise.race([
      entered.promise,
      Bun.sleep(1500).then(() => {
        throw new Error("Setup inference was blocked by its own reserved pool connection");
      }),
    ]);
    const start = performance.now();
    const [read] = await Promise.race([
      database.client`SELECT 1 AS available`,
      Bun.sleep(1500).then(() => {
        throw new Error("Application pool remained occupied during inference");
      }),
    ]);
    expect(read?.["available"]).toBe(1);
    expect(performance.now() - start).toBeLessThan(1500);
    release.resolve();
    await work;
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    const continuationID = crypto.randomUUID();
    const continuation = { parentID: commandID, answers: { health: "/health", port: "3000" } };
    await controller.start(projectID, userID, continuationID, continuation);
    await controller.settle();
    expect(generations).toBe(2);
    await controller.start(projectID, userID, continuationID, continuation);
    await controller.start(projectID, userID, continuationID, {
      parentID: commandID,
      answers: { port: "3000", health: "/health" },
    });
    expect(generations).toBe(2);
    await expect(
      controller.start(projectID, userID, continuationID, {
        parentID: commandID,
        answers: { port: "4000", health: "/health" },
      }),
    ).rejects.toThrow("different work");
    const revisionID = crypto.randomUUID();
    const feedback = "Use the pinned Node image and retain the established behavioral checks.";
    const revision = { parentID: continuationID, answers: { $feedback: feedback } };
    await controller.start(projectID, userID, revisionID, revision);
    await controller.settle();
    expect(generations).toBe(3);
    expect(latestAnswers?.["$feedback"]).toBe(feedback);
    expect(latestContext).toContainEqual({
      question: "Requested configuration changes",
      answer: feedback,
    });
    expect(latestContext).toContainEqual({
      question: "Which port should the app use?",
      answer: "3000",
    });
    await controller.start(projectID, userID, revisionID, revision);
    expect(generations).toBe(3);
    await expect(
      controller.start(projectID, userID, revisionID, {
        ...revision,
        answers: { $feedback: "Different instructions" },
      }),
    ).rejects.toThrow("different work");
    sourceCommit = "c".repeat(40);
    await expect(
      controller.start(projectID, userID, crypto.randomUUID(), {
        parentID: revisionID,
        answers: { $feedback: feedback },
      }),
    ).rejects.toThrow("Source changed");
    expect(generations).toBe(3);
  } finally {
    release.resolve();
    await database.client.end({ timeout: 0 });
    await work?.catch(() => undefined);
    await controller?.settle();
    await isolated.dispose();
  }
}, 30_000);

test("actual Forgejo atomically applies only confirmed missing setup files and recovers lost commit response", async () => {
  const id = crypto.randomUUID();
  const directory = resolve(".factory/test-results/setup-inspection", id);
  await mkdir(directory, { recursive: true });
  const forgeHost = await ownedMonitoringForge(directory, id);
  const process = await factoryProcess().catch(async (cause) => {
    await forgeHost.dispose();
    throw cause;
  });
  const database = process.connect();
  const manager = crypto.randomUUID();
  const contributor = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const setupID = crypto.randomUUID();
  const repository = {
    owner: forgeHost.owner,
    name: `owned-inspection-${projectID.slice(0, 8)}`,
  };
  const token = forgeHost.token;
  const apiURL = `${forgeHost.origin}/api/v1/`;
  let loseResponse = false;
  const forge = createForgejoClient({
    apiURL,
    token,
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (
        loseResponse &&
        options?.method === "POST" &&
        String(url).endsWith("/contents") &&
        response.ok
      ) {
        loseResponse = false;
        await response.body?.cancel();
        throw new DOMException("owned lost file acknowledgement", "AbortError");
      }
      return response;
    },
  });
  let generations = 0;
  let ready = 0;
  let waitForStop = false;
  try {
    for (const userID of [manager, contributor])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${userID},'Owned inspection',${`${userID}@inspection.test`})`;
    await forge.createSetupRepository({ repository, setupID });
    await forge.createSetupFiles({
      repository,
      branch: "main",
      setupID,
      files: [
        {
          path: "package.json",
          content: '{"scripts":{"dev":"node server.js","test":"node --test"}}',
        },
        { path: "server.js", content: 'console.log("owned application");\n' },
      ],
    });
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${repository.name},'Owned application',${`${forgeHost.origin}/${repository.owner}/${repository.name}`},'main','.devcontainer/devcontainer.json',${manager})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${projectID},${manager},'developer',true,${manager}),(${projectID},${contributor},'product-contributor',false,${manager})`;
    await database.client`INSERT INTO factory.project_repository_intent(command_id,setup_id,user_id,project_id,name,slug,kind,source_url,fingerprint,state)
      VALUES(${crypto.randomUUID()},${setupID},${manager},${projectID},'Owned import',${repository.name},'import','https://github.com/owned/import',${"a".repeat(64)},'committed')`;
    await expect(requireSetupReady(database.client, projectID)).rejects.toThrow("Confirm");
    const files = [
      {
        path: ".devcontainer/devcontainer.json",
        content: '{"image":"node:24-bookworm","workspaceFolder":"/workspace/project",}',
      },
      {
        path: ".factory/system.json",
        content: JSON.stringify({
          version: 1,
          primaryApp: "web",
          apps: [
            {
              id: "web",
              label: "Web",
              command: ["npm", "run", "dev"],
              port: 4300,
              healthPath: "/health",
            },
          ],
        }),
      },
      {
        path: ".forgejo/workflows/factory-verification.yml",
        content:
          "name: Verification\non: pull_request\njobs:\n  verify:\n    runs-on: factory-verification\n    steps:\n      - run: npm test\n",
      },
    ];
    const controller = createSetupInspection({
      database,
      forge,
      forgeURL: apiURL,
      forgeOwner: repository.owner,
      model: async () => ({
        modelID: "controlled-setup-model",
        connectionID: null,
        connectionVersion: null,
      }),
      connection: async () => ({ apiKey: "not-a-production-key" }),
      ready: async () => {
        ready++;
        await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,state,command_id)
          VALUES(${projectID},'configuration','ready',${crypto.randomUUID()}) ON CONFLICT(project_id,task) DO NOTHING`;
      },
      generate: async (input) => {
        generations++;
        if (waitForStop) {
          input.signal.throwIfAborted();
          await new Promise((resolve) =>
            input.signal.addEventListener("abort", resolve, { once: true }),
          );
          input.signal.throwIfAborted();
        }
        expect(input.paths).toContain("server.js");
        expect(await input.read("server.js")).toContain("owned application");
        if (!input.answers?.["health"] && !input.context?.length)
          return {
            purpose: "An application fixture with its existing Node scripts.",
            services: [],
            uncertainty: ["Health endpoint needs confirmation."],
            questions: [{ id: "health", question: "Which existing health path is available?" }],
            files: [],
          };
        if (!input.answers?.["start"]) {
          expect(input.context).toEqual([
            {
              question: "Which existing health path is available?",
              answer: "/health",
            },
          ]);
          return {
            purpose: "An application fixture with its existing Node scripts.",
            services: [],
            uncertainty: [],
            questions: [{ id: "start", question: "Which existing command starts the app?" }],
            files: [],
          };
        }
        expect(input.context).toEqual([
          { question: "Which existing health path is available?", answer: "/health" },
          { question: "Which existing command starts the app?", answer: "npm run dev" },
        ]);
        return {
          purpose: "An application fixture with its existing Node scripts.",
          services: [{ name: "Web", description: "HTTP application", port: 4300 }],
          uncertainty: [],
          questions: [],
          files,
        };
      },
    });
    await expect(controller.start(projectID, contributor, crypto.randomUUID())).rejects.toThrow(
      "Manager",
    );
    const commandID = crypto.randomUUID();
    waitForStop = true;
    const stoppedID = crypto.randomUUID();
    await controller.start(projectID, manager, stoppedID);
    await expect(controller.stop(projectID, contributor, stoppedID)).rejects.toThrow("Manager");
    await controller.stop(projectID, manager, stoppedID);
    await controller.settle();
    expect((await controller.view(projectID, manager))?.state).toBe("superseded");
    expect(ready).toBe(0);
    waitForStop = false;
    generations = 0;
    await controller.start(projectID, manager, commandID);
    await controller.settle();
    expect((await controller.view(projectID, manager))?.state).toBe("proposal");
    const before = await forge.getDefaultBranch(repository);
    expect(await forge.listFiles(repository, before.headSha)).toHaveLength(2);
    await controller.start(projectID, manager, commandID);
    expect(generations).toBe(1);
    await expect(controller.confirm(projectID, manager, commandID)).rejects.toThrow("Answer");
    // Discarding an unanswered proposal makes a new exact-source inspection possible.
    await controller.stop(projectID, manager, commandID);
    const replacementID = crypto.randomUUID();
    await controller.start(projectID, manager, replacementID);
    await controller.settle();
    expect(generations).toBe(2);
    await expect(
      controller.start(projectID, manager, crypto.randomUUID(), {
        parentID: commandID,
        answers: { health: "/health" },
      }),
    ).rejects.toThrow("changed");
    const answeredID = crypto.randomUUID();
    await controller.start(projectID, manager, answeredID, {
      parentID: replacementID,
      answers: { health: "/health" },
    });
    await controller.settle();
    expect(generations).toBe(3);
    expect((await controller.view(projectID, manager))?.output?.questions[0]?.id).toBe("start");
    const finalID = crypto.randomUUID();
    await controller.start(projectID, manager, finalID, {
      parentID: answeredID,
      answers: { start: "npm run dev" },
    });
    await controller.settle();
    await forge.ensureDefaultBranchProtection(repository, "main", false);
    // Account reconciliation may already have protected the still-missing
    // workflow before the manager confirms an imported Project's setup.
    await forge.protectSetupWorkflow(repository, "main");
    loseResponse = true;
    await controller.confirm(projectID, manager, finalID);
    await forge.protectSetupWorkflow(repository, "main");
    expect(loseResponse).toBe(false);
    expect((await controller.view(projectID, manager))?.state).toBe("confirmed");
    const after = await forge.getDefaultBranch(repository);
    expect(after.headSha).not.toBe(before.headSha);
    expect(await forge.listFiles(repository, after.headSha)).toHaveLength(5);
    expect(await forge.getFile(repository, "server.js", after.headSha)).toBe(
      'console.log("owned application");\n',
    );
    await controller.confirm(projectID, manager, finalID);
    expect(ready).toBe(1);
    await requireSetupReady(database.client, projectID);
    // Complete configuration is accepted without another model call or file edit.
    await controller.start(projectID, manager, crypto.randomUUID());
    expect((await controller.view(projectID, manager))?.state).toBe("complete");
    expect(generations).toBe(4);
  } finally {
    try {
      await database.client.end({ timeout: 2 });
      await process.dispose();
    } finally {
      await forgeHost.dispose();
    }
  }
}, 90_000);
