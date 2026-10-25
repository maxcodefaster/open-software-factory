import { mkdir, readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/client";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserBootstrap, browserFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { deleteFactoryProject, signIn } from "../support/factory-fixture";

const origin = "http://127.0.0.1:3000";

test("Contributor searches only Wiki, edits, restores and loses access on revocation", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const db = createDatabase(2);
  const project = crypto.randomUUID(),
    pageId = crypto.randomUUID(),
    revision = crypto.randomUUID();
  const name = `wiki-browser-${project.slice(0, 8)}`;
  const owner = process.env["FACTORY_FORGEJO_OWNER"] ?? "factory-mutation";
  const api = process.env["FACTORY_FORGEJO_API_URL"] ?? "http://127.0.0.1:33030/api/v1/";
  const token =
    process.env["FACTORY_FORGEJO_TOKEN"] ??
    (await readFile(".factory/forgejo-token", "utf8")).trim();
  const email = `${name}@factory.local`,
    password = "owned-wiki-browser-password";
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const contributor = await context.newPage();
  let userId = "",
    repositoryCreated = false,
    projectCreated = false;
  async function forge(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await fetch(`${api.replace(/\/$/, "")}/${path}`, {
      method,
      headers: { authorization: `token ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`Owned Wiki source ${method} failed: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function selectProject(current: Page) {
    await expect(current.getByRole("region", { name: "Ticket board" })).toBeVisible();
    await openProjectMenu(current);
    await current.getByRole("button").filter({ hasText: name }).click();
    await current.getByRole("button", { name: "Knowledge", exact: true }).click();
  }
  try {
    await mkdir(".factory/screenshots/wiki-slice19", { recursive: true });
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const session = await browserBootstrap(page);
    const adminId = session.session.user.id as string;
    await forge("user/repos", "POST", {
      name,
      private: true,
      auto_init: true,
      default_branch: "main",
    });
    repositoryCreated = true;
    const path = "docs/product/support.md";
    await forge(`repos/${owner}/${name}/contents/${path}`, "POST", {
      branch: "main",
      message: "Create owned Wiki browser source",
      content: Buffer.from(
        "# Support guide\n\nFind the escalation policy here.\n\n```ts\nconst safe = true;\n```\n",
      ).toString("base64"),
    });
    const head = (await forge(`repos/${owner}/${name}/branches/main`)) as {
      commit: { id: string };
    };
    const commit = head.commit.id;
    const body = "Human product purpose.\n\n## Escalation\n\nEscalation reduces support calls.\n";
    await db.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${project},${name},'Support Wiki',${`${new URL(api).origin}/${owner}/${name}.git`},'main','.devcontainer/devcontainer.json',${adminId})`;
    projectCreated = true;
    const citations = JSON.stringify([{ path, commitSha: commit }]);
    await db.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,citations,created_by) VALUES(${pageId},${project},'support','Support guide',${body},${body},${commit},${citations}::jsonb,${adminId})`;
    await db.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,citations,created_by) VALUES(${revision},${pageId},1,'generated','Support guide',${body},${body},${commit},${citations}::jsonb,${adminId})`;
    await db.client`UPDATE factory.knowledge_page SET current_revision_id=${revision} WHERE id=${pageId}`;
    await db.client`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,state,created_by,completed_at) VALUES(${crypto.randomUUID()},${project},${commit},'succeeded',${adminId},now())`;
    const created = await serverCall(
      browserFunction(page, "createAccount", [{ name: "Wiki Contributor", email, password }]),
    );
    userId = created.id;
    expect(
      (
        await browserFunction(page, "saveProjectMember", [
          project,
          { email, role: "product-contributor" },
        ])
      ).ok,
    ).toBe(true);
    await contributor.goto("/");
    await contributor.getByLabel("Email").fill(email);
    await contributor.getByLabel("Password").fill(password);
    await contributor.getByRole("button", { name: "Sign in" }).click();
    await selectProject(contributor);
    await contributor.getByRole("button", { name: "Search Wiki", exact: true }).click();
    const search = contributor.getByRole("searchbox", { name: "Search Knowledge" });
    await search.fill("escalation");
    await expect(
      contributor.getByRole("button", { name: "docs/product/support.md", exact: true }),
    ).toHaveCount(0);
    await expect(contributor.locator(".wiki-search-results")).toContainText("Support guide");
    const searchResponse = await serverCall(
      browserFunction(contributor, "searchKnowledge", [project, "escalation"]),
    );
    expect(searchResponse.results.every((result: { kind: string }) => result.kind === "page")).toBe(
      true,
    );
    await contributor.getByRole("button", { name: "Close search" }).click();
    await expect(contributor.getByRole("button", { name: "Code docs", exact: true })).toHaveCount(
      0,
    );
    expect(await browserFunction(contributor, "getRepositoryDocuments", [project])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await browserFunction(contributor, "getRepositoryDocument", [project, path]),
    ).toMatchObject({ ok: false, status: 403 });
    expect(await browserFunction(contributor, "getKnowledgeSources", [pageId])).toMatchObject({
      ok: false,
      status: 403,
    });
    await expect(
      contributor.getByRole("button", { name: "Open Project IDE", exact: true }),
    ).toHaveCount(0);
    await expect(contributor.getByRole("textbox", { name: "Knowledge body" })).toHaveCount(0);
    expect(
      (
        await contributor.request.put(`/api/projects/${project}/knowledge/documents`, {
          headers: { origin },
          data: { path, body: "Overwrite" },
        })
      ).status(),
    ).toBe(404);
    await contributor.getByRole("button", { name: "Support guide", exact: true }).click();
    await contributor.getByLabel("Edit Knowledge body", { exact: true }).click();
    const editor = contributor.getByRole("textbox", { name: "Knowledge body", exact: true });
    await editor.press("ControlOrMeta+End");
    await editor.press("Enter");
    await editor.pressSequentially("Human escalation owner.");
    await expect
      .poll(
        async () =>
          (
            await db.client<
              Array<{ body: string }>
            >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageId}`
          )[0]?.body,
      )
      .toContain("Human escalation owner.");
    await contributor.getByRole("button", { name: "Page options", exact: true }).click();
    await contributor.getByRole("menuitem", { name: "History", exact: true }).click();
    const history = contributor.getByRole("complementary", { name: "Knowledge history" });
    await history.getByRole("button").nth(1).click();
    await expect(contributor.getByLabel("Historical page")).toContainText("Human escalation owner");
    await history.getByRole("button").last().click();
    await expect(contributor.getByLabel("Historical page")).toContainText("Human product purpose");
    await expect(
      contributor.getByRole("link", { name: "View source change", exact: true }),
    ).toHaveCount(0);
    const historyResponse = await serverCall(
      browserFunction(contributor, "getKnowledgeHistory", [pageId]),
    );
    for (const item of historyResponse.revisions) {
      expect(item).not.toHaveProperty("sourceCommitSha");
      expect(item).not.toHaveProperty("citations");
      expect(item).not.toHaveProperty("generatedBody");
    }
    await expect(contributor.locator(".knowledge-workspace")).not.toContainText(commit);
    await contributor.screenshot({
      path: ".factory/screenshots/wiki-slice19/contributor-history-wide.png",
    });
    await contributor.setViewportSize({ width: 900, height: 760 });
    await contributor.screenshot({
      path: ".factory/screenshots/wiki-slice19/contributor-history-narrow.png",
    });
    await contributor.getByRole("button", { name: "Restore this version", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await db.client<
              Array<{ body: string }>
            >`SELECT current_body AS body FROM factory.knowledge_page WHERE id=${pageId}`
          )[0]?.body,
      )
      .toBe(body);
    const [counts] = await db.client<
      Array<{ revisions: number; runtimes: number; tickets: number }>
    >`SELECT (SELECT count(*)::integer FROM factory.knowledge_revision WHERE page_id=${pageId}) AS revisions,(SELECT count(*)::integer FROM factory.runtime_attempt WHERE project_id=${project}) AS runtimes,(SELECT count(*)::integer FROM factory.ticket WHERE project_id=${project}) AS tickets`;
    expect(counts).toEqual({ revisions: 3, runtimes: 0, tickets: 0 });
    await db.client`DELETE FROM factory.project_membership WHERE project_id=${project} AND user_id=${userId}`;
    expect(
      await browserFunction(contributor, "searchKnowledge", [project, "escalation"]),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await browserFunction(contributor, "getRepositoryDocument", [project, path]),
    ).toMatchObject({ ok: false, status: 404 });
    expect(await browserFunction(contributor, "getKnowledgeHistory", [pageId])).toMatchObject({
      ok: false,
      status: 404,
    });
  } finally {
    await context.close();
    if (projectCreated) await deleteFactoryProject(project);
    if (userId) {
      await db.client`DELETE FROM auth.session WHERE user_id=${userId}`;
      await db.client`DELETE FROM auth.account WHERE user_id=${userId}`;
      await db.client`DELETE FROM auth."user" WHERE id=${userId}`;
    }
    await db.client.end();
    if (repositoryCreated) await forge(`repos/${owner}/${name}`, "DELETE");
  }
});
