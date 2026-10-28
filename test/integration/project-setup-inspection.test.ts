import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configurationPath } from "../../apps/factory/src/setup/configuration";
import { requireSetupReady } from "../../apps/factory/src/setup/execution-gate";
import { createSetupInspection } from "../../apps/factory/src/setup/inspection";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { setupFeedbackKey } from "../../packages/project-domain/src/setup";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";

test("an explicit retry retains confirmed setup answers after a failed continuation", async () => {
  const isolated = await factoryProcess();
  const database = isolated.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const initialID = crypto.randomUUID();
  const failedID = crypto.randomUUID();
  const retryID = crypto.randomUUID();
  let head = "a".repeat(40);
  let calls = 0;
  let sourceReads = 0;
  let invalidRecipe = false;
  const feedbacks: (string | undefined)[] = [];
  const contexts: (readonly { question: string; answer: string }[] | undefined)[] = [];
  const previousProposals: unknown[] = [];
  const recipeReads: {
    available: readonly string[];
    body: string | null;
    denied: string[];
  }[] = [];
  const files = (await starterFiles()).filter((file) => configurationPath(file.path));
  const inventory = [
    { path: "package.json", size: 40 },
    ...Array.from({ length: 2000 }, (_, index) => ({ path: `src/part-${index}.ts`, size: 40 })),
    { path: "tools/forms-dev.mjs", size: 40 },
    { path: "infra/coder/workspace.Dockerfile", size: 40 },
    { path: "infra/Dockerfile.development", size: 40 },
    { path: "infra/private-key.Dockerfile", size: 40 },
    { path: "node_modules/vendor.Dockerfile", size: 40 },
    { path: ".env/Dockerfile", size: 40 },
    { path: ".env.runtime.json", size: 40 },
    { path: ".env.local", size: 40 },
    { path: "src/oversized.ts", size: 64001 },
  ].map((file) => ({ ...file, type: "blob", sha: "b".repeat(40) }));
  const forge = createForgejoClient({
    apiURL: "https://forge.test/api/v1/",
    token: "owned-fixture",
    fetch: async (url) => {
      const path = String(url);
      if (path.endsWith("/branches/main"))
        return Response.json({ name: "main", commit: { id: head } });
      if (path.includes("/git/trees/")) {
        const page = Number(new URL(path).searchParams.get("page") ?? 1);
        return Response.json({
          sha: head,
          truncated: false,
          total_count: inventory.length,
          tree: inventory.slice((page - 1) * 1000, page * 1000),
        });
      }
      if (
        ["/contents/tools/forms-dev.mjs", "/contents/infra/coder/workspace.Dockerfile"].some(
          (suffix) => new URL(path).pathname.endsWith(suffix),
        )
      ) {
        sourceReads++;
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from("Actual existing development harness").toString("base64"),
          sha: "b".repeat(40),
        });
      }
      if (path.endsWith("/repos/owned/retry"))
        return Response.json({ name: "retry", owner: { login: "owned" }, default_branch: "main" });
      throw new Error("Unsupported owned retry fixture request");
    },
  });
  const controller = createSetupInspection({
    database,
    forge,
    forgeURL: "https://forge.test",
    forgeOwner: "owned",
    model: async () => ({ modelID: "owned-model", connectionID: null, connectionVersion: null }),
    connection: async () => ({ apiKey: "owned-key" }),
    ready: async () => {},
    generate: async (input) => {
      contexts.push(input.context);
      feedbacks.push(input.configurationFeedback);
      previousProposals.push(Reflect.get(input, "previousProposal"));
      calls++;
      expect(input.paths).toHaveLength(2000);
      expect(input.paths).not.toContain("tools/forms-dev.mjs");
      expect(input.availablePaths).toContain("tools/forms-dev.mjs");
      recipeReads.push({
        available: input.availablePaths ?? [],
        body: await input.read("infra/coder/workspace.Dockerfile").catch(() => null),
        denied: await Promise.all(
          [
            "infra/private-key.Dockerfile",
            "node_modules/vendor.Dockerfile",
            ".env/Dockerfile",
            ".env.runtime.json",
          ].map((path) =>
            input.read(path).then(
              () => "Source was disclosed",
              (cause) => String(cause),
            ),
          ),
        ),
      });
      expect(input.availablePaths).not.toContain(".env.local");
      expect(input.availablePaths).not.toContain("src/oversized.ts");
      await expect(input.read(".env.local")).rejects.toThrow("Source is not available");
      expect(await input.read("tools/forms-dev.mjs")).toBe("Actual existing development harness");
      if (calls === 2)
        throw new DOMException("must-not-retain-provider-credentials", "TimeoutError");
      return {
        purpose: "Owned retry application",
        services: [],
        uncertainty: [],
        questions: calls === 1 ? [{ id: "port", question: "Which port should Factory use?" }] : [],
        files:
          calls === 1
            ? []
            : invalidRecipe
              ? files.filter((file) => file.path !== ".devcontainer/compose.yaml")
              : files,
      };
    },
  });
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned retry proof',${`${userID}@retry.test`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`retry-${projectID.slice(0, 8)}`},'Retry proof','https://forge.test/owned/retry','main','.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${userID},'developer',true,${userID})`;
    await controller.start(projectID, userID, initialID);
    await controller.settle();
    const recipe = recipeReads[0];
    expect(recipe?.available).toContain("infra/coder/workspace.Dockerfile");
    expect(recipe?.available).toContain("infra/Dockerfile.development");
    expect(recipe?.body).toBe("Actual existing development harness");
    for (const excluded of [
      "infra/private-key.Dockerfile",
      "node_modules/vendor.Dockerfile",
      ".env/Dockerfile",
      ".env.runtime.json",
    ])
      expect(recipe?.available).not.toContain(excluded);
    expect(recipe?.denied.every((message) => message.includes("Source is not available"))).toBe(
      true,
    );
    await controller.start(projectID, userID, failedID, {
      parentID: initialID,
      answers: { port: "4321" },
    });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("failed");
    await controller.start(projectID, userID, retryID, { parentID: failedID });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    expect(contexts.at(-1)).toContainEqual({
      question: "Which port should Factory use?",
      answer: "4321",
    });
    await controller.start(projectID, userID, retryID, { parentID: failedID });
    expect(calls).toBe(3);
    expect(sourceReads).toBe(6);
    const [failed] = await database.client<{ state: string; failure: string }[]>`
      SELECT state,failure FROM factory.project_setup_inspection WHERE id=${failedID}`;
    expect(failed?.state).toBe("failed");
    expect(failed?.failure).toContain("timed out");
    expect(failed?.failure).not.toContain("must-not-retain-provider-credentials");
    await expect(
      controller.start(projectID, userID, crypto.randomUUID(), {
        parentID: failedID,
        answers: { port: "9999" },
      }),
    ).rejects.toThrow("Retry keeps the confirmed answers");
    head = "c".repeat(40);
    await expect(
      controller.start(projectID, userID, crypto.randomUUID(), { parentID: failedID }),
    ).rejects.toThrow("Source changed");
    expect(calls).toBe(3);

    head = "a".repeat(40);
    await controller.stop(projectID, userID, retryID);
    let failedParent = failedID;
    for (let index = 0; index < 9; index++) {
      const id = crypto.randomUUID();
      await database.client`INSERT INTO factory.project_setup_inspection
        (id,project_id,source_commit,state,created_by,parent_id,answers,failure)
        VALUES(${id},${projectID},${head},'failed',${userID},${failedParent},'{}'::jsonb,'Earlier inspection failed')`;
      failedParent = id;
    }
    const recoveredID = crypto.randomUUID();
    await controller.start(projectID, userID, recoveredID, { parentID: failedParent });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    expect(contexts.at(-1)).toEqual([
      {
        question: "Which port should Factory use?",
        answer: "4321",
      },
    ]);
    expect(calls).toBe(4);
    await controller.stop(projectID, userID, recoveredID);

    const questionOutput = JSON.stringify({
      purpose: "Owned bounded question history",
      services: [],
      uncertainty: [],
      questions: [{ id: "port", question: "Which port should Factory use?" }],
      files: [],
    });
    let questionParent = initialID;
    for (let index = 0; index < 7; index++) {
      const id = crypto.randomUUID();
      await database.client`INSERT INTO factory.project_setup_inspection
        (id,project_id,source_commit,state,created_by,parent_id,answers,output)
        VALUES(${id},${projectID},${head},'superseded',${userID},${questionParent},
          '{"port":"4321"}'::jsonb,${questionOutput}::jsonb)`;
      questionParent = id;
    }
    const eighthFailedID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project_setup_inspection
      (id,project_id,source_commit,state,created_by,parent_id,answers)
      VALUES(${eighthFailedID},${projectID},${head},'failed',${userID},${questionParent},'{"port":"4321"}'::jsonb)`;
    const eighthRetryID = crypto.randomUUID();
    await controller.start(projectID, userID, eighthRetryID, { parentID: eighthFailedID });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    expect(contexts.at(-1)).toHaveLength(8);
    expect(calls).toBe(5);
    await controller.stop(projectID, userID, eighthRetryID);

    const ninthQuestionID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project_setup_inspection
      (id,project_id,source_commit,state,created_by,parent_id,answers,output)
      VALUES(${ninthQuestionID},${projectID},${head},'superseded',${userID},${questionParent},
        '{"port":"4321"}'::jsonb,${questionOutput}::jsonb)`;
    const ninthFailedID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project_setup_inspection
      (id,project_id,source_commit,state,created_by,parent_id,answers)
      VALUES(${ninthFailedID},${projectID},${head},'failed',${userID},${ninthQuestionID},'{"port":"4321"}'::jsonb)`;
    await controller.start(projectID, userID, crypto.randomUUID(), { parentID: ninthFailedID });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("failed");
    expect(calls).toBe(5);

    const cyclicID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project_setup_inspection
      (id,project_id,source_commit,state,created_by,parent_id,answers)
      VALUES(${cyclicID},${projectID},${head},'failed',${userID},${cyclicID},'{}'::jsonb)`;
    await controller.start(projectID, userID, crypto.randomUUID(), { parentID: cyclicID });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("failed");
    expect(calls).toBe(5);

    invalidRecipe = true;
    const invalidID = crypto.randomUUID();
    await controller.start(projectID, userID, invalidID);
    await controller.settle();
    const invalid = await controller.view(projectID, userID);
    expect(invalid?.state).toBe("failed");
    expect(invalid?.output).toBeNull();
    expect(invalid?.failure).toContain("required recipe file");
    invalidRecipe = false;
    const correctedID = crypto.randomUUID();
    await controller.start(projectID, userID, correctedID, { parentID: invalidID });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    expect(feedbacks.at(-1)).toBe(invalid?.failure ?? undefined);
    await controller.start(projectID, userID, correctedID, { parentID: invalidID });
    expect(calls).toBe(7);
    expect(sourceReads).toBe(14);
    const [retainedInvalid] =
      await database.client`SELECT state,failure FROM factory.project_setup_inspection WHERE id=${invalidID}`;
    expect(retainedInvalid?.["state"]).toBe("failed");
    expect(retainedInvalid?.["failure"]).toBe(invalid?.failure);

    let reviewedID = correctedID;
    for (let index = 0; index < 9; index++) {
      const retained = (await controller.view(projectID, userID))?.output;
      const nextID = crypto.randomUUID();
      const correction = `Preserve the current recipe; review correction ${index + 1}.`;
      await controller.start(projectID, userID, nextID, {
        parentID: reviewedID,
        answers: { [setupFeedbackKey]: correction },
      });
      await controller.settle();
      expect((await controller.view(projectID, userID))?.state).toBe("proposal");
      expect(previousProposals.at(-1)).toEqual(retained);
      expect(contexts.at(-1)).toContainEqual({
        question: "Requested configuration changes",
        answer: correction,
      });
      reviewedID = nextID;
    }
    await controller.stop(projectID, userID, reviewedID);
    const eighthReviewBase = crypto.randomUUID();
    const reviewedOutput = JSON.stringify({
      purpose: "Owned retry application",
      services: [],
      uncertainty: [],
      questions: [],
      files,
    });
    await database.client`INSERT INTO factory.project_setup_inspection
      (id,project_id,source_commit,state,created_by,parent_id,answers,output)
      VALUES(${eighthReviewBase},${projectID},${head},'proposal',${userID},${eighthFailedID},
        '{}'::jsonb,${reviewedOutput}::jsonb)`;
    const eighthReviewID = crypto.randomUUID();
    await controller.start(projectID, userID, eighthReviewID, {
      parentID: eighthReviewBase,
      answers: { [setupFeedbackKey]: "Correct only the native installer asset name." },
    });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    expect(previousProposals.at(-1)).toEqual(JSON.parse(reviewedOutput));
    expect(contexts.at(-1)).toHaveLength(9);
    invalidRecipe = true;
    const failedReviewID = crypto.randomUUID();
    await controller.start(projectID, userID, failedReviewID, {
      parentID: eighthReviewID,
      answers: { [setupFeedbackKey]: "Preserve the recipe and correct only its installer." },
    });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("failed");
    invalidRecipe = false;
    const recoveredReviewID = crypto.randomUUID();
    await controller.start(projectID, userID, recoveredReviewID, { parentID: failedReviewID });
    await controller.settle();
    expect((await controller.view(projectID, userID))?.state).toBe("proposal");
    expect(previousProposals.at(-1)).toEqual(JSON.parse(reviewedOutput));
    expect(contexts.at(-1)).toContainEqual({
      question: "Requested configuration changes",
      answer: "Preserve the recipe and correct only its installer.",
    });
    const settledCalls = calls;
    await controller.start(projectID, userID, recoveredReviewID, { parentID: failedReviewID });
    expect(calls).toBe(settledCalls);
  } finally {
    await controller.settle();
    await database.client.end();
    await isolated.dispose();
  }
});

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
