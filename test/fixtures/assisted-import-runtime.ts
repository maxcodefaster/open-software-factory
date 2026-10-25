import { expect } from "bun:test";
import { chromium } from "@playwright/test";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { setupInspectionView } from "../../packages/project-domain/src/setup";
import { eventually, type factoryProcess } from "./factory-process";
import { starterPreviewBrowser } from "./starter-preview-browser";
import { callFactoryFunction } from "./server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

export async function assistedImportRuntime(input: {
  factory: Awaited<ReturnType<typeof factoryProcess>>;
  projectID: string;
  cookie: string;
  forge: ReturnType<typeof createForgejoClient>;
  repository: { owner: string; name: string };
  sourceCommit: string;
  sourceFiles: readonly { path: string; content: string }[];
}) {
  const { factory, projectID, cookie, forge, repository, sourceCommit, sourceFiles } = input;
  const database = factory.connect();
  const browser = await chromium.launch({ headless: true });
  const started = performance.now();
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(factory.base + path, {
      method,
      headers: { cookie, origin: factory.base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Owned assisted import ${path}: HTTP ${response.status}`);
    return response.json();
  }
  try {
    if (process.env["FACTORY_ASSISTED_IMPORT_RETRY_INSPECTION"] === "1") {
      const current = setupInspectionView.parse(
        await serverCall(
          callFactoryFunction(factory.base, "getSetupInspection", [projectID], { cookie }),
        ),
      );
      if (current.state !== "failed")
        throw new Error("Explicit inspection retry requires settled failure");
      await serverCall(
        callFactoryFunction(
          factory.base,
          "startSetupInspection",
          [projectID, { id: crypto.randomUUID() }],
          { cookie },
        ),
      );
    }
    let proposal = await eventually(
      async () => {
        const view = setupInspectionView.parse(
          await serverCall(
            callFactoryFunction(factory.base, "getSetupInspection", [projectID], { cookie }),
          ),
        );
        if (view.state === "failed") throw new Error(`Import inspection failed: ${view.failure}`);
        return view;
      },
      (view) => view.state === "proposal" || view.state === "confirmed",
      "Imported Starter inspection did not settle",
      90_000,
    );
    // Fixture's human answers establish choices, not fabricated model output.
    for (let round = 0; proposal.output?.questions.length && round < 2; round++) {
      const answers = Object.fromEntries(
        proposal.output.questions.map((question) => [
          question.id,
          "Yes. Use Node 24 and PostgreSQL 16 inside the Dev Container Compose stack. Fresh Verification starts this same declared Dev Container stack including PostgreSQL at postgres:5432, database/user app, and executes postCreateCommand before the workflow. postCreateCommand runs npm ci, then npm run db:migrate. npm run dev serves the Solid web app on 4300 and /health. npm run check verifies it. DATABASE_URL connects to app:POSTGRES_PASSWORD at postgres:5432/app. DATABASE_URL, POSTGRES_PASSWORD and BETTER_AUTH_SECRET are entered securely in both Factory environments with runtime and verification enabled, injected by Factory, never committed. Use /workspace/project and user node. Preserve all existing application files.",
        ]),
      );
      await serverCall(
        callFactoryFunction(
          factory.base,
          "startSetupInspection",
          [
            projectID,
            {
              id: crypto.randomUUID(),
              parentID: proposal.id,
              answers,
            },
          ],
          { cookie },
        ),
      );
      proposal = await eventually(
        async () => {
          const view = setupInspectionView.parse(
            await serverCall(
              callFactoryFunction(factory.base, "getSetupInspection", [projectID], { cookie }),
            ),
          );
          if (view.state === "failed")
            throw new Error(`Answered import inspection failed: ${view.failure}`);
          return view;
        },
        (view) => view.state === "proposal",
        "Answered import inspection did not settle",
        90_000,
      );
    }
    expect(proposal.output?.questions).toHaveLength(0);
    expect(
      proposal.output?.files.some((file) => file.path === ".devcontainer/devcontainer.json"),
    ).toBe(true);
    expect(proposal.output?.files.some((file) => file.path === ".factory/system.json")).toBe(true);
    expect((await forge.getDefaultBranch(repository)).headSha).toBe(sourceCommit);
    const alreadyConfirmed = proposal.state === "confirmed";
    if (!alreadyConfirmed)
      expect(
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
      ).toHaveLength(0);
    await serverCall(
      callFactoryFunction(factory.base, "confirmSetupInspection", [projectID, proposal.id], {
        cookie,
      }),
    );
    const confirmed = setupInspectionView.parse(
      await serverCall(
        callFactoryFunction(factory.base, "getSetupInspection", [projectID], { cookie }),
      ),
    );
    expect(confirmed.state).toBe("confirmed");
    const head = await forge.getDefaultBranch(repository);
    for (const file of sourceFiles)
      expect(await forge.getFile(repository, file.path, head.headSha)).toBe(file.content);
    const config = await forge.getFile(repository, ".devcontainer/devcontainer.json", head.headSha);
    expect(config).not.toContain("owned-import-password");
    // Missing credentials must block compute. Configuration approval does not synthesize secrets.
    if (!alreadyConfirmed) {
      const tasks = await eventually(
        () =>
          serverCall(
            callFactoryFunction(factory.base, "getSetupReadiness", [projectID], { cookie }),
          ),
        (rows) =>
          rows.some(
            (row: { task: string; state: string }) =>
              row.task === "preview-secrets" && row.state === "failed",
          ),
        "Imported Starter did not request its missing environment values",
        30_000,
      );
      expect(
        tasks.some(
          (row: { task: string; state: string }) =>
            row.task === "main-preview" && row.state === "ready",
        ),
      ).toBe(false);
    }
    if (alreadyConfirmed) {
      // Resume environment preparation, never repeat the confirmed paid inspection.
      const attempts = await database.client<{ id: string; state: string }[]>`
        SELECT id,state FROM factory.runtime_attempt WHERE project_id=${projectID}`;
      for (const attempt of attempts) {
        if (attempt.state === "stopped") continue;
        await serverCall(
          callFactoryFunction(factory.base, "stopRuntimeAttempt", [attempt.id], {
            cookie,
            origin: factory.base,
            "content-type": "application/json",
          }),
        );
        await eventually(
          async () =>
            (
              await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id}`
            )[0]?.["state"],
          (state) => state === "stopped",
          "Retained imported runtime Stop pending",
          150_000,
        );
      }
    }
    for (const environment of ["development", "main-preview"] as const) {
      const metadata = await serverCall(
        callFactoryFunction(factory.base, "getEnvironment", [projectID, environment], { cookie }),
      );
      const password = crypto.randomUUID();
      const secret = crypto.randomUUID();
      const variables = [
        { name: "POSTGRES_PASSWORD", value: password },
        { name: "DATABASE_URL", value: `postgresql://app:${password}@postgres:5432/app` },
        { name: "BETTER_AUTH_SECRET", value: secret },
      ].map((variable) => ({ ...variable, runtime: true, build: false, verification: true }));
      const saved = await serverCall(
        callFactoryFunction(
          factory.base,
          "saveEnvironment",
          [
            projectID,
            environment,
            {
              commandID: crypto.randomUUID(),
              version: metadata.version,
              variables,
              registries: [],
            },
          ],
          { cookie },
        ),
      );
      expect(JSON.stringify(saved)).not.toContain(password);
      expect(JSON.stringify(saved)).not.toContain(secret);
      await serverCall(
        callFactoryFunction(
          factory.base,
          "retrySetupTask",
          [projectID, environment === "development" ? "development-secrets" : "preview-secrets"],
          { cookie },
        ),
      );
    }
    if (alreadyConfirmed)
      await serverCall(
        callFactoryFunction(factory.base, "retrySetupTask", [projectID, "main-preview"], {
          cookie,
        }),
      );
    await eventually(
      async () => {
        const rows = await serverCall(
          callFactoryFunction(factory.base, "getSetupReadiness", [projectID], { cookie }),
        );
        const preview = rows.find((row: { task: string }) => row.task === "main-preview");
        if (preview?.state === "failed")
          throw new Error(`Imported Starter preview failed: ${preview.failure}`);
        return rows;
      },
      (rows) =>
        rows.some(
          (row: { task: string; state: string }) =>
            row.task === "main-preview" && row.state === "ready",
        ),
      "Imported Starter Main-Preview did not become ready",
      600_000,
    );
    const [preview] = await database.client<{ id: string }[]>`
      SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id=${projectID}`;
    if (!preview) throw new Error("Imported Starter preview missing");
    await starterPreviewBrowser({
      browser,
      base: factory.base,
      cookie,
      previewID: preview.id,
      heading: "You're home.",
      screenshot: ".factory/screenshots/project-setup/imported-starter-home.png",
    });
    expect((await forge.getDefaultBranch(repository)).headSha).toBe(head.headSha);
    console.log(
      JSON.stringify({
        journey:
          "Private Starter import, native proposal, confirmation, secure settings and real App",
        projectID,
        elapsedMS: Math.round(performance.now() - started),
      }),
    );
    const attempts = await database.client<
      { id: string; state: string }[]
    >`SELECT id,state FROM factory.runtime_attempt WHERE project_id=${projectID}`;
    for (const attempt of attempts) {
      if (attempt.state === "stopped") continue;
      await serverCall(
        callFactoryFunction(factory.base, "stopRuntimeAttempt", [attempt.id], {
          cookie,
          origin: factory.base,
          "content-type": "application/json",
        }),
      );
      await eventually(
        async () => {
          const [current] = await database.client<
            { state: string }[]
          >`SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id}`;
          return current?.state;
        },
        (state) => state === "stopped",
        "Imported Starter cleanup did not Stop",
        150_000,
      );
    }
  } finally {
    await browser.close();
    await database.client.end({ timeout: 2 });
  }
}
