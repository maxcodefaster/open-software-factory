import { expect, test } from "bun:test";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { generateWiki } from "../../apps/factory/src/knowledge/generation-agent";
import {
  WikiSourceEvidenceError,
  WikiTopicPlanError,
  WikiTopicQualityError,
} from "../../apps/factory/src/knowledge/generation-failure";
import { ModelExecutionBoundError } from "../../apps/factory/src/models/execution-policy";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test.each(["README", "README.md"])(
  "extensionless README reaches the real checked Wiki bootstrap without inventing a source path: %s",
  async (path) => {
    // Pinned Hello-World input from the two failed fresh-install generations.
    // The local provider returns exact observed references, not historical model output.
    const commit = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
    const blob = "980a0d5f19a64b4b30a87d4206aade58726b60e3";
    const text = "Hello World!\n";
    const owned = await factoryProcess();
    const db = owned.connect();
    const user = crypto.randomUUID();
    const project = crypto.randomUUID();
    const keys = [
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_FORGEJO_TOKEN",
      "FACTORY_FORGEJO_OWNER",
      "FACTORY_MODEL_BASE_URL",
      "FACTORY_MODEL_API_KEY",
      "FACTORY_PROJECT_AGENT_MODEL",
    ];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      FACTORY_FORGEJO_API_URL: "http://127.0.0.1:9/api/v1/",
      FACTORY_FORGEJO_TOKEN: "controlled",
      FACTORY_FORGEJO_OWNER: "owned",
      FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      FACTORY_MODEL_API_KEY: "controlled",
      FACTORY_PROJECT_AGENT_MODEL: "controlled-wiki",
    });
    const packets: Array<{ paths: string[]; sources: Array<{ path: string; content: string }> }> =
      [];
    const plannerPackets: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        const system = input.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        let output: unknown;
        if (system.includes("Research manifests and core flows")) {
          plannerPackets.push(input);
          output = {
            topics: [
              {
                slug: "overview",
                title: "Hello World",
                purpose: "Introduce the greeting documented by the repository.",
                paths: [path],
                pageIDs: [],
                parentSlug: null,
              },
            ],
          };
        } else if (system.includes("Review the whole proposed Wiki topic plan"))
          output = { findings: [] };
        else if (system.includes("Write only this topic"))
          output = { pages: [{ body: "The repository says Hello World!", sources: [path] }] };
        else output = { issues: [], advisory: [] };
        return Response.json({
          id: "owned-readme-bootstrap",
          object: "chat.completion",
          created: 1,
          model: "controlled-wiki",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(output) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const wiki = createKnowledgeController(
      db,
      {
        getDefaultBranch: async () => ({ name: "master", headSha: commit }),
        listFiles: async () => [{ path, sha: blob, size: 13 }],
        getFileInfo: async (_repository, requestedPath, ref) => {
          expect(requestedPath).toBe(path);
          expect(ref).toBe(commit);
          return { sha: blob, content: text };
        },
      },
      async (input) => {
        packets.push({
          paths: input.inventory.map((file) => file.path),
          sources: input.sources,
        });
        return generateWiki({
          ...input,
          connection: {
            provider: "openai",
            baseURL: `http://127.0.0.1:${server.port}/v1`,
            apiKey: "owned-test-not-a-secret",
          },
        });
      },
    );
    try {
      await db.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${user},'Wiki owner',${`readme-${user}@factory.invalid`},true)`;
      await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${project},${`readme-${project}`},'Hello World','http://127.0.0.1:9/owned/wiki','master','.devcontainer/devcontainer.json',${user})`;
      await db.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${project},${user},'developer',${user})`;
      await wiki.generate(project, user);
      await wiki.settle();
      expect(packets).toEqual([{ paths: [path], sources: [{ path, content: text }] }]);
      expect(plannerPackets).toHaveLength(1);
      expect((await wiki.generation(project))?.["state"]).toBe("succeeded");
      const [page] = await db.client<
        Array<{ body: string; citations: Array<{ path: string; commitSha: string }> }>
      >`SELECT current_body AS body,citations FROM factory.knowledge_page WHERE project_id=${project}`;
      expect(page?.body).toBe("The repository says Hello World!");
      expect(page?.citations).toEqual([{ path, commitSha: commit }]);
    } finally {
      await wiki.settle();
      await server.stop(true);
      await db.client.end();
      await owned.dispose();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  30_000,
);

test.each([false, true])(
  "Wiki generation fences concurrent human revisions, preserves organization and deduplicates no-op updates, progressive=%s",
  async (progressive) => {
    const owned = await factoryProcess();
    const db = owned.connect();
    const user = crypto.randomUUID(),
      project = crypto.randomUUID(),
      page = crypto.randomUUID();
    const keys = [
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_FORGEJO_TOKEN",
      "FACTORY_FORGEJO_OWNER",
      "FACTORY_MODEL_BASE_URL",
      "FACTORY_MODEL_API_KEY",
      "FACTORY_PROJECT_AGENT_MODEL",
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      FACTORY_FORGEJO_API_URL: "http://127.0.0.1:9/api/v1/",
      FACTORY_FORGEJO_TOKEN: "controlled",
      FACTORY_FORGEJO_OWNER: "owned",
      FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      FACTORY_MODEL_API_KEY: "controlled",
      FACTORY_PROJECT_AGENT_MODEL: "controlled-wiki",
    });
    let commit = "a".repeat(40),
      calls = 0,
      noop = false,
      failure = false,
      interruptAfterPackage = false;
    let failureCause: Error = new Error("Provider failure including controlled-private-key");
    let inventoryReceived: string[] = [];
    let expectedCompleted: string[] | undefined;
    const reader = {
      getDefaultBranch: async () => ({ name: "main", headSha: commit }),
      listFiles: async () => [
        { path: "src/main.ts", sha: commit, size: 32 },
        { path: "package.json", sha: "b".repeat(40), size: 10 },
        { path: "drizzle/0000_auth.sql", sha: commit, size: 32 },
        { path: "src/web.css", sha: commit, size: 32 },
        { path: "index.html", sha: commit, size: 32 },
        { path: "tools/workspace.mjs", sha: commit, size: 32 },
        { path: "tools/config.cjs", sha: commit, size: 32 },
        { path: ".env.sql", sha: commit, size: 32 },
        { path: ".env.production.json", sha: commit, size: 32 },
        { path: ".env.development.mjs", sha: commit, size: 32 },
        { path: "src/credentials.sql", sha: commit, size: 32 },
        { path: "src/credentials.cjs", sha: commit, size: 32 },
        { path: ".factory/README", sha: commit, size: 13 },
        { path: "nested/.factory/README", sha: commit, size: 13 },
        { path: "node_modules/README", sha: commit, size: 13 },
        { path: "secrets/README", sha: commit, size: 13 },
        { path: "../README", sha: commit, size: 13 },
        { path: "/README", sha: commit, size: 13 },
        { path: "large/README", sha: commit, size: 80_001 },
      ],
      getFileInfo: async (_repo: unknown, path: string) => ({
        sha: path === "package.json" ? "b".repeat(40) : commit,
        content: path === "package.json" ? '{"name":"app"}' : "export const behavior='current';",
      }),
    };
    const wiki = createKnowledgeController(db, reader, async (input) => {
      calls++;
      if (expectedCompleted) expect(input.completedPageIDs).toEqual(expectedCompleted);
      if (failure) throw failureCause;
      const paths = input.inventory.map((entry) => entry.path);
      inventoryReceived = paths;
      for (const path of [
        "drizzle/0000_auth.sql",
        "src/web.css",
        "index.html",
        "tools/workspace.mjs",
        "tools/config.cjs",
      ])
        expect(paths).toContain(path);
      for (const path of [
        ".env.sql",
        ".env.production.json",
        ".env.development.mjs",
        "src/credentials.sql",
        "src/credentials.cjs",
        ".factory/README",
        "nested/.factory/README",
        "node_modules/README",
        "secrets/README",
        "../README",
        "/README",
        "large/README",
      ])
        expect(paths).not.toContain(path);
      await input.readFiles([
        "drizzle/0000_auth.sql",
        "src/web.css",
        "index.html",
        "tools/workspace.mjs",
        "tools/config.cjs",
      ]);
      await expect(input.readFiles([".env.sql"])).rejects.toThrow(
        "Wiki source read is unavailable",
      );
      await input.readFiles(["src/main.ts"]);
      const current = input.pages.find((value) => value.id === page);
      if (!current) throw new Error("Missing current Wiki fixture");
      if (calls === 1) {
        const recorded = { phase: "writing", topicsTotal: 2, topicsDone: 1, currentTopic: "Guide" };
        await input.progress?.(recorded as never);
        const [row] = await db.client<
          Array<{ progress: unknown }>
        >`SELECT progress FROM factory.knowledge_generation WHERE project_id=${project} AND state='running'`;
        expect(row?.progress).toEqual(recorded);
      }
      if (calls === 1)
        await wiki.edit(
          page,
          {
            expectedVersion: current.version,
            title: current.title,
            body: "Human business purpose added during analysis.",
          },
          user,
        );
      const output = {
        pages: noop
          ? []
          : [
              {
                id: page,
                slug: "guide",
                title: current.title,
                body: `${current.body}\n\nVerified current behavior.`,
                parentSlug: null,
                sources: ["src/main.ts", "drizzle/0000_auth.sql", "src/web.css", "index.html"],
              },
            ],
      };
      if (progressive) {
        await fixtureValue(input.publish, "input.publish")(output);
        if (interruptAfterPackage) throw new Error("Lost worker after checked publication");
        return { pages: [] };
      }
      return output;
    });
    const completed = () =>
      eventually(
        () => wiki.generation(project),
        (value) => value?.["state"] === "succeeded" || value?.["state"] === "failed",
        "Generation did not finish",
      );
    try {
      await db.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${user},'Wiki developer',${`wiki-generation-${user}@factory.local`},true)`;
      await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${project},${`wiki-generation-${project}`},'Wiki fixture','http://127.0.0.1:9/owned/wiki.git','main','.devcontainer/devcontainer.json',${user})`;
      await db.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${user},'product-contributor',${user})`;
      await db.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by,icon,sort_order) VALUES(${page},${project},'guide','Human guide','Original business purpose.','Original business purpose.',${commit},${user},'home',7)`;
      await Promise.all([wiki.generate(project, user), wiki.generate(project, user)]);
      const initial = await completed();
      expect(inventoryReceived).toContain("drizzle/0000_auth.sql");
      expect(initial?.["state"]).toBe("succeeded");
      // The final checked publication completes the progress the workflow recorded.
      expect(initial?.["progress"]).toEqual({
        phase: "done",
        topicsTotal: 2,
        topicsDone: 2,
        currentTopic: null,
      });
      expect(calls).toBe(2);
      const [saved] = await db.client<
        Array<{ body: string; icon: string; order: number; version: number }>
      >`SELECT current_body AS body,icon,sort_order AS "order",version::integer AS version FROM factory.knowledge_page WHERE id=${page}`;
      expect(saved?.body).toBe(
        "Human business purpose added during analysis.\n\nVerified current behavior.",
      );
      expect(saved?.icon).toBe("home");
      expect(saved?.order).toBe(7);
      const revisions = await wiki.history(page, user);
      expect(revisions).toHaveLength(2);
      expect(revisions[0]?.["kind"]).toBe("generated");
      noop = true;
      commit = "c".repeat(40);
      await wiki.reconcile(project);
      expect((await completed())?.["state"]).toBe("succeeded");
      expect(await wiki.history(page, user)).toHaveLength(2);
      if (progressive) {
        process.env["FACTORY_MODEL_API_KEY"] = "controlled";
        commit = "f".repeat(40);
        failure = false;
        noop = false;
        interruptAfterPackage = true;
        await wiki.generate(project, user);
        const interrupted = await completed();
        expect(interrupted?.["state"]).toBe("failed");
        const retained = await wiki.history(page, user);
        expect(retained).toHaveLength(3);
        await db.client`UPDATE factory.knowledge_generation SET state='running',attempt_id=${crypto.randomUUID()},completed_at=NULL WHERE id=${String(interrupted?.["id"])}`;
        interruptAfterPackage = false;
        noop = true;
        expectedCompleted = [page];
        await wiki.recover();
        const recovered = await completed();
        expect(recovered?.["id"]).toBe(interrupted?.["id"]);
        expect(recovered?.["state"]).toBe("succeeded");
        expect(await wiki.history(page, user)).toHaveLength(3);
        expectedCompleted = undefined;
      }
      const priorCalls = calls;
      await wiki.reconcile(project);
      expect(calls).toBe(priorCalls);
      failure = true;
      commit = "d".repeat(40);
      await wiki.reconcile(project);
      expect((await completed())?.["state"]).toBe("failed");
      expect((await wiki.generation(project))?.["failure"]).not.toContain("controlled-private-key");
      const failedGeneration = await wiki.generation(project);
      const failedCalls = calls;
      await wiki.reconcile(project);
      await wiki.settle();
      expect((await wiki.generation(project))?.["id"]).toBe(failedGeneration?.["id"]);
      expect(calls).toBe(failedCalls);
      await wiki.generate(project, user);
      await wiki.settle();
      expect((await wiki.generation(project))?.["id"]).not.toBe(failedGeneration?.["id"]);
      expect(calls).toBe(failedCalls + 1);
      const [retained] = await db.client<
        Array<{ body: string }>
      >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${page}`;
      expect(retained?.body).toBe(
        progressive ? `${saved?.body}\n\nVerified current behavior.` : saved?.body,
      );
      for (const [index, cause, message] of [
        ["1", new WikiTopicPlanError("Unknown seed paths: controlled-private-key"), "topic plan"],
        [
          "2",
          new WikiTopicQualityError("private-topic", ["controlled-private-key"]),
          "source and quality checks",
        ],
        ["3", new ModelExecutionBoundError("requests"), "configured model execution bounds"],
        ["4", new WikiSourceEvidenceError(["controlled-private-key"]), "had not inspected"],
      ] as const) {
        failureCause = cause;
        commit = index.repeat(40);
        await wiki.generate(project, user);
        const outcome = await completed();
        expect(outcome?.["state"]).toBe("failed");
        expect(outcome?.["failure"]).toContain(message);
        expect(outcome?.["failure"]).not.toContain("controlled-private-key");
        expect(await wiki.history(page, user)).toHaveLength(progressive ? 3 : 2);
      }
      delete process.env["FACTORY_MODEL_API_KEY"];
      commit = "e".repeat(40);
      await wiki.generate(project, user);
      expect((await completed())?.["state"]).toBe("failed");
      expect(await wiki.history(page, user)).toHaveLength(progressive ? 3 : 2);
    } finally {
      await wiki.settle();
      await db.client.end();
      await owned.dispose();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  30_000,
);
