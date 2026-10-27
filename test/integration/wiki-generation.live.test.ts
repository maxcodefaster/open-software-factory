import { expect, spyOn, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { createWikiSourceUpdates } from "../../apps/factory/src/knowledge/source-updates";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { fixtureValue } from "../fixtures/value";

test
  .skipIf(process.env["FACTORY_WIKI_LIVE"] !== "1")
  .each(process.env["FACTORY_WIKI_LARGE_ONLY"] === "1" ? [true] : [false, true])(
  "real configured model updates a useful Wiki from changed source without losing human prose, large=%s",
  async (large) => {
    process.env["FACTORY_FORGEJO_API_URL"] ??= "http://127.0.0.1:33030/api/v1/";
    process.env["FACTORY_FORGEJO_OWNER"] ??= "factory-mutation";
    process.env["FACTORY_FORGEJO_TOKEN"] ??= (
      await readFile(".factory/forgejo-token", "utf8")
    ).trim();
    const owned = await factoryProcess();
    const db = owned.connect();
    const owner = process.env["FACTORY_FORGEJO_OWNER"];
    const api = process.env["FACTORY_FORGEJO_API_URL"];
    const token = process.env["FACTORY_FORGEJO_TOKEN"];
    const name = `wiki-live-${crypto.randomUUID().slice(0, 8)}`;
    const project = crypto.randomUUID(),
      user = crypto.randomUUID();
    let repositoryCreated = false;
    const modelOutputs = spyOn(Agent.prototype, "generate");
    let updates: ReturnType<typeof createWikiSourceUpdates> | undefined;
    const listener = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch: (request) => updates?.receive(request, project) ?? new Response(null, { status: 503 }),
    });
    async function forge(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${api.replace(/\/$/, "")}/${path}`, {
        method,
        headers: { authorization: `token ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`Owned Wiki forge ${method} failed with HTTP ${response.status}`);
      return response.status === 204 ? null : response.json();
    }
    async function file(path: string, content: string, sha?: string) {
      const value = (await forge(`repos/${owner}/${name}/contents/${path}`, sha ? "PUT" : "POST", {
        branch: "main",
        message: "Update owned Wiki source fixture",
        content: Buffer.from(content).toString("base64"),
        ...(sha ? { sha } : {}),
      })) as { content: { sha: string } };
      return value.content.sha;
    }
    let wiki: ReturnType<typeof createKnowledgeController> | undefined;
    const complete = () =>
      eventually(
        () => fixtureValue(wiki, "wiki").generation(project),
        (value) => ["succeeded", "failed"].includes(String(value?.["state"])),
        "Configured Wiki generation did not finish",
        200_000,
      );
    try {
      wiki = createKnowledgeController(db);
      await forge("user/repos", "POST", {
        name,
        private: true,
        auto_init: true,
        default_branch: "main",
      });
      repositoryCreated = true;
      await file("package.json", '{"name":"support-desk","scripts":{"test":"bun test"}}');
      let sourceSha = await file(
        "src/main.ts",
        "export function closeTicket(ticket: {status: string}) { return {...ticket, status: 'closed'}; }\n",
      );
      await file(
        "test/ticket.test.ts",
        "import {test,expect} from 'bun:test';\nimport {closeTicket} from '../src/main';\ntest('closed work is retained',()=>expect(closeTicket({status:'open'}).status).toBe('closed'));\n",
      );
      await file(
        "docs/product.md",
        "# Support desk\n\nSupport staff close solved customer requests. Closing keeps the request available in history.\n",
      );
      if (large) {
        await file(
          "README.md",
          "# Service operations\n\nSupport desk closes customer requests. Billing invoices accounts with a 14-day payment term. Fulfilment dispatches paid orders, rejects unpaid orders and records tracking. Inventory prevents overselling.\n\nEach module has focused tests; run bun test. No deployment configuration is provided.\n",
          ((await forge(`repos/${owner}/${name}/contents/README.md?ref=main`)) as { sha: string })
            .sha,
        );
        for (const [module, content, assertion] of [
          [
            "billing",
            "export function invoice(account:string) { return {account, dueDays:14}; }",
            "expect(invoice('customer').dueDays).toBe(14)",
          ],
          [
            "fulfilment",
            "export function dispatch(paid:boolean, tracking:string) { if (!paid) throw new Error('Payment required'); return {status:'dispatched',tracking}; }",
            "expect(()=>dispatch(false,'track')).toThrow('Payment required')",
          ],
          [
            "inventory",
            "export function reserve(stock:number, quantity:number) { if(quantity>stock) throw new Error('Insufficient stock'); return stock-quantity; }",
            "expect(reserve(10,3)).toBe(7)",
          ],
        ]) {
          await file(`packages/${module}/index.ts`, fixtureValue(content, "content"));
          await file(
            `packages/${module}/index.test.ts`,
            `import {test,expect} from 'bun:test';\nimport {${module === "billing" ? "invoice" : module === "fulfilment" ? "dispatch" : "reserve"}} from './index';\ntest('verified ${module}',()=>{${assertion}});`,
          );
          for (let index = 0; index < 18; index++)
            await file(
              `packages/${module}/types/field-${index}.ts`,
              `export type Field${index} = { id: string; value: string };`,
            );
        }
      }
      await db.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${user},'Wiki product contributor',${`${name}@factory.local`},true)`;
      await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${project},${name},'Support desk',${`${new URL(api).origin}/${owner}/${name}.git`},'main','.devcontainer/devcontainer.json',${user})`;
      await db.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${user},'product-contributor',${user})`;
      await wiki.generate(project, user);
      const first = await complete();
      expect(first?.["state"]).toBe("succeeded");
      if (first?.["state"] !== "succeeded")
        throw new Error(`Configured model: ${first?.["failure"]}`);
      const initial = await db.client<
        Array<{ id: string; title: string; body: string; version: number; icon: string }>
      >`SELECT id,title,current_body AS body,version::integer AS version,icon FROM factory.knowledge_page WHERE project_id=${project} ORDER BY sort_order,id`;
      expect(initial.length).toBeGreaterThan(0);
      expect(initial.length).toBeLessThanOrEqual(6);
      expect(initial.map((page) => page.body).join("\n")).toMatch(/clos|history|retain/i);
      const page = fixtureValue(initial[0], "initial[0]");
      updates = createWikiSourceUpdates({
        database: db,
        forge: createForgejoClient({ apiURL: api, token }),
        apiURL: api,
        owner,
        receiverURL: `http://host.docker.internal:${listener.port}`,
        signingKey: "owned-live-model-hook-key-not-production",
        reconcile: (projectID) => fixtureValue(wiki, "wiki").reconcile(projectID),
      });
      await updates.ensure(project);
      await wiki.edit(
        page.id,
        {
          expectedVersion: page.version,
          title: page.title,
          body: `${page.body}\n\nBusiness purpose: reduce support calls for the customer success team.`,
        },
        user,
      );
      await db.client`UPDATE factory.knowledge_page SET icon='home',sort_order=4 WHERE id=${page.id}`;
      sourceSha = await file(
        "src/main.ts",
        "export function closeTicket(ticket: {status: string}) { return {...ticket, status: 'resolved'}; }\n",
        sourceSha,
      );
      await file(
        "test/ticket.test.ts",
        "import {test,expect} from 'bun:test';\nimport {closeTicket} from '../src/main';\ntest('resolved work is retained',()=>expect(closeTicket({status:'open'}).status).toBe('resolved'));\n",
        (
          (await forge(`repos/${owner}/${name}/contents/test/ticket.test.ts?ref=main`)) as {
            sha: string;
          }
        ).sha,
      );
      await eventually(
        async () =>
          (
            await db.client<
              Array<{ version: number }>
            >`SELECT event_version::integer AS version FROM factory.wiki_source_update WHERE project_id=${project}`
          )[0]?.version,
        (value) => (value ?? 0) > 0,
        "Actual source push was not received",
        30_000,
      );
      await eventually(
        async () => {
          await fixtureValue(updates, "updates").drain();
          return fixtureValue(wiki, "wiki").generation(project);
        },
        (value) => value?.["id"] !== first?.["id"],
        "Signed push did not start a configured-model update",
        30_000,
      );
      const updated = await complete();
      expect(updated?.["state"]).toBe("succeeded");
      if (updated?.["state"] !== "succeeded")
        throw new Error(`Configured update: ${updated?.["failure"]}`);
      const current = await db.client<
        Array<{
          id: string;
          title: string;
          body: string;
          icon: string;
          order: number;
          parentId: string | null;
          version: number;
        }>
      >`SELECT id,title,current_body AS body,icon,sort_order AS "order",parent_id AS "parentId",version::integer AS version FROM factory.knowledge_page WHERE project_id=${project} AND state='active'`;
      expect(initial.every((before) => current.some((after) => after.id === before.id))).toBe(true);
      expect(current.find((value) => value.id === page.id)?.body).toContain("reduce support calls");
      expect(current.find((value) => value.id === page.id)?.icon).toBe("home");
      expect(current.find((value) => value.id === page.id)?.order).toBe(4);
      expect(current.map((value) => value.body).join("\n")).toContain("resolved");
      if (large) {
        expect(initial.length).toBeGreaterThanOrEqual(2);
        expect(current.some((value) => value.parentId)).toBe(true);
        const all = current.map((value) => value.body).join("\n");
        expect(all).toMatch(/14/);
        expect(all).toMatch(/unpaid|payment required|paid/i);
        expect(all).toMatch(/stock|oversell/i);
        expect(
          initial.filter((before) =>
            current.some((after) => after.id === before.id && after.body === before.body),
          ).length > 0 ||
            initial.some((before) => {
              const after = current.find((after) => after.id === before.id);
              const independent = (body: string) =>
                body
                  .match(
                    /## (?:Create|Issue) an invoice[\s\S]*?(?=## Boundaries|## Implementation boundary|## Changing|$)/,
                  )?.[0]
                  ?.trim();
              return (
                after &&
                independent(before.body) &&
                independent(before.body) === independent(after.body)
              );
            }),
        ).toBe(true);
      }
      await db.client`UPDATE factory.wiki_source_update SET next_attempt_at=now() WHERE project_id=${project}`;
      await updates.drain();
      const [handled] = await db.client<
        Array<{ done: boolean }>
      >`SELECT handled_version=event_version AS done FROM factory.wiki_source_update WHERE project_id=${project}`;
      expect(handled?.done).toBe(true);
      const revisions = await db.client<
        Array<{
          kind: string;
          body: string;
          sourceCommit: string;
          citations: Array<{ path: string; commitSha: string }>;
        }>
      >`SELECT kind,body,source_commit_sha AS "sourceCommit",citations FROM factory.knowledge_revision WHERE page_id IN (SELECT id FROM factory.knowledge_page WHERE project_id=${project}) ORDER BY created_at,id`;
      expect(revisions.some((value) => value.kind === "human")).toBe(true);
      const counts = await db.client<
        Array<{ count: number }>
      >`SELECT count(*)::integer AS count FROM factory.knowledge_revision WHERE page_id IN (SELECT id FROM factory.knowledge_page WHERE project_id=${project})`;
      await wiki.reconcile(project);
      expect(
        (
          await db.client<
            Array<{ count: number }>
          >`SELECT count(*)::integer AS count FROM factory.knowledge_revision WHERE page_id IN (SELECT id FROM factory.knowledge_page WHERE project_id=${project})`
        )[0]?.count,
      ).toBe(counts[0]?.count);
      expect(
        (await wiki.documents(project)).documents.some(
          (document) => document.path === "docs/product.md",
        ),
      ).toBe(true);
      const directory = `.factory/test-results/wiki/${name}`;
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/generation.json`,
        JSON.stringify({ large, first, updated, initial, pages: current, revisions }, null, 2),
      );
    } finally {
      const directory = `.factory/test-results/wiki/${name}`;
      await mkdir(directory, { recursive: true });
      const outputs = await Promise.allSettled(
        modelOutputs.mock.results.map((result) => result.value),
      );
      await writeFile(
        `${directory}/checked-model-outputs.json`,
        JSON.stringify(
          outputs.map((result) =>
            result.status === "fulfilled" &&
            result.value &&
            typeof result.value === "object" &&
            "object" in result.value
              ? result.value.object
              : { failed: true },
          ),
          null,
          2,
        ),
      );
      modelOutputs.mockRestore();
      await listener.stop(true);
      await updates?.drain();
      await wiki?.settle();
      await db.client.end();
      await owned.dispose();
      if (repositoryCreated) await forge(`repos/${owner}/${name}`, "DELETE");
    }
  },
  450_000,
);
