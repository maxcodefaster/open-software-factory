import { expect, spyOn, test } from "bun:test";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { generateWiki } from "../../apps/factory/src/knowledge/generation-agent";
import {
  WikiHumanEditConflict,
  WikiSourceEvidenceError,
  WikiTopicPlanError,
  WikiTopicQualityError,
} from "../../apps/factory/src/knowledge/generation-failure";
import { WikiPublicationConflict } from "../../apps/factory/src/knowledge/publication";
import { ModelExecutionBoundError } from "../../apps/factory/src/models/execution-policy";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test.each(["version", "revision", "state"] as const)(
  "owned PostgreSQL Wiki publication keeps baselines private and fences changed %s",
  async (drift) => {
    const projectID = crypto.randomUUID();
    const userID = crypto.randomUUID();
    const generationID = crypto.randomUUID();
    const commit = "3e221e212b256976b9835629693c2a07b4c9396e";
    const note = "Human handover: arrange the review with the release team.";
    const base = "Old generated overview.";
    const row = {
      id: crypto.randomUUID(),
      slug: "overview",
      title: "Overview",
      body: `${base}\n\n${note}`,
      generatedBody: base,
      version: 3,
      revisionId: String(crypto.randomUUID()),
      parentId: null,
      state: "active",
      citations: [{ path: "README.md", commitSha: "a".repeat(40) }],
    };
    const inline = {
      ...row,
      id: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      slug: "guide",
      title: "Guide",
      body: "The color is green.",
      generatedBody: "The color is blue.",
    };
    const rows = [row, inline];
    let calls = 0;
    const owned = await factoryProcess();
    const database = owned.connect();
    const environment = {
      FACTORY_FORGEJO_API_URL: "https://forge.invalid/api/v1/",
      FACTORY_FORGEJO_PUBLIC_URL: "https://forge.invalid",
      FACTORY_FORGEJO_OWNER: "owned",
      FACTORY_FORGEJO_TOKEN: "offline-not-a-credential",
      FACTORY_MODEL_BASE_URL: "https://provider.invalid/v1",
      FACTORY_MODEL_API_KEY: "offline-not-a-credential",
      FACTORY_PLANNING_MODEL_BASE_URL: "https://provider.invalid/v1",
      FACTORY_PLANNING_MODEL_API_KEY: "offline-not-a-credential",
      FACTORY_PROJECT_AGENT_MODEL: "controlled-wiki",
      FACTORY_AGENT_MODEL_ID: "controlled-wiki",
      FACTORY_MODEL_PROVIDER: "openai",
      FACTORY_PLANNING_MODEL_PROVIDER: "openai",
      FACTORY_AUTH_SECRET: "offline-wiki-wiring-fixture-signing-secret",
    };
    const before = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network admitted"));
    const wiki = createKnowledgeController(
      database,
      {
        getDefaultBranch: async () => ({ name: "main", headSha: commit }),
        listFiles: async () => [{ path: "README.md", sha: "b".repeat(40), size: 20 }],
        getFileInfo: async () => ({
          sha: "b".repeat(40),
          content: "# Project\n\nCurrent guidance.",
        }),
      },
      async (input) => {
        calls++;
        expect(input.pages).toHaveLength(2);
        for (const page of input.pages) expect(page).not.toHaveProperty("generatedBody");
        const prepare = fixtureValue(input.preparePublication, "publication preparation");
        const publish = fixtureValue(input.publish, "checked publication");
        const output = (body: string, page = row) => ({
          pages: [
            {
              id: page.id,
              slug: page.slug,
              title: page.title,
              body,
              parentSlug: null,
              sources: ["README.md"],
            },
          ],
        });
        expect(() => prepare(output("The color is red.", inline))).toThrow(WikiHumanEditConflict);
        if (calls === 1) {
          const first = output("Current generated overview.");
          const checked = prepare(first);
          expect(checked.pages[0]?.body).toBe(`Current generated overview.\n\n${note}`);
          const published = await publish(first);
          for (const page of published) expect(page).not.toHaveProperty("generatedBody");
          expect(published.find((page) => page.id === row.id)?.body).toBe(checked.pages[0]?.body);
          const [saved] = await database.client<
            { body: string; generatedBody: string; version: number; revisionId: string }[]
          >`SELECT current_body AS body,generated_body AS "generatedBody",version::integer AS version,
            current_revision_id AS "revisionId" FROM factory.knowledge_page WHERE id=${row.id}`;
          Object.assign(row, fixtureValue(saved, "published page"));
          expect(row.generatedBody).toBe("Current generated overview.");
          const [revision] = await database.client<{ body: string; generated: string }[]>`
            SELECT body,generated_body AS generated FROM factory.knowledge_revision WHERE id=${row.revisionId}`;
          expect(revision).toEqual({
            body: checked.pages[0]?.body ?? "",
            generated: "Current generated overview.",
          });
          const next = output("A later generated overview.");
          expect(prepare(next).pages[0]?.body).toBe(`A later generated overview.\n\n${note}`);
          // The private baseline refreshed after progressive publication, but a
          // subsequent human edit must invalidate that checked snapshot, not rebase it.
          if (drift === "state") {
            inline.state = "archived";
            await database.client`UPDATE factory.knowledge_page SET state='archived' WHERE id=${inline.id}`;
          } else {
            row.body += "\n\nA concurrent human note.";
            if (drift === "version") row.version++;
            else {
              row.revisionId = crypto.randomUUID();
              await database.client`INSERT INTO factory.knowledge_revision(
                id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
                VALUES(${row.revisionId},${row.id},5,'human',${row.title},${row.body},
                  ${row.generatedBody},${commit},${userID})`;
            }
            await database.client`UPDATE factory.knowledge_page SET current_body=${row.body},
              version=${row.version},current_revision_id=${row.revisionId} WHERE id=${row.id}`;
          }
          await expect(publish(next)).rejects.toThrow(WikiPublicationConflict);
          expect(
            await database.client`SELECT id FROM factory.knowledge_revision WHERE kind='generated'`,
          ).toHaveLength(1);
          throw new WikiPublicationConflict("Retry the changed snapshot");
        }
        expect(calls).toBe(2);
        expect(input.completedPageIDs).toEqual([row.id]);
        if (drift === "state")
          expect(input.pages.find((page) => page.id === inline.id)?.state).toBe("archived");
        else
          expect(input.pages.find((page) => page.id === row.id)?.body).toContain(
            "A concurrent human note.",
          );
        return { pages: [] };
      },
    );
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Owned Wiki author',${`${userID}@factory.invalid`})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`wiring-${projectID}`},'Overview','https://forge.invalid/owned/wiki.git',
          'main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},'developer',${userID})`;
      for (const page of rows) {
        await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,
          generated_body,version,source_commit_sha,created_by)
          VALUES(${page.id},${projectID},${page.slug},${page.title},${page.body},${page.generatedBody},
            ${page.version},${"a".repeat(40)},${userID})`;
        await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,
          generated_body,source_commit_sha,created_by)
          VALUES(${page.revisionId},${page.id},3,'human',${page.title},${page.body},${page.generatedBody},
            ${"a".repeat(40)},${userID})`;
        await database.client`UPDATE factory.knowledge_page SET current_revision_id=${page.revisionId} WHERE id=${page.id}`;
      }
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,payload)
        VALUES(${generationID},'knowledge.generation','project',${projectID},${`knowledge.generation:${generationID}`},${`knowledge.generation:${projectID}`},'pending',${userID},
          ${JSON.stringify({ id: generationID, projectId: projectID, sourceCommitSha: commit, pageCount: null, conflictCount: null, failure: null, createdBy: userID, modelId: "controlled-wiki", attemptId: null, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
      await wiki.recover();
      await wiki.settle();
      expect(calls).toBe(2);
      expect((await wiki.generation(projectID))?.state).toBe("succeeded");
      expect(
        await database.client`SELECT id FROM factory.knowledge_revision WHERE kind='generated'`,
      ).toHaveLength(1);
      expect(row.generatedBody).toBe("Current generated overview.");
      expect(row.body).toBe(
        `Current generated overview.\n\n${note}${drift === "state" ? "" : "\n\nA concurrent human note."}`,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await wiki.close();
      fetch.mockRestore();
      await database.client.end();
      await owned.dispose();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  30_000,
);

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
      await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${project},${`readme-${project}`},'Hello World','http://127.0.0.1:9/owned/wiki','master','.factory/actor-template.json',${user})`;
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

test.each([
  ".factory/actor-template.json",
  "ops/native/project-runtime.json",
  "ops/native/project-runtime",
])(
  "Wiki bootstrap retains the configured native contract within its initial source budget: %s",
  async (actorTemplatePath) => {
    const owned = await factoryProcess();
    const database = owned.connect();
    const userID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const commit = "a".repeat(40);
    const settings = {
      FACTORY_FORGEJO_API_URL: "https://forge.invalid/api/v1/",
      FACTORY_FORGEJO_PUBLIC_URL: "https://forge.invalid",
      FACTORY_FORGEJO_OWNER: "owned",
      FACTORY_FORGEJO_TOKEN: "offline-not-a-credential",
      FACTORY_MODEL_BASE_URL: "https://provider.invalid/v1",
      FACTORY_MODEL_API_KEY: "offline-not-a-credential",
      FACTORY_PLANNING_MODEL_BASE_URL: "https://provider.invalid/v1",
      FACTORY_PLANNING_MODEL_API_KEY: "offline-not-a-credential",
      FACTORY_PROJECT_AGENT_MODEL: "controlled-wiki",
      FACTORY_AUTH_SECRET: "offline-native-wiki-fixture-signing-secret",
    };
    const previous = Object.fromEntries(
      Object.keys(settings).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, settings);
    const files = [
      { path: "README.md", content: "# Native Project\n" },
      { path: actorTemplatePath, content: '{"containers":[{"name":"work"}]}' },
      { path: ".factory/system.json", content: '{"apps":[]}' },
      ...Array.from({ length: 60 }, (_, index) => ({
        path: `packages/package-${index}/package.json`,
        content: JSON.stringify({ name: `package-${index}` }),
      })),
    ].map((file, index) => ({
      ...file,
      sha: (index + 1).toString(16).padStart(40, "0"),
      size: file.content.length,
    }));
    const packets: Array<{ sources: Array<{ path: string; content: string }> }> = [];
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network admitted"));
    const wiki = createKnowledgeController(
      database,
      {
        getDefaultBranch: async () => ({ name: "main", headSha: commit }),
        listFiles: async () => files,
        getFileInfo: async (_repository, path, revision) => {
          expect(revision).toBe(commit);
          const file = fixtureValue(
            files.find((candidate) => candidate.path === path),
            path,
          );
          return { sha: file.sha, content: file.content };
        },
      },
      async (input) => {
        packets.push(input);
        return { pages: [] };
      },
    );
    try {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${userID},'Native Wiki owner',${`native-wiki-${userID}@factory.invalid`},true)`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`native-wiki-${projectID}`},'Native Wiki','https://forge.invalid/owned/wiki.git',
          'main',${actorTemplatePath},${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},'developer',${userID})`;
      await wiki.generate(projectID, userID);
      await wiki.settle();
      expect(packets).toHaveLength(1);
      expect(packets[0]).toMatchObject({ actorTemplatePath });
      expect(packets[0]?.sources).toHaveLength(6);
      expect(packets[0]?.sources).toEqual(
        expect.arrayContaining(
          files
            .filter((file) => [actorTemplatePath, ".factory/system.json"].includes(file.path))
            .map(({ path, content }) => ({ path, content })),
        ),
      );
      expect((await wiki.generation(projectID))?.state).toBe("succeeded");
      expect(network).not.toHaveBeenCalled();
    } finally {
      await wiki.close();
      network.mockRestore();
      await database.client.end();
      await owned.dispose();
      for (const [key, value] of Object.entries(previous)) {
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
        >`SELECT NULLIF(payload->'progress','null'::jsonb) AS progress FROM factory.operation WHERE kind='knowledge.generation' AND scope_type='project' AND scope_id=${project} AND state='running'`;
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
      await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by) VALUES(${project},${`wiki-generation-${project}`},'Wiki fixture','http://127.0.0.1:9/owned/wiki.git','main','.factory/actor-template.json',${user})`;
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
        await db.client`UPDATE factory.operation SET state='running',active_key=${`knowledge.generation:${project}`},payload=jsonb_set(payload,'{attemptId}',to_jsonb(${crypto.randomUUID()}::text),true),completed_at=NULL WHERE id=${String(interrupted?.["id"])} AND kind='knowledge.generation'`;
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
