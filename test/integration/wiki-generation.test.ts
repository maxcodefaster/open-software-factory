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
import { type createDatabase, drizzleTransaction } from "../../packages/db/src/client";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test.each(["version", "revision", "state"] as const)(
  "offline Wiki publication wiring keeps baselines private and fences changed %s",
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
      slug: "guide",
      title: "Guide",
      body: "The color is green.",
      generatedBody: "The color is blue.",
    };
    const rows = [row, inline];
    const revisions: unknown[][] = [];
    let pageWrites = 0;
    let pageCount = 0;
    let state = "pending";
    let calls = 0;
    let transactionDepth = 0;
    const typedReads: Array<{ query: string; parameters: unknown[] }> = [];
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
    // Replace PostgreSQL I/O, retaining the actual Drizzle builders and result mapping.
    const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?").replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT pg_advisory_xact_lock")) return [];
      if (
        text ===
        'SELECT connection_id AS "connectionID", connection_version::float8 AS version FROM factory.model_role_connection WHERE role=?'
      ) {
        expect(values).toEqual(["planning"]);
        return [];
      }
      if (text.includes("FROM factory.usage_operation")) return [];
      if (text.includes("FROM factory.project WHERE"))
        return [
          {
            id: projectID,
            name: "Overview",
            repositoryURL: "https://forge.invalid/owned/wiki",
            defaultBranch: "main",
          },
        ];
      if (text.startsWith("UPDATE factory.knowledge_generation SET state = 'running'")) {
        state = "running";
        return [{ projectID, commitSha: commit, userID, modelId: "controlled-wiki" }];
      }
      if (text.startsWith("UPDATE factory.knowledge_generation SET state = 'failed'")) {
        state = "failed";
        throw new Error(`Unexpected generation failure: ${String(values[0])}`);
      }
      if (text.startsWith("UPDATE factory.knowledge_generation SET page_count")) {
        pageCount += Number(values[0]);
        if (values[2]) state = "succeeded";
        return [];
      }
      if (text.startsWith("UPDATE factory.knowledge_generation")) return [];
      if (text.startsWith("SELECT COALESCE(current.page_count"))
        return [{ pageCount, previousState: null, previousCount: null, previousCommit: null }];
      if (text.startsWith("SELECT page.id FROM factory.knowledge_page"))
        return pageCount ? [{ id: row.id }] : [];
      if (text.includes("FROM factory.knowledge_generation")) {
        if (text.includes('AS "connectionID"')) return [{ connectionID: null, version: null }];
        if (text.includes("state='pending'")) return [];
        if (text.includes("state='succeeded'")) return [];
        return [{ id: generationID }];
      }
      if (text.startsWith("SELECT COALESCE(MAX(ordinal)"))
        return [{ ordinal: revisions.length + 4 }];
      if (text.startsWith("INSERT INTO factory.knowledge_revision")) {
        revisions.push(values);
        return [];
      }
      if (text.startsWith("UPDATE factory.knowledge_page SET title")) {
        pageWrites++;
        const saved = fixtureValue(
          rows.find((page) => page.id === values[7]),
          "updated page",
        );
        saved.title = String(values[0]);
        saved.version += Number(values[1]);
        saved.revisionId = String(values[2]);
        saved.body = String(values[3]);
        saved.generatedBody = String(values[4]);
        return [];
      }
      if (text.includes("FROM factory.knowledge_page"))
        return rows.map(({ generatedBody, ...page }) =>
          text.includes('generated_body AS "generatedBody"')
            ? { ...page, generatedBody }
            : { ...page },
        );
      throw new Error(`Unhandled offline statement: ${text}`);
    };
    const modelRoleRead = [
      'select "factory"."model_role_connection"."role", "factory"."model_connection_version"."provider",',
      '"factory"."model_role_connection"."model_id", "factory"."model_connection_version"."endpoint"',
      'from "factory"."model_role_connection" inner join "factory"."model_connection_version"',
      'on ("factory"."model_connection_version"."connection_id" = "factory"."model_role_connection"."connection_id"',
      'and "factory"."model_connection_version"."version" = "factory"."model_role_connection"."connection_version")',
    ].join(" ");
    const client = Object.assign(sql, {
      unsafe(query: string, parameters: unknown[]) {
        typedReads.push({ query, parameters });
        expect(transactionDepth).toBeGreaterThan(0);
        let values: unknown[][];
        switch (query) {
          case 'select "id" from "auth"."user" where "auth"."user"."id" = $1 for share':
            expect(parameters).toEqual([userID]);
            values = [[userID]];
            break;
          case 'select "disabled_at", "directory_disabled_at" from "factory"."account_access" where "factory"."account_access"."user_id" = $1 for share':
            expect(parameters).toEqual([userID]);
            values = [[null, null]];
            break;
          case 'select "role", "manage_project" from "factory"."project_membership" where ("factory"."project_membership"."project_id" = $1 and "factory"."project_membership"."user_id" = $2) for share':
            expect(parameters).toEqual([projectID, userID]);
            values = [["developer", false]];
            break;
          case 'select "user_id" from "factory"."administrator" where "factory"."administrator"."user_id" = $1 for share':
            expect(parameters).toEqual([userID]);
            values = [];
            break;
          case 'select "id" from "factory"."project" where "factory"."project"."id" = $1':
            expect(parameters).toEqual([projectID]);
            values = [[projectID]];
            break;
          case modelRoleRead:
            expect(parameters).toEqual([]);
            values = [];
            break;
          case 'select "version", "planning_model_id", "build_model_id", "role_rules" from "factory"."model_defaults" where "factory"."model_defaults"."singleton" = $1':
            expect(parameters).toEqual([true]);
            values = [];
            break;
          case 'select "version", "planning", "build" from "factory"."project_model_settings" where "factory"."project_model_settings"."project_id" = $1':
            expect(parameters).toEqual([projectID]);
            values = [];
            break;
          case 'select "version", "planning_model_id", "build_model_id" from "factory"."personal_model_settings" where ("factory"."personal_model_settings"."project_id" = $1 and "factory"."personal_model_settings"."user_id" = $2)':
            expect(parameters).toEqual([projectID, userID]);
            values = [];
            break;
          default:
            throw new Error(`Unhandled offline Drizzle statement: ${query}`);
        }
        return Object.assign(Promise.resolve(values), { values: async () => values });
      },
      async begin<T>(work: (transaction: typeof sql) => Promise<T>) {
        transactionDepth++;
        try {
          return await work(sql);
        } finally {
          transactionDepth--;
        }
      },
    });
    const database = {
      client,
      db: drizzleTransaction(client as unknown as ReturnType<typeof createDatabase>["client"]),
    } as unknown as ReturnType<typeof createDatabase>;
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
          expect(row.generatedBody).toBe("Current generated overview.");
          expect(revisions[0]?.[4]).toBe(checked.pages[0]?.body);
          expect(revisions[0]?.[5]).toBe("Current generated overview.");
          const next = output("A later generated overview.");
          expect(prepare(next).pages[0]?.body).toBe(`A later generated overview.\n\n${note}`);
          // The private baseline refreshed after progressive publication, but a
          // subsequent human edit must invalidate that checked snapshot, not rebase it.
          if (drift === "state") inline.state = "archived";
          else {
            row.body += "\n\nA concurrent human note.";
            if (drift === "version") row.version++;
            else row.revisionId = crypto.randomUUID();
          }
          await expect(publish(next)).rejects.toThrow(WikiPublicationConflict);
          expect(pageWrites).toBe(1);
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
      await wiki.recover();
      await wiki.settle();
      expect(calls).toBe(2);
      expect(typedReads.filter(({ query }) => query === modelRoleRead)).toHaveLength(1);
      expect(
        typedReads.filter(({ query }) => query.includes('from "factory"."model_defaults"')),
      ).toHaveLength(1);
      expect(
        typedReads.filter(({ query }) => query.includes('from "factory"."project_model_settings"')),
      ).toHaveLength(1);
      expect(
        typedReads.filter(({ query }) =>
          query.includes('from "factory"."personal_model_settings"'),
        ),
      ).toHaveLength(1);
      expect(state).toBe("succeeded");
      expect(pageWrites).toBe(1);
      expect(row.generatedBody).toBe("Current generated overview.");
      expect(row.body).toBe(
        `Current generated overview.\n\n${note}${drift === "state" ? "" : "\n\nA concurrent human note."}`,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await wiki.close();
      fetch.mockRestore();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  10_000,
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
