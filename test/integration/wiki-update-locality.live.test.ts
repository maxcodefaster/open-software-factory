import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateWiki } from "../../apps/factory/src/knowledge/generation-workflow";
import { publishWikiPackage } from "../../apps/factory/src/knowledge/publication";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";
import type { WikiPageSnapshot } from "../../packages/knowledge-domain/src/generation";
import { factoryProcess } from "../fixtures/factory-process";

test
  .skipIf(process.env["FACTORY_WIKI_UPDATE_LOCALITY_LIVE"] !== "1")
  .each(["internal-refactor", "changed-command"] as const)(
  "configured Wiki workflow preserves page locality after %s",
  async (change) => {
    const modelId = "gpt-6-luna";
    if (process.env["FACTORY_PROJECT_AGENT_MODEL"] !== modelId)
      throw new Error("Explicit Luna planning configuration is required");
    const directory = resolve(".factory/test-results/wiki-update-locality", crypto.randomUUID());
    await mkdir(directory, { recursive: true });
    const previousCommit = "a".repeat(40);
    const commit = "b".repeat(40);
    const humanNote = "Support staff keep closed requests for the weekly customer handover.";
    const page = (slug: string, title: string, body: string): WikiPageSnapshot => ({
      id: crypto.randomUUID(),
      slug,
      title,
      body,
      version: 3,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [{ path: "README.md", commitSha: previousCommit }],
    });
    const overview = page(
      "overview",
      "Support desk",
      `The support-desk library returns a copy of a request with status closed, keeping its other fields.\n\n${humanNote}\n\nSee [Local development](#wiki/development).`,
    );
    const development = page(
      "development",
      "Local development",
      "Run npm run dev for watch-mode checks. Run npm test for a single run. The closing test verifies status closed and preservation of the request id.",
    );
    development.parentId = overview.id;
    let pages = [overview, development];
    const command = change === "changed-command" ? "watch" : "dev";
    const sources = [
      {
        path: "README.md",
        content: `# Support desk\nThe library returns a copy of a request with status closed, keeping its other fields.\nRun npm run ${command} for watch-mode checks. Run npm test for a single run. The closing test verifies status closed and preservation of the request id.`,
      },
      {
        path: "package.json",
        content: JSON.stringify({
          name: "support-desk",
          scripts: { [command]: "node --test --watch", test: "node --test" },
        }),
      },
      {
        path: "src/closing.mjs",
        content:
          "export function closeTicket(ticket) { const status = 'closed'; return {...ticket, status}; }\n",
      },
      {
        path: "test/closing.test.mjs",
        content:
          "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {closeTicket} from '../src/closing.mjs'; test('closing retains the request',()=>assert.deepEqual(closeTicket({id:1,status:'open'}),{id:1,status:'closed'}));",
      },
    ];
    const owned = await factoryProcess();
    const database = owned.connect();
    const userID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const generationID = crypto.randomUUID();
    const attemptID = crypto.randomUUID();
    const proposedUpdates: Array<{ id: string | null; slug: string; body: string }> = [];
    let publications: Array<{ id: string; slug: string; body: string }> = [];
    async function snapshots() {
      return Array.from(
        await database.client<WikiPageSnapshot[]>`
          SELECT id,slug,title,current_body AS body,version::int AS version,
            current_revision_id AS "revisionId",parent_id AS "parentId",state,citations
          FROM factory.knowledge_page WHERE project_id=${projectID} ORDER BY sort_order,id`,
      );
    }
    const controller = new AbortController();
    const started = performance.now();
    let succeeded = false;
    try {
      await database.client`INSERT INTO auth."user"(id,name,email)
        VALUES(${userID},'Wiki locality owner',${`${userID}@factory.invalid`})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`locality-${projectID}`},'Support desk','https://forge.invalid/owned/locality.git','main','.devcontainer/devcontainer.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${projectID},${userID},'developer',${userID})`;
      for (const [index, page] of pages.entries()) {
        const generated = page.body.replace(`\n\n${humanNote}`, "");
        await database.client`INSERT INTO factory.knowledge_page
          (id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by,parent_id,sort_order,citations,version)
          VALUES(${page.id},${projectID},${page.slug},${page.title},${page.body},${generated},${previousCommit},${userID},${page.parentId},${index},${JSON.stringify(page.citations)}::jsonb,${page.version})`;
        await database.client`INSERT INTO factory.knowledge_revision
          (id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
          VALUES(${page.revisionId},${page.id},3,'human',${page.title},${page.body},${generated},${previousCommit},${userID})`;
        await database.client`UPDATE factory.knowledge_page SET current_revision_id=${page.revisionId}
          WHERE id=${page.id}`;
      }
      await database.client`INSERT INTO factory.knowledge_generation
        (id,project_id,source_commit_sha,state,created_by,attempt_id)
        VALUES(${generationID},${projectID},${commit},'running',${userID},${attemptID})`;
      pages = await snapshots();
      await generateWiki({
        name: "Support desk",
        commit,
        modelId,
        connection: projectModelConnection("knowledge"),
        pages,
        inventory: sources.map(({ path, content }) => ({
          path,
          sha: "c".repeat(40),
          size: Buffer.byteLength(content),
        })),
        changedPaths:
          change === "changed-command" ? ["README.md", "package.json"] : ["src/closing.mjs"],
        sources,
        readFiles: async (paths) =>
          paths.map((path) => {
            const source = sources.find((source) => source.path === path);
            if (!source) throw new Error("Unknown synthetic source");
            return source;
          }),
        publish: async (output) => {
          proposedUpdates.push(...output.pages);
          const published = await publishWikiPackage(database, {
            generationID,
            attemptID,
            projectID,
            userID,
            commitSha: commit,
            pages,
            output,
            complete: false,
          });
          if (published === false) throw new Error("Owned Wiki publication conflicted");
          pages = published;
          return pages;
        },
        signal: controller.signal,
      });
      publications = Array.from(
        await database.client<Array<{ id: string; slug: string; body: string }>>`
          SELECT p.id,p.slug,r.body FROM factory.knowledge_revision r
          JOIN factory.knowledge_page p ON p.id=r.page_id
          WHERE r.generation_id=${generationID} ORDER BY p.sort_order,r.ordinal`,
      );
      expect(pages).toHaveLength(2);
      expect(pages[0]).toEqual(overview);
      expect(pages[0]?.body).toContain(humanNote);
      if (change === "internal-refactor") {
        expect(publications).toEqual([]);
        expect(pages[1]).toEqual(development);
      } else {
        expect(publications).toHaveLength(1);
        expect(publications[0]?.id).toBe(development.id);
        expect(publications[0]?.slug).toBe(development.slug);
        expect(pages[1]?.body).toContain("npm run watch");
        expect(pages[1]?.body).not.toContain("npm run dev");
        expect(pages[1]?.body).toContain("npm test");
      }
      succeeded = true;
    } finally {
      controller.abort();
      try {
        await writeFile(
          resolve(directory, "result.json"),
          JSON.stringify(
            {
              change,
              modelId,
              succeeded,
              elapsedMS: Math.round(performance.now() - started),
              proposedUpdates,
              publications,
              pages,
              syntheticSourcesOnly: true,
              retainedInstallationChanged: false,
            },
            null,
            2,
          ),
        );
        console.log(JSON.stringify({ evidence: directory, change, succeeded }));
      } finally {
        await database.client.end();
        await owned.dispose();
      }
    }
  },
  300_000,
);
