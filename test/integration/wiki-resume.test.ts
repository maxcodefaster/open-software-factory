import { expect, test } from "bun:test";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { ModelExecutionBoundError } from "../../apps/factory/src/models/execution-policy";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test.each([false, true])(
  "an explicit Wiki retry reuses only checked partial publication at the same commit: partial=%j",
  async (partial) => {
    const owned = await factoryProcess();
    const database = owned.connect();
    const userID = crypto.randomUUID(),
      projectID = crypto.randomUUID(),
      pageID = crypto.randomUUID();
    const initialGenerationID = crypto.randomUUID(),
      initialRevisionID = crypto.randomUUID();
    const settings = {
      FACTORY_FORGEJO_API_URL: "http://127.0.0.1:9/api/v1/",
      FACTORY_FORGEJO_TOKEN: "controlled",
      FACTORY_FORGEJO_OWNER: "owned",
      FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      FACTORY_MODEL_API_KEY: "controlled",
      FACTORY_PROJECT_AGENT_MODEL: "controlled-wiki",
    };
    const previous = Object.fromEntries(
      Object.keys(settings).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, settings);
    let commit = "a".repeat(40),
      calls = 0;
    const wiki = createKnowledgeController(
      database,
      {
        getDefaultBranch: async () => ({ name: "main", headSha: commit }),
        listFiles: async () => [{ path: "src/main.ts", sha: commit, size: 64 }],
        getFileInfo: async () => ({ sha: commit, content: "export const current = true;" }),
      },
      async (input) => {
        calls++;
        await input.readFiles(["src/main.ts"]);
        expect(input.completedPageIDs).toEqual(calls === 2 && partial ? [pageID] : []);
        if (calls === 2 && partial) return { pages: [] };
        const output = {
          pages: [
            {
              id: pageID,
              slug: "guide",
              title: "Guide",
              body: `Checked source ${commit}.`,
              parentSlug: null,
              sources: ["src/main.ts"],
            },
          ],
        };
        if (calls === 1) {
          if (partial) await fixtureValue(input.publish, "input.publish")(output);
          throw new ModelExecutionBoundError("requests");
        }
        return output;
      },
    );
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Wiki owner',${`${userID}@factory.invalid`})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`resume-wiki-${projectID}`},'Resume Wiki fixture','http://127.0.0.1:9/owned/wiki.git','main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},'developer',${userID})`;
      await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,completed_at,payload)
        VALUES(${initialGenerationID},'knowledge.generation','project',${projectID},${`knowledge.generation:${initialGenerationID}`},NULL,'succeeded',${userID},now(),
          ${JSON.stringify({ id: initialGenerationID, projectId: projectID, sourceCommitSha: commit, pageCount: 1, conflictCount: null, failure: null, createdBy: userID, modelId: null, attemptId: null, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
      await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
        VALUES(${pageID},${projectID},'guide','Guide','Previous accepted guide.','Previous accepted guide.',${commit},${userID})`;
      await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,generation_id,created_by)
        VALUES(${initialRevisionID},${pageID},1,'generated','Guide','Previous accepted guide.','Previous accepted guide.',${commit},${initialGenerationID},${userID})`;
      await database.client`UPDATE factory.knowledge_page SET current_revision_id=${initialRevisionID} WHERE id=${pageID}`;
      await wiki.generate(projectID, userID);
      await wiki.settle();
      const failed = await wiki.generation(projectID);
      expect(failed?.["state"]).toBe("failed");
      await wiki.generate(projectID, userID);
      await wiki.settle();
      const retried = await wiki.generation(projectID);
      expect(retried?.["id"]).not.toBe(failed?.["id"]);
      expect(retried?.["state"]).toBe("succeeded");
      expect(calls).toBe(2);
      expect(await wiki.history(pageID, userID)).toHaveLength(2);
      commit = "b".repeat(40);
      await wiki.generate(projectID, userID);
      await wiki.settle();
      expect((await wiki.generation(projectID))?.["state"]).toBe("succeeded");
      expect(calls).toBe(3);
      expect(await wiki.history(pageID, userID)).toHaveLength(3);
    } finally {
      await wiki.settle();
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

test("Wiki shutdown aborts admitted analysis without publishing or changing a manual revision", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const pageID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const commit = "a".repeat(40);
  const entered = Promise.withResolvers<void>();
  const settings = {
    FACTORY_FORGEJO_API_URL: "http://127.0.0.1:9/api/v1/",
    FACTORY_FORGEJO_TOKEN: "controlled",
    FACTORY_FORGEJO_OWNER: "owned",
    FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
    FACTORY_MODEL_API_KEY: "controlled",
    FACTORY_PROJECT_AGENT_MODEL: "controlled-wiki",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const wiki = createKnowledgeController(
    database,
    {
      getDefaultBranch: async () => ({ name: "main", headSha: commit }),
      listFiles: async () => [{ path: "src/main.ts", sha: commit, size: 64 }],
      getFileInfo: async () => ({ sha: commit, content: "export const current = true;" }),
    },
    async (input) => {
      const signal = fixtureValue(input.signal, "Wiki lifetime signal");
      entered.resolve();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    },
  );
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Wiki author',${`${userID}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectID},${`shutdown-${projectID}`},'Shutdown Wiki','http://127.0.0.1:9/owned/wiki.git',
        'main','.factory/actor-template.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${projectID},${userID},'product-contributor',${userID})`;
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageID},${projectID},'guide','Guide','Manual product framing.','Previous base.',${commit},${userID})`;
    await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
      VALUES(${revisionID},${pageID},1,'human','Guide','Manual product framing.','Previous base.',${commit},${userID})`;
    await database.client`UPDATE factory.knowledge_page SET current_revision_id=${revisionID} WHERE id=${pageID}`;
    const admitted = await wiki.generate(projectID, userID);
    await entered.promise;
    await wiki.close();
    const stopped = await wiki.generation(projectID);
    expect(stopped?.id).toBe(admitted?.id);
    expect(stopped?.state).toBe("failed");
    const [page] = await database.client`
      SELECT current_body AS body,current_revision_id AS revision,version::integer AS version
      FROM factory.knowledge_page WHERE id=${pageID}`;
    expect(page).toEqual({ body: "Manual product framing.", revision: revisionID, version: 1 });
    expect(await wiki.history(pageID, userID)).toHaveLength(1);
    await expect(wiki.generate(projectID, userID)).rejects.toThrow("shutting down");
  } finally {
    await wiki.close();
    await database.client.end();
    await owned.dispose();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}, 30_000);
