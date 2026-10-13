import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";

test("Wiki saves deduplicate retry, reject stale writes and restore immutably with current authority", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const userId = crypto.randomUUID(),
    outsider = crypto.randomUUID(),
    projectId = crypto.randomUUID(),
    pageId = crypto.randomUUID();
  const previous = Object.fromEntries(
    ["FACTORY_FORGEJO_API_URL", "FACTORY_FORGEJO_TOKEN", "FACTORY_FORGEJO_OWNER"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env["FACTORY_FORGEJO_API_URL"] = "http://127.0.0.1:9/api/v1/";
  process.env["FACTORY_FORGEJO_TOKEN"] = "unused-test-token";
  process.env["FACTORY_FORGEJO_OWNER"] = "owned";
  const knowledge = createKnowledgeController(database);
  try {
    for (const id of [userId, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Wiki author',${`wiki-revisions-${id}@factory.local`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectId},${`wiki-revisions-${projectId}`},'Revision fixture','https://example.invalid/owned/wiki.git','main','.devcontainer/devcontainer.json',${userId})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectId},${userId},'product-contributor',${userId})`;
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by) VALUES(${pageId},${projectId},'guide','Guide','Original.','Original.',${"a".repeat(40)},${userId})`;
    const saved = await knowledge.edit(
      pageId,
      { expectedVersion: 1, title: "Guide", body: "Human revision." },
      userId,
    );
    expect(saved.version).toBe(2);
    const repeated = await knowledge.edit(
      pageId,
      { expectedVersion: 1, title: "Guide", body: "Human revision." },
      userId,
    );
    expect(repeated.revisionId).toBe(saved.revisionId);
    await expect(
      knowledge.edit(pageId, { expectedVersion: 1, title: "Guide", body: "Stale." }, userId),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      knowledge.edit(
        pageId,
        { expectedVersion: 2, title: "Guide", body: "Unauthorized." },
        outsider,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const latest = await knowledge.edit(
      pageId,
      { expectedVersion: 2, title: "Guide", body: "Newer revision." },
      userId,
    );
    if (!saved.revisionId) throw new Error("Missing immutable revision");
    const restored = await knowledge.restore(pageId, saved.revisionId, latest.version, userId);
    expect(restored.body).toBe("Human revision.");
    expect(restored.revisionId).not.toBe(saved.revisionId);
    const revisions = await knowledge.history(pageId, userId);
    expect(revisions).toHaveLength(3);
    expect(revisions[0]).not.toHaveProperty("sourceCommitSha");
    expect(revisions[0]).not.toHaveProperty("generatedBody");
    expect(revisions[0]).not.toHaveProperty("citations");
    await expect(knowledge.sources(pageId, userId)).rejects.toMatchObject({ status: 403 });
    await expect(knowledge.history(pageId, outsider)).rejects.toMatchObject({ status: 404 });
    await database.client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${projectId} AND user_id=${userId}`;
    expect((await knowledge.history(pageId, userId))[0]).toHaveProperty("sourceCommitSha");
    expect(await knowledge.sources(pageId, userId)).toEqual({ citations: [] });
    expect(revisions[1]?.["body"]).toBe("Newer revision.");
    const child = crypto.randomUUID();
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,parent_id,current_body,generated_body,source_commit_sha,created_by) VALUES(${child},${projectId},'child','Child',${pageId},'Child.','Child.',${"a".repeat(40)},${userId})`;
    await knowledge.archive(pageId, restored.version, userId);
    const [activeChild] = await database.client<
      Array<{ parentId: string | null; state: string }>
    >`SELECT parent_id AS "parentId",state FROM factory.knowledge_page WHERE id=${child}`;
    expect(activeChild).toEqual({ parentId: null, state: "active" });
    await expect(
      knowledge.edit(
        pageId,
        { expectedVersion: restored.version, title: "Guide", body: "Resurrect." },
        userId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await database.client.end();
    await owned.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);
