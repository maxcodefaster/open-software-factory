import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import solid from "@solidjs/vite-plugin";
import { createServer } from "vite";
import { releaseSettingsView } from "../../packages/project-domain/src/release";
import { mockFactoryFunctions } from "../fixtures/server-functions";
import { chooseSettingsPage } from "../fixtures/settings-navigation";

test("release settings retain human version choice and show read-only handoff without deployment targets", async ({
  page,
}) => {
  const evidence = resolve(".factory/test-results/releases/browser");
  const cache = resolve(".factory/test-results/vite", `release-${crypto.randomUUID()}`);
  const frontend = await createServer({
    configFile: false,
    root: resolve("test/fixtures"),
    cacheDir: cache,
    publicDir: resolve("apps/factory/public"),
    optimizeDeps: { entries: ["project-inputs.html"] },
    plugins: [
      solid({
        ssr: false,
        serverFunctions: {
          devMiddleware: false,
          filter: { include: resolve("apps/factory/src/server-functions/**/*.{ts,tsx}") },
        },
      }),
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await frontend.listen();
  const origin = frontend.resolvedUrls!.local[0]!;
  const view = releaseSettingsView.parse({
    canPublish: true,
    canManageAccess: true,
    configured: true,
    candidateSHA: "a".repeat(40),
    lastVersion: "1.4.2",
    suggestions: { patch: "1.4.3", minor: "1.5.0", major: "2.0.0" },
    repositoryURL: "https://forge.example/factory/project.git",
    registryURL: "https://forge.example",
    packageOwner: "factory-release-owned-project",
    contract: { schemaVersion: 1, images: ["web"], chart: "app" },
    configurationError: null,
    releases: [],
    access: [],
  });
  const published: unknown[] = [];
  let creates = 0;
  let rotations = 0;
  let revocations = 0;
  let reads = 0;
  let failReads = false;
  let reconciliations = 0;
  let endings = 0;
  let dropAccessResponse = false;
  const accessCommands: string[] = [];
  const accessCommandIDs = new Set<string>();
  let grantID = crypto.randomUUID();
  await mockFactoryFunctions(
    page,
    {
      access: {
        authentication: async () => ({
          fresh: true,
          email: "developer@factory.invalid",
          companySignIn: false,
        }),
      },
      releases: {
        view: async () => {
          reads++;
          if (failReads) throw new Error("Synthetic read failure");
          return structuredClone(view);
        },
        reconcile: async () => {
          reconciliations++;
        },
        end: async () => {
          endings++;
          view.releases[0]!.endedAt = "2026-10-25T12:00:00Z";
        },
        publish: async (_user, _project, input) => {
          published.push(input);
          const id = crypto.randomUUID();
          view.releases = [
            {
              id,
              version: input.version,
              commitSHA: input.commitSHA,
              notes: input.notes ?? "",
              state: "published",
              createdAt: "2026-10-25T10:00:00Z",
              publishedAt: "2026-10-25T10:00:00Z",
              endedAt: null,
              failure: null,
              runURL: "https://forge.example/actions/runs/7",
              releaseURL: "https://forge.example/releases/v1.5.0",
              artifacts: [{ kind: "image", name: "web", digest: `sha256:${"b".repeat(64)}` }],
            },
          ];
          view.lastVersion = input.version;
          view.suggestions = { patch: "1.5.1", minor: "1.6.0", major: "2.0.0" };
          return { id };
        },
        createAccess: async (_user, _project, input) => {
          creates++;
          accessCommands.push(input.commandID);
          if (accessCommandIDs.has(input.commandID))
            return { id: grantID, username: "synthetic-reader", token: null };
          accessCommandIDs.add(input.commandID);
          view.access = [
            {
              id: grantID,
              name: input.name,
              scope: input.scope,
              state: "active",
              createdAt: "2026-10-25T10:00:00Z",
              username: "synthetic-reader",
            },
          ];
          return {
            id: grantID,
            username: "synthetic-reader",
            token: "synthetic-one-time-token",
          };
        },
        rotateAccess: async () => {
          rotations++;
          grantID = crypto.randomUUID();
          view.access = [{ ...view.access[0]!, id: grantID }];
          return {
            id: grantID,
            username: "synthetic-reader-rotated",
            token: "synthetic-rotated-token",
          };
        },
        revokeAccess: async () => {
          revocations++;
          view.access = view.access.map((grant) => ({ ...grant, state: "revoked" }));
        },
      },
    },
    (name) => {
      if (name !== "createReleaseAccess" || !dropAccessResponse) return false;
      dropAccessResponse = false;
      return true;
    },
  );
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/project-inputs.html`);
    await chooseSettingsPage(page, "Releases");
    const releases = page.getByRole("region", { name: "Project releases", exact: true });
    await expect(releases.getByText("1.4.2", { exact: true })).toBeVisible();
    await expect(releases.getByLabel("Version", { exact: true })).toHaveValue("");
    await expect(releases.getByRole("button", { name: "Review publication" })).toBeDisabled();
    await releases.getByLabel("Version", { exact: true }).fill("v1.5.0");
    await expect(releases.getByRole("button", { name: "Review publication" })).toBeDisabled();
    expect(published).toHaveLength(0);
    await releases.getByRole("button", { name: "Minor 1.5.0", exact: true }).click();
    await expect(releases.getByLabel("Version", { exact: true })).toHaveValue("1.5.0");
    await releases
      .getByLabel("Release notes")
      .fill("A human-approved version.\nWith a second line.");
    await releases.getByRole("button", { name: "Review publication" }).click();
    const confirmation = releases.getByRole("region", { name: "Confirm publication" });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("heading")).toBeFocused();
    await expect(confirmation).toContainText("With a second line.");
    await releases.getByRole("button", { name: "Edit version" }).click();
    await expect(releases.getByLabel("Version", { exact: true })).toBeFocused();
    await expect(releases.getByLabel("Release notes")).toHaveValue(
      "A human-approved version.\nWith a second line.",
    );
    await releases.getByRole("button", { name: "Review publication" }).press("Enter");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: `${evidence}/confirmation.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(published).toHaveLength(0);
    await releases.getByRole("button", { name: "Publish version 1.5.0" }).click();
    await expect.poll(() => published.length).toBe(1);
    expect(published[0]).toMatchObject({ version: "1.5.0", commitSHA: "a".repeat(40) });
    await expect(releases.getByLabel("Version", { exact: true })).toHaveValue("");
    await expect(
      releases.getByText("This version is already reserved.", { exact: false }),
    ).toHaveCount(0);
    await releases.getByRole("button", { name: "External access", exact: true }).click();
    await releases.getByLabel("Access name").fill("Production image reader");
    await releases.getByLabel("Read scope").selectOption("packages");
    await releases.getByRole("button", { name: "Create read access" }).click();
    await expect(releases.getByLabel("Access token", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await expect(releases.getByRole("heading", { name: "Save this credential now" })).toBeFocused();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await releases.getByRole("button", { name: "Copy access token", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("synthetic-one-time-token");
    await expect(releases.getByLabel("Access token", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await releases.getByRole("region", { name: "New machine credential" }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/credential-desktop.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await releases.getByLabel("Access token", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/credential-phone.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await releases.getByRole("button", { name: "Show token" }).click();
    await expect(releases.getByLabel("Access token", { exact: true })).toHaveValue(
      "synthetic-one-time-token",
    );
    await releases.getByRole("button", { name: "Dismiss credential" }).click();
    await expect(releases.getByLabel("Access token", { exact: true })).toHaveCount(0);
    expect(creates).toBe(1);
    await releases.getByRole("button", { name: "Rotate Production image reader" }).click();
    await expect(
      releases.getByRole("heading", { name: "Rotate Production image reader?" }),
    ).toBeFocused();
    expect(rotations).toBe(0);
    await releases.getByRole("button", { name: "Confirm rotation" }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/rotation.png`,
      fullPage: true,
      animations: "disabled",
    });
    await releases.getByRole("button", { name: "Keep credential" }).click();
    expect(rotations).toBe(0);
    await releases.getByRole("button", { name: "Rotate Production image reader" }).click();
    await releases.getByRole("button", { name: "Confirm rotation" }).click();
    await expect(releases.getByLabel("Access token", { exact: true })).toHaveValue(
      "synthetic-rotated-token",
    );
    expect(rotations).toBe(1);
    await releases.getByRole("button", { name: "Dismiss credential" }).click();
    await releases.getByRole("button", { name: "Revoke Production image reader" }).click();
    await expect(
      releases.getByRole("heading", { name: "Revoke Production image reader?" }),
    ).toBeFocused();
    expect(revocations).toBe(0);
    await releases.getByRole("button", { name: "Confirm revocation" }).click();
    await expect.poll(() => revocations).toBe(1);
    await releases.getByRole("button", { name: "Versions", exact: true }).click();
    await releases.locator("summary").filter({ hasText: "1.5.0" }).click();
    await expect(releases.getByRole("link", { name: "Open Forgejo release" })).toHaveAttribute(
      "href",
      "https://forge.example/releases/v1.5.0",
    );
    const readBefore = reads;
    await expect.poll(() => reads).toBeGreaterThan(readBefore);
    await expect(releases.getByRole("link", { name: "Open Forgejo release" })).toBeVisible();
    await releases.getByRole("button", { name: "Copy web reference", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`forge.example/factory-release-owned-project/web@sha256:${"b".repeat(64)}`);
    await page.locator(".settings-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: `${evidence}/desktop.png`,
      fullPage: true,
      animations: "disabled",
    });
    await releases.getByRole("button", { name: "External access", exact: true }).click();
    await page.screenshot({
      path: `${evidence}/desktop-access.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await releases.getByRole("button", { name: "Versions", exact: true }).click();
    await page.locator(".settings-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: `${evidence}/phone.png`,
      fullPage: true,
      animations: "disabled",
    });
    await releases.getByRole("button", { name: "External access", exact: true }).click();
    await page.screenshot({
      path: `${evidence}/phone-access.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 900, height: 900 });
    await releases.getByRole("button", { name: "Versions", exact: true }).click();
    await page.screenshot({
      path: `${evidence}/intermediate.png`,
      fullPage: true,
      animations: "disabled",
    });
    // A stale read blocks a new publication, but never starts or replays a command.
    failReads = true;
    await releases.getByRole("button", { name: "Refresh releases" }).click();
    await expect(releases.getByRole("alert")).toContainText("Showing the last confirmed data");
    await releases.getByRole("button", { name: "Patch 1.5.1", exact: true }).click();
    await expect(releases.getByRole("button", { name: "Review publication" })).toBeDisabled();
    expect(published).toHaveLength(1);
    failReads = false;
    await releases.getByRole("button", { name: "Refresh releases" }).click();
    await expect(releases.getByRole("alert")).toHaveCount(0);
    await expect(releases.getByRole("button", { name: "Review publication" })).toBeEnabled();
    // Uncertainty and ending an attempt never claim an artifact rollback.
    view.releases[0]!.state = "uncertain";
    view.releases[0]!.failure = "The native publication outcome is unconfirmed.";
    await releases.getByRole("button", { name: "Refresh releases" }).click();
    const summary = releases.locator("summary").filter({ hasText: "1.5.0" });
    await summary.click();
    await expect(summary).toContainText("Outcome unconfirmed");
    await expect(releases.getByRole("button", { name: "Review publication" })).toBeDisabled();
    await releases.getByRole("button", { name: "Check outcome", exact: true }).click();
    expect(reconciliations).toBe(1);
    await releases.getByRole("button", { name: "End attempt", exact: true }).click();
    await expect(releases.getByRole("heading", { name: "End this attempt?" })).toBeFocused();
    expect(endings).toBe(0);
    await expect(releases.getByRole("region", { name: "End publication attempt" })).toContainText(
      "not rolled back",
    );
    await page.screenshot({
      path: `${evidence}/uncertain.png`,
      fullPage: true,
      animations: "disabled",
    });
    await releases.getByRole("button", { name: "Confirm end attempt" }).click();
    await expect(summary).toContainText("Ended · Outcome unconfirmed");
    expect(endings).toBe(1);
    // Source-only and missing-candidate states need no publication workflow.
    view.contract = null;
    view.candidateSHA = null;
    view.lastVersion = null;
    view.releases = [];
    await releases.getByRole("button", { name: "Refresh releases" }).click();
    await expect(releases.getByText("No releases yet", { exact: true })).toBeVisible();
    await expect(
      releases.getByText("Source only. No application image is required."),
    ).toBeVisible();
    await expect(releases.getByRole("button", { name: "Review publication" })).toBeDisabled();
    await page.screenshot({
      path: `${evidence}/empty.png`,
      fullPage: true,
      animations: "disabled",
    });
    await releases.getByRole("button", { name: "External access", exact: true }).click();
    await releases.getByLabel("Access name").fill("Lost response reader");
    dropAccessResponse = true;
    await releases.getByRole("button", { name: "Create read access" }).click();
    await expect(releases.getByRole("alert")).toBeVisible();
    expect(creates).toBe(2);
    await releases.getByRole("button", { name: "Create read access" }).click();
    await expect(
      releases.getByText("The token cannot be shown again.", { exact: false }),
    ).toBeVisible();
    expect(creates).toBe(3);
    expect(accessCommands[2]).toBe(accessCommands[1]);
    expect(accessCommandIDs.size).toBe(2);
    await releases.getByRole("button", { name: "Dismiss credential" }).click();
    await releases.getByRole("button", { name: "Versions", exact: true }).click();
    view.canPublish = false;
    view.canManageAccess = false;
    await releases.getByRole("button", { name: "Refresh releases" }).click();
    await expect(releases.getByText("Developer access is required to publish.")).toBeVisible();
    await expect(releases.getByLabel("Version", { exact: true })).toHaveCount(0);
    await expect(
      releases.getByRole("button", { name: "External access", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/read-only.png`,
      fullPage: true,
      animations: "disabled",
    });
    await writeFile(`${evidence}/console-warnings.json`, JSON.stringify(warnings, null, 2));
    expect(errors).toEqual([]);
  } finally {
    await frontend.close();
    await rm(cache, { recursive: true, force: true });
  }
});
