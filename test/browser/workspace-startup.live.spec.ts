import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { z } from "zod";
import { changeIdentity } from "#change-domain/change";
import { createDatabase } from "#db/client";
import { createForgejoClient } from "#forge/forge";
import { canonicalRequirementContent, requirementDigest } from "#requirement-domain/requirement";
import { runtimeAttemptSchema } from "../../apps/factory/src/runtime/contracts";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { test } from "../fixtures/browser-test";
import { startEditorCompute } from "../fixtures/editor-compute";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";
import { readNativeWorkspaceObservation } from "../fixtures/native-workspace-observation";
import { openProjectMenu } from "../fixtures/project-menu";
import { browserBootstrap, requestFunction } from "../fixtures/server-functions";
import { signIn } from "../support/factory-fixture";

// Native PTY/Preview streams are intentionally long-lived. Keep explicit captures
// and bounded timing artifacts instead of retaining their response bodies in a trace.
test.use({ trace: "off" });

async function openSource(ide: FrameLocator) {
  const file = ide.getByText("server.mjs", { exact: true }).first();
  if (!(await file.isVisible())) await ide.getByText("src", { exact: true }).first().click();
  await file.click();
  await moveSourceCaret(ide, "start");
  await expect(ide.locator(".monaco-editor:visible .view-lines").first()).toContainText(
    "createServer",
  );
}

async function moveSourceCaret(ide: FrameLocator, position: "start" | "end") {
  const mac = await ide.locator("body").evaluate(() => navigator.platform.startsWith("Mac"));
  const key = mac
    ? position === "start"
      ? "Meta+ArrowUp"
      : "Meta+ArrowDown"
    : position === "start"
      ? "Control+Home"
      : "Control+End";
  await ide
    .locator(".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])")
    .first()
    .press(key);
}

async function terminalCommand(page: Page, ide: FrameLocator, command: string, expected: string) {
  await ide.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const terminal = ide.locator(".factory-terminal-host:not([hidden])");
  if ((await terminal.count()) === 0)
    await ide.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(terminal).toHaveAttribute("data-connection-state", "connected");
  await terminal.locator(".xterm").click({ force: true });
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText(expected);
}

