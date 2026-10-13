import { expect, test } from "bun:test";
import { createDatabase } from "../../packages/db/src/client";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";

test("Wiki search combines active pages and source documents without repeating exact reads", async () => {
  const database = createDatabase(1);
  const projectID = crypto.randomUUID();
  const userID = "01994a7d-0000-7000-8000-000000000001";
  const owner = process.env["FACTORY_FORGEJO_OWNER"] ?? "factory-mutation";
  const previous = {
    FACTORY_FORGEJO_OWNER: process.env["FACTORY_FORGEJO_OWNER"],
    FACTORY_FORGEJO_API_URL: process.env["FACTORY_FORGEJO_API_URL"],
    FACTORY_FORGEJO_TOKEN: process.env["FACTORY_FORGEJO_TOKEN"],
  };
  process.env["FACTORY_FORGEJO_OWNER"] = owner;
  process.env["FACTORY_FORGEJO_API_URL"] ??= "http://forge.invalid/api/v1/";
  process.env["FACTORY_FORGEJO_TOKEN"] ??= "controlled-read-only";
  let commit = "a".repeat(40);
  const blob = "b".repeat(40);
  let treeReads = 0;
  let contentReads = 0;
  const knowledge = createKnowledgeController(database, {
    getDefaultBranch: async () => ({ name: "main", headSha: commit }),
    listFiles: async () => {
      treeReads += 1;
      return [{ path: "docs/nested/runbook.md", sha: blob, size: 30 }];
    },
    getFileInfo: async () => {
      contentReads += 1;
      return { sha: blob, content: "## Release\nRestart the web service safely." };
    },
  });
  try {
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`wiki-search-${projectID}`},'Wiki search',${`http://forge.invalid/${owner}/wiki.git`},'main','.devcontainer/devcontainer.json',${userID})`;
    for (const state of ["active", "archived"] as const) {
      await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,state,current_body,generated_body,source_commit_sha,created_by)
        VALUES(${crypto.randomUUID()},${projectID},${state},'Release overview',${state}::factory.knowledge_page_state,
        'Release safely with a rollback plan.','Release safely with a rollback plan.',${commit},${userID})`;
    }
    const contributor = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${contributor},'Wiki reader',${`wiki-reader-${projectID}@factory.local`},true)`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${contributor},'product-contributor',${userID})`;
    expect(
      (await knowledge.search(projectID, "release", contributor)).map((result) => result.kind),
    ).toEqual(["page"]);
    expect(treeReads).toBe(0);
    const results = await knowledge.search(projectID, "release", userID);
    expect(results.map((result) => result.kind).sort()).toEqual(["document", "page"]);
    expect(results.find((result) => result.kind === "document")?.path).toBe(
      "docs/nested/runbook.md",
    );
    expect(results.find((result) => result.kind === "page")?.snippet).toContain("rollback");
    await knowledge.documents(projectID);
    expect((await knowledge.document(projectID, "docs/nested/runbook.md")).body).toContain(
      "Restart",
    );
    await knowledge.search(projectID, "release", userID);
    expect(treeReads).toBe(1);
    expect(contentReads).toBe(1);
    commit = "c".repeat(40);
    await knowledge.search(projectID, "release", userID);
    expect(treeReads).toBe(2);
    expect(contentReads).toBe(1);
    await expect(knowledge.document(projectID, "../hidden.md")).rejects.toMatchObject({
      status: 404,
    });
    expect(contentReads).toBe(1);
  } finally {
    await database.client`DELETE FROM factory.knowledge_page WHERE project_id=${projectID}`;
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${projectID}`;
    await database.client`DELETE FROM auth."user" WHERE email=${`wiki-reader-${projectID}@factory.local`}`;
    await database.client`DELETE FROM factory.project WHERE id=${projectID}`;
    await database.client.end();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
