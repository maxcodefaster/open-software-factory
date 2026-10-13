import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";
import {
  moveKnowledgePage,
  setKnowledgePageIcon,
} from "../../packages/zero-schema/src/knowledge-server";

test("Wiki organization is authorized, race-safe and separate from text revisions", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const userId = crypto.randomUUID();
  const administrator = userId;
  const projectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    foreign = crypto.randomUUID();
  const move = (pageId: string, parentId: string | null, expectedMetadataVersion = 1) =>
    database.db.transaction((tx) =>
      moveKnowledgePage(tx, userId, {
        projectId,
        pageId,
        parentId,
        beforeId: null,
        expectedMetadataVersion,
      }),
    );
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userId},'Owned Wiki Developer',${`wiki-tree-${userId}@factory.local`},true)`;
    for (const id of [projectId, otherProjectId])
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${id},${`wiki-tree-${id}`},'Wiki tree','https://example.invalid/tree.git','main','.devcontainer/devcontainer.json',${administrator})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectId},${userId},'developer',${administrator})`;
    for (const [id, project, title, order] of [
      [a, projectId, "A", 0],
      [b, projectId, "B", 1],
      [foreign, otherProjectId, "Private", 0],
    ] as const)
      await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,sort_order,current_body,generated_body,source_commit_sha,created_by) VALUES(${id},${project},${`page-${id}`},${title},${order},'Human product framing.','Human product framing.',${"a".repeat(40)},${administrator})`;
    await expect(
      database.db.transaction((tx) =>
        moveKnowledgePage(tx, userId, {
          projectId: otherProjectId,
          pageId: foreign,
          parentId: null,
          beforeId: null,
          expectedMetadataVersion: 1,
        }),
      ),
    ).rejects.toThrow("Project not found");
    await expect(move(a, foreign)).rejects.toThrow("Parent page not found");
    await expect(move(a, a)).rejects.toThrow("cycle");
    const concurrent = await Promise.allSettled([move(a, b), move(b, a)]);
    expect(concurrent.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rows = await database.client<
      Array<{
        id: string;
        parentId: string | null;
        version: number;
        metadataVersion: number;
        body: string;
      }>
    >`SELECT id,parent_id AS "parentId",version::float8 AS version,metadata_version::float8 AS "metadataVersion",current_body AS body FROM factory.knowledge_page WHERE project_id=${projectId}`;
    expect(rows.every((row) => row.version === 1 && row.body === "Human product framing.")).toBe(
      true,
    );
    const moved = rows.find((row) => row.parentId);
    expect(moved).toBeDefined();
    if (!moved) throw new Error("Expected one moved page");
    await expect(move(moved.id, null)).rejects.toThrow("order changed");
    await database.db.transaction((tx) =>
      setKnowledgePageIcon(tx, userId, {
        projectId,
        pageId: moved.id,
        expectedMetadataVersion: moved.metadataVersion,
        icon: "home",
      }),
    );
    const [icon] = await database.client<
      Array<{ icon: string; version: number }>
    >`SELECT icon,version::float8 AS version FROM factory.knowledge_page WHERE id=${moved.id}`;
    expect(icon).toEqual({ icon: "home", version: 1 });
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${projectId} AND user_id=${userId}`;
    await expect(move(a, null, 3)).rejects.toThrow("Project not found");
    await expect(
      (async () => {
        await database.client`UPDATE factory.knowledge_page SET parent_id=${foreign} WHERE id=${a}`;
      })(),
    ).rejects.toThrow();
    await database.client`UPDATE factory.knowledge_page SET parent_id=NULL WHERE project_id=${projectId}`;
    const direct = await Promise.allSettled([
      database.client`UPDATE factory.knowledge_page SET parent_id=${b} WHERE id=${a}`,
      database.client`UPDATE factory.knowledge_page SET parent_id=${a} WHERE id=${b}`,
    ]);
    expect(direct.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  } finally {
    await database.client`DELETE FROM factory.knowledge_page WHERE project_id IN (${projectId},${otherProjectId})`;
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${projectId}`;
    await database.client`DELETE FROM factory.project WHERE id IN (${projectId},${otherProjectId})`;
    await database.client`DELETE FROM auth."user" WHERE id=${userId}`;
    await database.client.end();
    await owned.dispose();
  }
}, 90_000);
