import { expect, test } from "bun:test";
import type { WikiPageSnapshot } from "#knowledge-domain/generation";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { editKnowledgeIn } from "../../apps/factory/src/knowledge/edit";
import { publishWikiPackage } from "../../apps/factory/src/knowledge/publication";
import { factoryProcess } from "../fixtures/factory-process";

test.each([
  { repeated: false, conflict: false },
  { repeated: true, conflict: false },
  { repeated: false, conflict: true },
])(
  "regeneration retains human text, separate generated bases and atomic conflicts: %j",
  async ({ repeated, conflict }) => {
    const owned = await factoryProcess();
    const database = owned.connect();
    const userID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const pageID = crypto.randomUUID();
    const humanRevision = crypto.randomUUID();
    const outsiderID = crypto.randomUUID();
    const note =
      "Manual acceptance note: use synthetic requests only. Do not enter customer personal data.";
    const base = conflict ? "The color is blue." : "The application is still a starter.";
    const human = conflict ? "The color is green." : `${base}\n\n${note}`;
    try {
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${userID},'Wiki owner',${`${userID}@factory.invalid`})`;
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${outsiderID},'Unrelated author',${`${outsiderID}@factory.invalid`})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`human-wiki-${projectID}`},'Human Wiki fixture','https://forge.invalid/owned/wiki.git','main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},'developer',${userID})`;
      await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
        VALUES(${pageID},${projectID},'overview','Overview',${base},${base},${"a".repeat(40)},${userID})`;
      await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
        VALUES(${humanRevision},${pageID},1,'human','Overview',${human},${base},${"a".repeat(40)},${userID})`;
      await database.client`UPDATE factory.knowledge_page SET current_revision_id=${humanRevision},
        current_body=${human},version=2 WHERE id=${pageID}`;
      const drafts = conflict
        ? ["The color is red."]
        : [
            "Staff can now manage their own persisted support requests.",
            "Staff can reopen resolved support requests and combine filters.",
          ];
      for (const [index, draft] of drafts.entries()) {
        const generationID = crypto.randomUUID();
        const attemptID = crypto.randomUUID();
        const sha = String(index + 1).repeat(40);
        await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,payload)
          VALUES(${generationID},'knowledge.generation','project',${projectID},${`knowledge.generation:${generationID}`},${`knowledge.generation:${projectID}`},'running',${userID},
            ${JSON.stringify({ id: generationID, projectId: projectID, sourceCommitSha: sha, pageCount: null, conflictCount: null, failure: null, createdBy: userID, modelId: null, attemptId: attemptID, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
        const pages = await database.client<WikiPageSnapshot[]>`
          SELECT id,slug,title,current_body AS body,version::int AS version,
            current_revision_id AS "revisionId",parent_id AS "parentId",state,citations
          FROM factory.knowledge_page WHERE id=${pageID}`;
        const input = {
          generationID,
          attemptID,
          projectID,
          userID,
          commitSha: sha,
          pages,
          complete: true,
          output: {
            pages: [
              {
                id: pageID,
                slug: "overview",
                title: "Overview",
                parentSlug: null,
                body: repeated ? `${draft}\n\n${note}` : draft,
                sources: ["src/app.ts"],
              },
              ...(conflict
                ? [
                    {
                      id: null,
                      slug: "unpublished-child",
                      title: "Unpublished child",
                      parentSlug: "overview",
                      body: "This package must roll back.",
                      sources: ["src/app.ts"],
                    },
                  ]
                : []),
            ],
          },
        };
        await expect(
          publishWikiPackage(database, { ...input, userID: outsiderID }),
        ).rejects.toThrow("Project not found");
        await expect(
          publishWikiPackage(database, { ...input, attemptID: crypto.randomUUID() }),
        ).rejects.toThrow("no longer owns publication");
        const publication = publishWikiPackage(database, input);
        if (conflict) await expect(publication).rejects.toThrow("overlaps human text edits");
        else await publication;
        const [saved] = await database.client<
          Array<{ body: string; generated: string; sha: string }>
        >`
          SELECT current_body AS body,generated_body AS generated,source_commit_sha AS sha
          FROM factory.knowledge_page WHERE id=${pageID}`;
        expect(saved).toEqual(
          conflict
            ? { body: human, generated: base, sha: "a".repeat(40) }
            : { body: `${draft}\n\n${note}`, generated: draft, sha },
        );
        if (conflict) {
          const pages =
            await database.client`SELECT id FROM factory.knowledge_page WHERE project_id=${projectID}`;
          expect(pages).toHaveLength(1);
        }
      }
      const [original] = await database.client<Array<{ body: string; kind: string }>>`
        SELECT body,kind FROM factory.knowledge_revision WHERE id=${humanRevision}`;
      expect(original).toEqual({ body: human, kind: "human" });
    } finally {
      await database.client.end();
      await owned.dispose();
    }
  },
  30_000,
);

test("Wiki publication waits on the Project lock and rejects a concurrent manual revision atomically", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const pageID = crypto.randomUUID();
  const generationID = crypto.randomUUID();
  const attemptID = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writer: Promise<unknown> | undefined;
  let publication: ReturnType<typeof publishWikiPackage> | undefined;
  let knowledge: ReturnType<typeof createKnowledgeController> | undefined;
  const configuration = {
    FACTORY_FORGEJO_API_URL: "https://forge.invalid/api/v1/",
    FACTORY_FORGEJO_OWNER: "owned",
    FACTORY_FORGEJO_TOKEN: "owned-unused-token",
  };
  const before = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, configuration);
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Wiki author',${`${userID}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
      VALUES(${projectID},${`lock-${projectID}`},'Publication lock','https://forge.invalid/owned/wiki.git',
        'main','.factory/actor-template.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${projectID},${userID},'developer',${userID})`;
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageID},${projectID},'guide','Guide','Previous guide.','Previous guide.',${"a".repeat(40)},${userID})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,created_by,payload)
      VALUES(${generationID},'knowledge.generation','project',${projectID},${`knowledge.generation:${generationID}`},${`knowledge.generation:${projectID}`},'running',${userID},
        ${JSON.stringify({ id: generationID, projectId: projectID, sourceCommitSha: "b".repeat(40), pageCount: null, conflictCount: null, failure: null, createdBy: userID, modelId: null, attemptId: attemptID, modelConnectionId: null, modelConnectionVersion: null, progress: null })}::jsonb)`;
    const pages = await database.client<WikiPageSnapshot[]>`
      SELECT id,slug,title,current_body AS body,version::integer AS version,
        current_revision_id AS "revisionId",parent_id AS "parentId",state,citations
      FROM factory.knowledge_page WHERE id=${pageID}`;
    writer = database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.project WHERE id=${projectID} FOR UPDATE`;
      entered.resolve();
      await release.promise;
      return editKnowledgeIn(
        sql,
        pageID,
        {
          expectedVersion: 1,
          title: "Guide",
          body: "Manual product framing.",
        },
        userID,
      );
    });
    await entered.promise;
    publication = publishWikiPackage(database, {
      generationID,
      attemptID,
      projectID,
      userID,
      commitSha: "b".repeat(40),
      pages,
      complete: false,
      output: {
        pages: [
          {
            id: null,
            slug: "unpublished",
            title: "Unpublished",
            body: "Must not be saved.",
            parentSlug: null,
            sources: ["src/app.ts"],
          },
        ],
      },
    });
    let contended = false;
    for (let observation = 0; observation < 100; observation++) {
      const [lock] = await database.client<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND lower(query) LIKE '%for update%') AS waiting`;
      if (lock?.waiting) {
        contended = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(contended).toBe(true);
    release.resolve();
    await writer;
    expect(await publication).toBe(false);
    expect(await database.client`SELECT id FROM factory.knowledge_page`).toHaveLength(1);
    const [revision] = await database.client<{ kind: string; body: string }[]>`
      SELECT kind,body FROM factory.knowledge_revision WHERE page_id=${pageID}`;
    expect(revision).toEqual({ kind: "human", body: "Manual product framing." });
    const [generation] = await database.client<{ state: string; count: number | null }[]>`
      SELECT state,(payload->>'pageCount')::int AS count FROM factory.operation WHERE id=${generationID} AND kind='knowledge.generation'`;
    expect(generation).toEqual({ state: "running", count: null });
    let inferences = 0;
    knowledge = createKnowledgeController(database, undefined, async () => {
      inferences++;
      return { pages: [] };
    });
    const history = await knowledge.history(pageID, userID);
    const first = history[0];
    if (!first) throw new Error("Manual revision is missing");
    expect(first.sourceCommitSha).toBe("a".repeat(40));
    const [timestamp] = await database.client<{ at: string }[]>`
      SELECT created_at AS at FROM factory.knowledge_revision WHERE id=${first.id}`;
    if (!timestamp) throw new Error("Manual revision timestamp is missing");
    expect(first.createdAt).toBe(timestamp.at);
    expect(await knowledge.sources(pageID, userID)).toEqual({ citations: [] });
    const restored = await knowledge.restore(pageID, first.id, 2, userID);
    expect(restored.version).toBe(3);
    expect(restored.revisionId).not.toBe(first.id);
    const childID = crypto.randomUUID();
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,parent_id,
      current_body,generated_body,source_commit_sha,created_by)
      VALUES(${childID},${projectID},'child','Child',${pageID},'Retained child.','Retained child.',${"a".repeat(40)},${userID})`;
    await knowledge.archive(pageID, restored.version, userID);
    const [child] = await database.client`
      SELECT parent_id AS parent,state,version::int AS version,metadata_version::int AS metadata,
        current_body AS body FROM factory.knowledge_page WHERE id=${childID}`;
    expect(child).toEqual({
      parent: null,
      state: "active",
      version: 1,
      metadata: 2,
      body: "Retained child.",
    });
    expect(await knowledge.history(pageID, userID)).toHaveLength(2);
    expect(inferences).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled([writer, publication]);
    await knowledge?.close();
    await database.client.end();
    await owned.dispose();
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}, 30_000);