test("measures cold, retained and stopped Ticket Workspace source and PTY readiness", async ({
  page,
}) => {
  test.setTimeout(1_080_000);
  page.setDefaultTimeout(30_000);
  const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
  const publicURL = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  const tokenFile = process.env["FACTORY_NATIVE_RUNTIME_FORGE_TOKEN_FILE"];
  const repositoryName = process.env["FACTORY_NATIVE_RUNTIME_REPOSITORY"];
  if (
    !process.env["FACTORY_BROWSER_BASE_URL"] ||
    !apiURL ||
    !publicURL ||
    !tokenFile ||
    !repositoryName
  )
    throw Error(
      "Explicit owned native browser, Forge HTTPS origin, token file and runtime fixture repository are required",
    );
  const publicOrigin = new URL(publicURL);
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.origin !== publicURL ||
    publicOrigin.port ||
    publicOrigin.username ||
    publicOrigin.password
  )
    throw Error("Native startup proof requires an exact Forge HTTPS origin on port 443");
  const parts = repositoryName.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!parts?.[1] || !parts[2]) throw Error("Explicit owned runtime repository must be owner/name");
  const database = createDatabase(2);
  const projectID = crypto.randomUUID();
  const slug = `workspace-startup-${projectID.slice(0, 8)}`;
  const directory = `.factory/test-results/workspace-startup/${slug}`;
  type RunMeasurement = {
    attemptID: string;
    computeMS: number;
    editorMS: number;
    terminalMS: number;
    native: Awaited<ReturnType<typeof readNativeWorkspaceObservation>>;
  };
  const measurements: {
    cold?: RunMeasurement;
    stopped?: RunMeasurement;
    retainedFrameMS?: number;
  } = {};
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const identity = changeIdentity(ticketID, approvalID);
  const repository = { owner: parts[1], name: parts[2] };
  const forge = createForgejoClient({
    apiURL,
    token: (await readFile(tokenFile, "utf8")).trim(),
  });
  let fixtureCreated = false;
  let branchCreated = false;
  try {
    await mkdir(directory, { recursive: true });
    const [scope] = await database.client<{ name: string }[]>`SELECT current_database() AS name`;
    if (!scope || !/^owned_[a-f0-9]{32}$/.test(scope.name))
      throw Error(
        "Native startup proof requires its owned disposable Factory database; retained installation unchanged",
      );
    await signIn(page);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    const { session } = await browserBootstrap(page);
    if (!session) throw new Error("Missing authenticated fixture owner");
    const base = await forge.getDefaultBranch(repository);
    await forge.ensureBranch(repository, identity.branchName, base.headSha);
    branchCreated = true;
    const requirement = canonicalRequirementContent({
      summary: "Measure interactive Workspace startup without inference.",
      acceptanceCriteria: ["Source and PTY work"],
      nonGoals: [],
    });
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES (${projectID},${slug},'Workspace startup proof',${`${publicURL}/${repository.owner}/${repository.name}.git`},'main','.factory/actor-template.json',${session.user.id})`;
      await sql`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by) VALUES (${ticketID},${projectID},'Startup measurement','Interactive startup proof','in-progress',${session.user.id})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES (${revisionID},${ticketID},1,${requirement},${requirementDigest(requirement)},${session.user.id})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES (${approvalID},${ticketID},${revisionID},${session.user.id})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES (${identity.changeID},${projectID},${ticketID},${approvalID},${identity.branchName},${base.headSha},'active',${session.user.id})`;
      await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,result,created_by,completed_at) VALUES (${identity.branchOperationID},'delivery.branch_create','change',${identity.changeID},${`delivery.branch_create:change:${identity.changeID}:create-branch`},NULL,'succeeded',${JSON.stringify(
        {
          changeId: identity.changeID,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          branchName: identity.branchName,
          startSha: base.headSha,
          attemptCount: 1,
          leaseGeneration: 1,
          reconcileAfter: null,
        },
      )}::jsonb,${JSON.stringify({ observedHeadSha: base.headSha })}::jsonb,${session.user.id},now())`;
    });
    fixtureCreated = true;
    await page.reload();
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .filter({ hasText: "Startup measurement" })
      .click();
    const ide = page.locator('iframe[title="Factory IDE"]').contentFrame();
    async function start(kind: "cold" | "stopped") {
      const started = performance.now();
      await page.getByRole("button", { name: "Ticket actions", exact: true }).click();
      await page.getByRole("button", { name: "Open IDE", exact: true }).click();
      const receipt = await startEditorCompute(page);
      const list = await serverCall(
        requestFunction(page.request, "getRuntimeAttempts", [projectID]),
      );
      const runtime = runtimeAttemptSchema.parse(
        list.attempts.find((attempt) => attempt.id === receipt.attemptID),
      );
      await expect
        .poll(
          async () => {
            const [row] = await database.client<
              Array<{ state: string; failure: string | null }>
            >`SELECT state,failure FROM factory.runtime_attempt WHERE id=${runtime.id}`;
            if (row?.state === "failed" || row?.state === "cleanup-failed")
              throw new Error(`Workspace failed: ${row.failure}`);
            return row?.state;
          },
          { timeout: 600_000, intervals: [1_000] },
        )
        .toBe("ready");
      const computeMS = Math.round(performance.now() - started);
      await expect(ide.locator("#theia-app-shell")).toBeVisible({ timeout: 60_000 });
      await expect(ide.locator(".theia-preload")).toHaveCount(0);
      await openSource(ide);
      const editorMS = Math.round(performance.now() - started);
      await terminalCommand(
        page,
        ide,
        "printf 'startup-pty='; pwd",
        "startup-pty=/workspace/project",
      );
      const terminalMS = Math.round(performance.now() - started);
      expect(runtime.native?.state).toBe("ACTOR_STATE_RUNNING");
      const native = await readNativeWorkspaceObservation(database, {
        attemptID: runtime.id,
        projectID,
        workspaceID: receipt.workspaceID,
        actorUID: z.uuid().parse(runtime.native?.actorUID),
      });
      measurements[kind] = {
        attemptID: runtime.id,
        computeMS,
        editorMS,
        terminalMS,
        native,
      };
      await page.screenshot({ path: `${directory}/${kind}-source-terminal.png` });
      await writeFile(`${directory}/timings.json`, JSON.stringify(measurements, null, 2));
      return runtime;
    }
    const cold = await start("cold");
    const timeOrigin = await ide.locator("body").evaluate(() => performance.timeOrigin);
    await page.getByRole("button", { name: "Minimize workspace", exact: true }).click();
    const retained = performance.now();
    await page.getByRole("button", { name: "IDE", exact: true }).click();
    await expect(ide.locator(".factory-terminal-host:not([hidden])")).toHaveAttribute(
      "data-connection-state",
      "connected",
    );
    await expect(ide.locator(".monaco-editor:visible .view-lines").first()).toContainText(
      "createServer",
    );
    expect(await ide.locator("body").evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    measurements.retainedFrameMS = Math.round(performance.now() - retained);
    const editorInput = ide
      .locator(".monaco-editor:visible [role='textbox']:not([aria-hidden='true'])")
      .first();
    await editorInput.focus();
    await moveSourceCaret(ide, "end");
    await page.keyboard.press("Enter");
    await editorInput.pressSequentially("// Factory interactive startup edit");
    await page.keyboard.press("ControlOrMeta+s");
    await terminalCommand(
      page,
      ide,
      `node -e 'const s=require("node:fs").readFileSync("src/server.mjs","utf8");if(!s.startsWith("import { createHash")||!s.trimEnd().endsWith("// Factory interactive startup edit"))process.exit(1);console.log("source-edit-"+"saved")'`,
      "source-edit-saved",
    );
    await terminalCommand(
      page,
      ide,
      "npm install --ignore-scripts --no-audit --no-fund && printf 'retained-manual-data\\n' > factory-startup-draft.txt; printf 'install-complete='; test -f package-lock.json && cat factory-startup-draft.txt",
      "install-complete=retained-manual-data",
    );
    await terminalCommand(
      page,
      ide,
      'node -e \'console.log("foreground-"+"started");setInterval(()=>{},1000)\'',
      "foreground-started",
    );
    await page.keyboard.press("Control+c");
    await terminalCommand(
      page,
      ide,
      "printf 'foreground-%s\\n' interrupted",
      "foreground-interrupted",
    );
    await terminalCommand(
      page,
      ide,
      'node -e \'console.log("foreground-"+"restarted");setInterval(()=>{},1000)\'',
      "foreground-restarted",
    );
    await page.keyboard.press("Control+c");
    await terminalCommand(
      page,
      ide,
      "printf 'foreground-restart-%s\\n' interrupted",
      "foreground-restart-interrupted",
    );
    expect((await requestFunction(page.request, "stopRuntimeAttempt", [cold.id])).ok).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await database.client<
              Array<{ state: string }>
            >`SELECT state FROM factory.runtime_attempt WHERE id=${cold.id}`
          )[0]?.state,
        { timeout: 180_000 },
      )
      .toBe("stopped");
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page
      .getByRole("region", { name: "implementation", exact: true })
      .getByRole("button")
      .filter({ hasText: "Startup measurement" })
      .click();
    // Explicit Stop is not permission for an observer or reconnect to restart compute.
    await serverCall(requestFunction(page.request, "startTicketWorkspace", [identity.changeID]));
    const restarted = await start("stopped");
    expect(restarted.id).not.toBe(cold.id);
    expect(measurements.stopped?.native.actorUID).not.toBe(measurements.cold?.native.actorUID);
    await terminalCommand(
      page,
      ide,
      "printf 'persisted='; test -f package-lock.json && cat factory-startup-draft.txt",
      "persisted=retained-manual-data",
    );
    await moveSourceCaret(ide, "end");
    await expect(ide.locator(".monaco-editor:visible .view-lines").first()).toContainText(
      "Factory interactive startup edit",
    );
    await page.screenshot({ path: `${directory}/retained-source-edit.png` });
    await ide.locator(".lm-TabBar-tab").filter({ hasText: "Run" }).click();
    await ide.getByRole("button", { name: /^Web / }).click();
    const run = ide.locator(".factory-runtime-widget");
    await run.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(run).toContainText("Stopped · exit");
    await run.getByRole("button", { name: "Start", exact: true }).click();
    await expect(run.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await run.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(run.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await ide.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.locator('iframe[title="Factory Preview"]:visible').contentFrame();
    await expect(
      preview.getByRole("heading", { name: "Runtime fixture ready", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${directory}/development-preview.png` });
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.verification WHERE change_id=${identity.changeID}`,
    ).toHaveLength(0);
    expect((await forge.getDefaultBranch(repository)).headSha).toBe(base.headSha);
    const [approved] = await database.client<
      Array<{ content: string }>
    >`SELECT r.canonical_content AS content FROM factory.requirement_revision r JOIN factory.requirement_approval a ON a.requirement_revision_id=r.id WHERE a.id=${approvalID}`;
    expect(approved?.content).toBe(requirement);
  } finally {
    await writeFile(`${directory}/timings.json`, JSON.stringify(measurements, null, 2));
    try {
      if (fixtureCreated) {
        expect((await requestFunction(page.request, "cancelChange", [identity.changeID])).ok).toBe(
          true,
        );
        const remaining = await serverCall(
          requestFunction(page.request, "getRuntimeAttempts", [projectID]),
        );
        for (const attempt of remaining.attempts)
          if (attempt.state !== "stopped")
            await serverCall(requestFunction(page.request, "stopRuntimeAttempt", [attempt.id]));
        await requireOwnedProjectSourceRetention(database, projectID);
        await writeFile(
          `${directory}/cleanup.json`,
          JSON.stringify({
            projectID,
            changeID: identity.changeID,
            computeStopped: true,
            sourceRetained: true,
            productHistoryRetained: true,
            ownedInstallationRetained: true,
            nativeResourceInventoryRetained: true,
          }),
        );
      }
    } finally {
      try {
        if (branchCreated) await forge.deleteBranch(repository, identity.branchName);
      } finally {
        await database.client.end({ timeout: 2 });
      }
    }
  }
});
