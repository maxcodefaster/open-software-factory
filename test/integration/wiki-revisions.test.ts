import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { createKnowledgeService } from "../../apps/factory/src/knowledge/service";
import { createAccessController } from "../../apps/factory/src/access/controller";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { knowledgeHistorySchema, knowledgeSaveSchema } from "../../apps/factory/src/api-contracts";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";

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
  const origin = "https://owned-wiki-revisions.test";
  const endpoint = await compiledFactoryEndpoint({
    origin,
    services: {
      knowledge: createKnowledgeService({
        controller: knowledge,
        access: createAccessController(database),
        observeRetry: async () => {},
      }),
    } as unknown as FactoryServices,
    session: async (request) => ({
      user: { id: request.headers.get("x-owned-actor") === outsider ? outsider : userId },
    }),
    maintenance: async () => false,
    requireFresh: async () => {},
  });
  async function native(name: string, args: unknown[], actor = userId) {
    const result = await decodeResponse<ServerResult<unknown>>(
      await endpoint(await factoryFunctionRequest(origin, name, args, { "x-owned-actor": actor })),
    );
    if (!result) throw new Error("Owned Wiki function returned no result");
    return serverCall(Promise.resolve(result));
  }
  try {
    for (const id of [userId, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Wiki author',${`wiki-revisions-${id}@factory.local`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectId},${`wiki-revisions-${projectId}`},'Revision fixture','https://example.invalid/owned/wiki.git','main','.devcontainer/devcontainer.json',${userId})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectId},${userId},'product-contributor',${userId})`;
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by) VALUES(${pageId},${projectId},'guide','Guide','Original.','Original.',${"a".repeat(40)},${userId})`;
    const saved = knowledgeSaveSchema.parse(
      await native("saveKnowledgePage", [
        pageId,
        { expectedVersion: 1, title: "Guide", body: "Human revision." },
      ]),
    );
    expect(saved.version).toBe(2);
    const repeated = knowledgeSaveSchema.parse(
      await native("saveKnowledgePage", [
        pageId,
        { expectedVersion: 1, title: "Guide", body: "Human revision." },
      ]),
    );
    expect(repeated.revisionId).toBe(saved.revisionId);
    await expect(
      native("saveKnowledgePage", [pageId, { expectedVersion: 1, title: "Guide", body: "Stale." }]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      native(
        "saveKnowledgePage",
        [pageId, { expectedVersion: 2, title: "Guide", body: "Unauthorized." }],
        outsider,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const latest = knowledgeSaveSchema.parse(
      await native("saveKnowledgePage", [
        pageId,
        { expectedVersion: 2, title: "Guide", body: "Newer revision." },
      ]),
    );
    if (!saved.revisionId) throw new Error("Missing immutable revision");
    const restored = knowledgeSaveSchema.parse(
      await native("restoreKnowledgePage", [pageId, saved.revisionId, latest.version]),
    );
    expect(restored.body).toBe("Human revision.");
    expect(restored.revisionId).not.toBe(saved.revisionId);
    const { revisions } = knowledgeHistorySchema.parse(
      await native("getKnowledgeHistory", [pageId]),
    );
    expect(revisions).toHaveLength(3);
    expect(revisions[0]).not.toHaveProperty("sourceCommitSha");
    expect(revisions[0]).not.toHaveProperty("generatedBody");
    expect(revisions[0]).not.toHaveProperty("citations");
    expect(typeof revisions[0]?.createdAt).toBe("string");
    const originalDate = (await knowledge.history(pageId, userId))[0]?.["createdAt"];
    if (!(originalDate instanceof Date) && typeof originalDate !== "string")
      throw new Error("Owned revision timestamp is missing");
    expect(revisions[0]!.createdAt).toBe(
      originalDate instanceof Date ? originalDate.toISOString() : originalDate,
    );
    expect(Number.isFinite(new Date(revisions[0]!.createdAt).getTime())).toBe(true);
    await expect(native("getKnowledgeSources", [pageId])).rejects.toMatchObject({ status: 403 });
    await expect(native("getKnowledgeHistory", [pageId], outsider)).rejects.toMatchObject({
      status: 404,
    });
    await database.client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${projectId} AND user_id=${userId}`;
    expect(
      knowledgeHistorySchema.parse(await native("getKnowledgeHistory", [pageId])).revisions[0],
    ).toHaveProperty("sourceCommitSha");
    expect(await native("getKnowledgeSources", [pageId])).toEqual({ citations: [] });
    expect(revisions[1]?.["body"]).toBe("Newer revision.");
    const child = crypto.randomUUID();
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,parent_id,current_body,generated_body,source_commit_sha,created_by) VALUES(${child},${projectId},'child','Child',${pageId},'Child.','Child.',${"a".repeat(40)},${userId})`;
    await native("archiveKnowledgePage", [pageId, restored.version]);
    const [activeChild] = await database.client<
      Array<{ parentId: string | null; state: string }>
    >`SELECT parent_id AS "parentId",state FROM factory.knowledge_page WHERE id=${child}`;
    expect(activeChild).toEqual({ parentId: null, state: "active" });
    await expect(
      native("saveKnowledgePage", [
        pageId,
        { expectedVersion: restored.version, title: "Guide", body: "Resurrect." },
      ]),
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
