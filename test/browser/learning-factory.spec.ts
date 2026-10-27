import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "../../packages/db/src/client";
import { learningFixture } from "../fixtures/learning";
import { openProjectMenu } from "../fixtures/project-menu";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { retainedEditProposal } from "../fixtures/learning-edit";
import type { LearningEdit } from "../../packages/conversation-domain/src/learning";
import { fixtureValue } from "../fixtures/value";

test("real Settings show monitoring, save learning policy and isolate private evidence without commissioning work", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const build = resolve(
    ".factory/test-results/application-builds",
    `learning-browser-${crypto.randomUUID()}`,
  );
  const environment = { ...process.env, FACTORY_BUILD_DIRECTORY: build };
  await promisify(execFile)(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "run", "factory:build"],
    { env: environment, maxBuffer: 4 * 1024 * 1024 },
  );
  const host = spawn(
    "mise",
    ["exec", "--", "bun", "--no-env-file", "test/fixtures/inbox-browser-host.ts"],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
  let stderr = "";
  host.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let database: ReturnType<typeof createDatabase> | undefined;
  const stopped = new Promise<void>((done) => host.once("exit", () => done()));
  try {
    const fixture = await new Promise<z.infer<typeof ready>>((done, reject) => {
      createInterface({ input: host.stdout }).on("line", (line) => {
        if (line.startsWith("Owned ")) console.info(line);
        if (line.startsWith('{"fixtureBase"')) {
          try {
            done(ready.parse(JSON.parse(line)));
          } catch (cause) {
            reject(cause);
          }
        }
      });
      host.once("exit", () =>
        reject(new Error(`Owned monitoring host exited: ${stderr.slice(-2000)}`)),
      );
    });
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = fixture.databaseURL;
    database = createDatabase(2);
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
    const [admin] = await database.client<
      { id: string }[]
    >`SELECT user_id AS id FROM factory.administrator`;
    if (!admin) throw new Error("Owned administrator is missing");
    const project = crypto.randomUUID(),
      review = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`monitoring-${project}`},'Monitoring proof','https://example.invalid/monitoring.git','main','.devcontainer/devcontainer.json',${admin.id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${project},${admin.id},'developer',true,${admin.id})`;
    const source = {
      id: "owned:private-evidence",
      projectId: project,
      ownerId: admin.id,
      developerOnly: false,
      activity: "research",
      outcome: "completed",
      settledAt: new Date().toISOString(),
      evidence: [
        {
          id: "private:source",
          kind: "outcome",
          body: "Private synthetic customer observation",
          truncated: false,
        },
      ],
    };
    const result = {
      cases: [
        {
          caseId: source.id,
          fulfillment: "unknown",
          verification: "unknown",
          rework: "unknown",
          explanation: "Private work needs original source verification.",
          evidenceIds: ["private:source"],
        },
      ],
      findings: [],
      proposals: [],
    };
    await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,judge_key,state,input,input_digest,result,owner_token,owner_expires_at,completed_at)
      VALUES(${review},${project},${admin.id},false,${admin.id},'work','work-review/v1','synthetic-model','synthetic','completed',
      ${JSON.stringify([source])}::jsonb,${"a".repeat(64)},${JSON.stringify(result)}::jsonb,${crypto.randomUUID()},now(),now())`;
    const proposal = fixtureValue(
      learningFixture().proposals[0],
      "learningFixture().proposals[0]",
    ).content;
    const shared = crypto.randomUUID();
    await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,judge_key,state,input,input_digest,result,owner_token,owner_expires_at,completed_at)
      VALUES(${shared},${project},NULL,false,${admin.id},'work','work-review/v1','synthetic-model','synthetic','completed',
      ${JSON.stringify([{ ...source, id: "owned:shared-evidence", ownerId: null, evidence: [] }])}::jsonb,${"b".repeat(64)},${JSON.stringify(
        {
          cases: [
            {
              caseId: "owned:shared-evidence",
              fulfillment: "unknown",
              verification: "unknown",
              rework: "unknown",
              explanation: "Shared synthetic CI observation.",
              evidenceIds: [],
            },
          ],
          findings: [],
          proposals: [proposal],
        },
      )}::jsonb,${crypto.randomUUID()},now(),now())`;
    await database.client`INSERT INTO factory.learning_proposal(id,review_id,ordinal,content)
      VALUES(${crypto.randomUUID()},${shared},0,${JSON.stringify(proposal)}::jsonb)`;
    const skills = createSkillController(database),
      libraryId = crypto.randomUUID(),
      baseRevisionId = crypto.randomUUID();
    const before = "Ask for a hostname before looking at repository sources.";
    const after = "Inspect repository sources before asking for a hostname.";
    await skills.library.save(
      {
        libraryId,
        revisionId: baseRevisionId,
        expectedRevision: 0,
        scope: "project",
        projectId: project,
        content: {
          key: "owned-project-method",
          name: "Owned Project method",
          description: "Use for source-backed research.",
          roles: ["planning"],
          instructions: before,
          references: [],
        },
      },
      admin.id,
    );
    await skills.chooseLibrary(
      {
        libraryId,
        scope: "project",
        projectId: project,
        role: "planning",
        state: "enable",
        revisionId: baseRevisionId,
        expectedVersion: 0,
      },
      admin.id,
      project,
    );
    const edit: LearningEdit = {
      target: {
        kind: "skill",
        id: libraryId,
        revisionId: baseRevisionId,
        version: 1,
        field: "instructions",
      },
      before,
      after,
    };
    const editProposal = await retainedEditProposal(database, {
      projectId: project,
      userId: admin.id,
      edit,
      text: before,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixture.fixtureBase);
    await page.getByLabel("Email", { exact: true }).fill(`owned-${fixture.id}@factory.local`);
    await page.getByLabel("Password", { exact: true }).fill("owned-process-password-not-a-secret");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await openProjectMenu(page);
    const projectChoice = page.getByRole("button").filter({ hasText: `monitoring-${project}` });
    await expect(projectChoice).toBeVisible();
    await projectChoice.click();
    await expect(page.getByRole("button", { name: "Open project menu", exact: true })).toHaveText(
      "Monitoring proof",
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "Settings navigation" });
    await expect(nav).toBeVisible();
    await nav
      .locator("section")
      .filter({ hasText: "Project · Monitoring proof" })
      .getByRole("button", { name: "Monitoring", exact: true })
      .click();
    const monitor = page.getByRole("region", { name: "Factory monitoring" });
    await expect(monitor.getByRole("heading", { name: "Work, quality & cost" })).toBeVisible();
    await expect(monitor.locator(".work-chart svg")).toHaveCSS("stroke", "none");
    await expect(
      monitor.locator(".work-proposal-heading").getByText(proposal.title, { exact: true }),
    ).toBeVisible();
    const stream = monitor.getByRole("region", { name: "Learning history overview" });
    await expect(stream.locator(".learning-flow-node")).toHaveCount(2);
    await expect(stream).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect
      .poll(() =>
        stream
          .locator("svg")
          .evaluate((svg) =>
            Math.abs(
              (svg as SVGSVGElement).viewBox.baseVal.width - svg.getBoundingClientRect().width,
            ),
          ),
      )
      .toBeLessThanOrEqual(1);
    await stream.scrollIntoViewIfNeeded();
    await mkdir(".factory/test-results/learning-browser", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/learning-browser/real-learning-flow-1440.png",
      fullPage: true,
    });
    const selectedTitle = await stream.locator(".learning-flow-detail h4").textContent();
    await stream.getByRole("button", { name: new RegExp(proposal.title) }).hover();
    await expect(stream.getByRole("tooltip")).toContainText(proposal.change);
    await expect(stream.locator(".learning-flow-detail h4")).toHaveText(
      fixtureValue(selectedTitle, "selectedTitle"),
    );
    await page.screenshot({
      path: ".factory/test-results/learning-browser/real-learning-flow-hover-1440.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(stream.getByRole("tooltip")).toHaveCount(0);
    await expect(monitor).toBeVisible();
    await monitor.getByText("Automatic Skill updates · Off", { exact: true }).click();
    await monitor
      .getByRole("button", { name: "Allow compared Skill updates", exact: true })
      .click();
    await expect(
      monitor.getByText("Automatic Skill updates · Allowed", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await fixtureValue(database, "database")
              .client`SELECT automatic_skills FROM factory.learning_policy WHERE project_id=${project} AND owner_id IS NULL`
          )[0]?.["automatic_skills"],
      )
      .toBe(true);
    await monitor.getByText("Automatic Skill updates · Allowed", { exact: true }).click();
    await expect(
      page.getByText("Private synthetic customer observation", { exact: true }),
    ).toHaveCount(0);
    await monitor.getByText("Review exact edit", { exact: true }).click();
    await expect(monitor.getByText(/This edit has not been benchmarked/)).toBeVisible();
    await monitor.getByRole("button", { name: "Apply exact edit", exact: true }).click();
    const application = async () =>
      (
        await fixtureValue(database, "database").client<
          { id: string; revisionId: string; state: string }[]
        >`
      SELECT id,applied_revision_id AS "revisionId",state FROM factory.learning_application WHERE proposal_id=${editProposal.id}`
      )[0];
    await expect.poll(async () => (await application())?.state).toBe("applied");
    const applied = fixtureValue(await application(), "(await application())");
    const appliedItem = monitor.locator(`#work-application-${applied.id}`);
    await expect(appliedItem).toBeFocused();
    await stream.getByRole("button", { name: new RegExp(editProposal.content.title) }).click();
    await expect(stream.locator(".learning-flow-outcome")).toHaveText("Applied v2");
    await stream.getByRole("button", { name: "Inspect decision & evidence", exact: true }).click();
    await expect(appliedItem).toBeFocused();
    const [changed] = await database.client<
      { content: { instructions: string } }[]
    >`SELECT content FROM factory.skill_revision WHERE id=${applied.revisionId}`;
    expect(changed?.content.instructions).toBe(after);
    await appliedItem.getByText("Accepted edit & revision", { exact: true }).click();
    await appliedItem.scrollIntoViewIfNeeded();
    await mkdir(".factory/test-results/learning-browser", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/learning-browser/real-edit-applied-1440.png",
      fullPage: true,
    });
    await appliedItem.getByRole("button", { name: "Undo this edit", exact: true }).click();
    await expect.poll(async () => (await application())?.state).toBe("reverted");
    await expect(appliedItem).toBeFocused();
    await expect(appliedItem.getByText("Reverted", { exact: true })).toBeVisible();
    await monitor.getByRole("button", { name: "Pause learning", exact: true }).click();
    await expect(monitor.getByText("Learning paused", { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await fixtureValue(database, "database")
              .client`SELECT enabled FROM factory.learning_policy WHERE project_id=${project} AND owner_id IS NULL`
          )[0]?.["enabled"],
      )
      .toBe(false);
    await mkdir(".factory/test-results/learning-browser", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/learning-browser/real-factory-1440.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "My private work", exact: true }).click();
    await expect(
      monitor.getByText("Project learning is paused. Your personal setting cannot override it.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(stream.locator(".learning-flow-node")).toHaveCount(1);
    await expect(stream.getByRole("button", { name: /Review of 1 work case/ })).toBeVisible();
    await expect(
      stream.getByRole("button", { name: new RegExp(editProposal.content.title) }),
    ).toHaveCount(0);
    await monitor.getByText("Review history & evidence", { exact: false }).click();
    await monitor.getByText("1 work case", { exact: true }).click();
    await monitor.getByText("Admitted evidence packet", { exact: true }).click();
    await monitor.getByText("outcome · private:source", { exact: true }).click();
    await expect(
      monitor.getByText("Private synthetic customer observation", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({
      path: ".factory/test-results/learning-browser/real-factory-private-390.png",
      fullPage: true,
    });
    await stream.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: ".factory/test-results/learning-browser/real-learning-flow-private-390.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Shared Project work", exact: true }).click();
    await expect(
      page.getByText("Private synthetic customer observation", { exact: true }),
    ).toHaveCount(0);
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(await database.client`SELECT id FROM factory.usage_operation`).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await database?.client.end({ timeout: 2 });
    host.kill("SIGTERM");
    await stopped;
    await rm(build, { recursive: true, force: true });
  }
});
