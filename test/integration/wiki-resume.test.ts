import { expect, test } from "bun:test";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { ModelExecutionBoundError } from "../../apps/factory/src/models/execution-policy";
import { factoryProcess } from "../fixtures/factory-process";

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
          if (partial) await input.publish!(output);
          throw new ModelExecutionBoundError("requests");
        }
        return output;
      },
    );
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Wiki owner',${`${userID}@factory.invalid`})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`resume-wiki-${projectID}`},'Resume Wiki fixture','http://127.0.0.1:9/owned/wiki.git','main','.devcontainer/devcontainer.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},'developer',${userID})`;
      await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,page_count,created_by,completed_at)
        VALUES(${initialGenerationID},${projectID},${commit},'succeeded',1,${userID},now())`;
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
