import { expect, test } from "bun:test";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";

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
    const reader = {
      getDefaultBranch: async () => ({ name: "main", headSha: commit }),
      listFiles: async () => [
        { path: "src/main.ts", sha: commit, size: 32 },
        { path: "package.json", sha: "b".repeat(40), size: 10 },
      ],
      getFileInfo: async (_repo: unknown, path: string) => ({
        sha: path === "package.json" ? "b".repeat(40) : commit,
        content: path === "package.json" ? '{"name":"app"}' : "export const behavior='current';",
      }),
    };
    const wiki = createKnowledgeController(db, reader, async (input) => {
      calls++;
      if (failure) throw new Error("Provider failure including controlled-private-key");
      await input.readFiles(["src/main.ts"]);
      const current = input.pages.find((value) => value.id === page);
      if (!current) throw new Error("Missing current Wiki fixture");
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
                sources: ["src/main.ts"],
              },
            ],
      };
      if (progressive) {
        await input.publish!(output);
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
      expect((await completed())?.["state"]).toBe("succeeded");
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
        await wiki.recover();
        const recovered = await completed();
        expect(recovered?.["id"]).toBe(interrupted?.["id"]);
        expect(recovered?.["state"]).toBe("succeeded");
        expect(await wiki.history(page, user)).toHaveLength(3);
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
