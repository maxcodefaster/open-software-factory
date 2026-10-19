import { expect, test } from "bun:test";
import { publishWikiPackage } from "../../apps/factory/src/knowledge/publication";
import type { WikiPageSnapshot } from "../../packages/knowledge-domain/src/generation";
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
    const note =
      "Manual acceptance note: use synthetic requests only. Do not enter customer personal data.";
    const base = conflict ? "The color is blue." : "The application is still a starter.";
    const human = conflict ? "The color is green." : `${base}\n\n${note}`;
    try {
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${userID},'Wiki owner',${`${userID}@factory.invalid`})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`human-wiki-${projectID}`},'Human Wiki fixture','https://forge.invalid/owned/wiki.git','main','.devcontainer/devcontainer.json',${userID})`;
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
        await database.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,created_by,attempt_id)
          VALUES(${generationID},${projectID},${sha},'running',${userID},${attemptID})`;
        const pages = await database.client<WikiPageSnapshot[]>`
          SELECT id,slug,title,current_body AS body,version::int AS version,
            current_revision_id AS "revisionId",parent_id AS "parentId",state,citations
          FROM factory.knowledge_page WHERE id=${pageID}`;
        const publication = publishWikiPackage(database, {
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
        });
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
