import { requestFunction } from "../fixtures/server-functions";
import { browserBootstrap } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { startEditorCompute } from "../fixtures/developer-ide-desktop-runtime";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createDatabase } from "../../packages/db/src/client";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../packages/requirement-domain/src/requirement";
import { openProjectMenu } from "../fixtures/project-menu";
import { signIn, teardownFactoryProject } from "../support/factory-fixture";
import { type StartupMeasurement, startupMeasurements } from "../support/runtime-startup";

const execute = promisify(execFile);
const origin = "http://127.0.0.1:3000";

// Native PTY/Preview streams are intentionally long-lived. Keep explicit captures
// and bounded timing artifacts instead of retaining their response bodies in a trace.
test.use({ trace: "off" });

async function readStartupPhases(namespace: string, pod: string) {
  const { stdout: containerRuntime } = await execute("kubectl", [
    "--context",
    "orbstack",
    "exec",
    pod,
    "-n",
    namespace,
    "--",
    "docker",
    "inspect",
    "workspace_cvm",
    "--format",
    "{{.HostConfig.Runtime}}",
  ]);
  expect(containerRuntime.trim()).toBe("sysbox-runc");
  const { stdout } = await execute("kubectl", [
    "--context",
    "orbstack",
    "exec",
    pod,
    "-n",
    namespace,
    "--",
    "docker",
    "exec",
    "workspace_cvm",
    "cat",
    "/tmp/factory-startup-timings.jsonl",
  ]);
  return startupMeasurements(stdout);
}

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
  const database = createDatabase(2);
  const projectID = crypto.randomUUID();
  const slug = `workspace-startup-${projectID.slice(0, 8)}`;
  const directory = `.factory/test-results/workspace-startup/${slug}`;
  type RunMeasurement = {
    attemptID: string;
    computeMS: number;
    editorMS: number;
    terminalMS: number;
    phases: StartupMeasurement[];
    podCreatedAt: string;
    podStartedAt: string;
  };
  const measurements: {
    cold?: RunMeasurement;
    stopped?: RunMeasurement;
    retainedFrameMS?: number;
    browserPreparingAtEditor?: boolean;
  } = {};
  const { stdout: initialNamespaces } = await execute("kubectl", [
    "--context",
    "orbstack",
    "get",
    "namespaces",
    "-o",
    "json",
  ]);
  const namespaceIdentities = (raw: string) =>
    (JSON.parse(raw) as { items: Array<{ metadata: { name: string; uid: string } }> }).items.map(
      ({ metadata }) => ({ name: metadata.name, uid: metadata.uid }),
    );
  const beforeNamespaces = namespaceIdentities(initialNamespaces);
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  const identity = changeIdentity(ticketID, approvalID);
  const repository = { owner: "factory-mutation", name: "runtime-fixture" };
  const forge = createForgejoClient({
    apiURL: "http://127.0.0.1:33030/api/v1/",
    token: (await readFile(".factory/forgejo-token", "utf8")).trim(),
  });
  let fixtureCreated = false;
  let branchCreated = false;
  try {
    await mkdir(directory, { recursive: true });
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
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES (${projectID},${slug},'Workspace startup proof','http://127.0.0.1:33030/factory-mutation/runtime-fixture.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
      await sql`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by) VALUES (${ticketID},${projectID},'Startup measurement','Interactive startup proof','in-progress',${session.user.id})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES (${revisionID},${ticketID},1,${requirement},${requirementDigest(requirement)},${session.user.id})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES (${approvalID},${ticketID},${revisionID},${session.user.id})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES (${identity.changeID},${projectID},${ticketID},${approvalID},${identity.branchName},${base.headSha},'active',${session.user.id})`;
      await sql`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at) VALUES (${identity.branchOperationID},${identity.changeID},${repository.owner},${repository.name},${identity.branchName},${base.headSha},${`startup:${identity.changeID}`},'succeeded',${base.headSha},now())`;
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
      await page.getByRole("menuitem", { name: "Open IDE", exact: true }).click();
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
      const [pod] = await database.client<
        Array<{ namespace: string; pod: string }>
      >`SELECT kubernetes_namespace AS namespace,kubernetes_pod_name AS pod FROM factory.runtime_attempt WHERE id=${runtime.id}`;
      if (!pod) throw new Error("Missing owned Runtime Pod");
      const { stdout: state } = await execute("kubectl", [
        "--context",
        "orbstack",
        "get",
        "pod",
        "-n",
        pod.namespace,
        pod.pod,
        "-o",
        "json",
      ]);
      const observed = JSON.parse(state) as {
        metadata: { creationTimestamp: string };
        status: { startTime: string };
      };
      measurements[kind] = {
        attemptID: runtime.id,
        computeMS,
        editorMS,
        terminalMS,
        phases: await readStartupPhases(pod.namespace, pod.pod),
        podCreatedAt: observed.metadata.creationTimestamp,
        podStartedAt: observed.status.startTime,
      };
      await page.screenshot({ path: `${directory}/${kind}-source-terminal.png` });
      await writeFile(`${directory}/timings.json`, JSON.stringify(measurements, null, 2));
      return runtime;
    }
    const cold = await start("cold");
    measurements.browserPreparingAtEditor = !measurements.cold?.phases.some(
      (phase) => phase.phase === "browser-image",
    );
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
    // Browser preparation must finish successfully without delaying the editor's
    // clock or borrowing an execution lease. Observe only fixed diagnostic records.
    await expect
      .poll(
        async () => {
          const [pod] = await database.client<
            Array<{ namespace: string; pod: string }>
          >`SELECT kubernetes_namespace AS namespace,kubernetes_pod_name AS pod FROM factory.runtime_attempt WHERE id=${cold.id}`;
          if (!pod || !measurements.cold) throw new Error("Missing cold timing context");
          measurements.cold.phases = await readStartupPhases(pod.namespace, pod.pod);
          return measurements.cold.phases.some((phase) => phase.phase === "browser-image");
        },
        { timeout: 180_000, intervals: [1_000] },
      )
      .toBe(true);
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
    await start("stopped");
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
    expect(measurements.cold).toEqual(
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({ phase: "browser-image" }),
          expect.objectContaining({ phase: "tool-injection" }),
        ]),
      }),
    );
    expect(measurements.cold?.terminalMS, "Cold source and authenticated PTY budget").toBeLessThan(
      120_000,
    );
  } finally {
    await writeFile(`${directory}/timings.json`, JSON.stringify(measurements, null, 2));
    try {
      if (fixtureCreated) {
        expect((await requestFunction(page.request, "cancelChange", [identity.changeID])).ok).toBe(
          true,
        );
        await teardownFactoryProject(page.request, projectID);
        const { stdout: remainingNamespaces } = await execute("kubectl", [
          "--context",
          "orbstack",
          "get",
          "namespaces",
          "-o",
          "json",
        ]);
        expect(
          namespaceIdentities(remainingNamespaces).sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(beforeNamespaces.sort((a, b) => a.name.localeCompare(b.name)));
        await writeFile(
          `${directory}/cleanup.json`,
          JSON.stringify({
            projectID,
            changeID: identity.changeID,
            namespaceIdentitiesUnchanged: true,
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
