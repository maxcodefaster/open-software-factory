import { expect, test } from "bun:test";
import { callFactoryFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { mcpLibraryView } from "../../packages/conversation-domain/src/mcp-library";
import { monitoringView } from "../../packages/conversation-domain/src/monitoring";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { ensureLocalForgeIdentity } from "../../scripts/factory/forge-identity";
import { localOpenBao } from "../../scripts/factory/openbao";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { monitoringNativeSource, ownedMonitoringForge } from "../fixtures/monitoring-native";
import { runtimeAccessCookie } from "../fixtures/runtime-access";
import { fixtureValue } from "../fixtures/value";

const stateInput = z
  .object({
    id: z.uuid(),
    factory: z.object({ id: z.uuid(), base: z.url() }).optional(),
    projectId: z.uuid().optional(),
    managerId: z.uuid().optional(),
    sourceId: z.uuid(),
    sourceRevisionId: z.uuid(),
    connectCommandId: z.uuid(),
    hookId: z.uuid(),
    hookCommandId: z.uuid(),
    incidentId: z.uuid().optional(),
    complete: z.boolean().default(false),
  })
  .strict();
type State = z.infer<typeof stateInput>;

test.skipIf(process.env["FACTORY_RUN_MONITORING_AUTOFIX_PROOF"] !== "1")(
  "a deduplicated authenticated alert reaches real Build, fresh Verification, independent review and delegated Delivery on the configured branch",
  async () => {
    const codingModel = process.env["FACTORY_AGENT_MODEL_ID"];
    const planningModel = process.env["FACTORY_PROJECT_AGENT_MODEL"];
    if (
      !codingModel ||
      !planningModel ||
      !process.env["FACTORY_MODEL_API_KEY"] ||
      !process.env["FACTORY_MODEL_BASE_URL"] ||
      !process.env["FACTORY_PLANNING_MODEL_API_KEY"] ||
      !process.env["FACTORY_PLANNING_MODEL_BASE_URL"]
    )
      throw new Error("The configured Coding and Planning connections are required");
    const root = resolve(".factory/test-results/monitoring/native");
    const continuation = process.env["FACTORY_MONITORING_AUTOFIX_RESUME"];
    const directory = continuation
      ? resolve(continuation, "..")
      : resolve(root, crypto.randomUUID());
    if (!directory.startsWith(`${root}/`))
      throw new Error("An exact owned monitoring proof is required");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stateFile = resolve(directory, "state.json");
    const state: State = continuation
      ? stateInput.parse(JSON.parse(await readFile(stateFile, "utf8")))
      : {
          id: fixtureValue(directory.split("/").at(-1), 'directory.split("/").at(-1)'),
          sourceId: crypto.randomUUID(),
          sourceRevisionId: crypto.randomUUID(),
          connectCommandId: crypto.randomUUID(),
          hookId: crypto.randomUUID(),
          hookCommandId: crypto.randomUUID(),
          complete: false,
        };
    if (state.complete)
      throw new Error("This monitoring proof is already complete; do not replay it");
    if (
      continuation &&
      ((await Bun.file(resolve(directory, "failed-fixture-cleanup.json")).exists()) ||
        (await Bun.file(resolve(directory, "cleanup.json")).exists()))
    )
      throw new Error(
        "This owned proof was cleaned up. Its retained identities must not be recreated.",
      );
    const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await save();
    const sourceFile = resolve(directory, "source.json");
    const source = continuation
      ? monitoringNativeSource.parse(JSON.parse(await readFile(sourceFile, "utf8")))
      : monitoringNativeSource.parse({
          endpoint: "https://monitoring.factory.test/mcp",
          bearer: crypto.randomUUID(),
          observations: resolve(directory, "mcp-calls.ndjson"),
        });
    if (!continuation)
      await writeFile(sourceFile, JSON.stringify(source), { mode: 0o600, flag: "wx" });
    const bao = await localOpenBao(directory);
    const baoConfiguration = await bao.start();
    const forgeHost = await ownedMonitoringForge(directory, state.id);
    const runtimeHostImage = (await readFile(".factory/runtime-host-image", "utf8")).trim();
    const factory = await factoryProcess(
      { runtimeHostImage, forgejoToken: forgeHost.token },
      {
        ...baoConfiguration,
        FACTORY_FORGEJO_API_URL: `${forgeHost.origin}/api/v1/`,
        FACTORY_FORGEJO_OWNER: forgeHost.owner,
        FACTORY_FORGEJO_ADMIN_TOKEN: forgeHost.token,
        FACTORY_MODEL_IDS: [...new Set([codingModel, planningModel])].join(","),
        FACTORY_AGENT_MODEL_ID: codingModel,
        FACTORY_PROJECT_AGENT_MODEL: planningModel,
      },
      state.factory,
    );
    state.factory = { id: factory.id, base: factory.base };
    await save();
    const database = factory.connect();
    const forge = createForgejoClient({
      apiURL: `${forgeHost.origin}/api/v1/`,
      token: forgeHost.token,
    });
    const repository = { owner: forgeHost.owner, name: `monitoring-${state.id.slice(0, 8)}` };
    const managerEmail = `manager-${state.id}@monitoring.test`;
    const managerPassword = "owned-monitoring-developer-password";
    let adminCookie = "";
    let managerCookie = "";
    let succeeded = false;
    async function request(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
      return fetch(factory.base + path, {
        method,
        headers: { cookie, origin: factory.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
    }
    async function _api(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
      const response = await request(path, method, body, cookie);
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw new Error(
          `Owned monitoring ${method} ${path}: ${response.status} ${String(value?.error ?? "").slice(0, 300)}`,
        );
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    async function app(attemptId: string, path: string) {
      const cookie = await runtimeAccessCookie(factory.base, adminCookie, attemptId, "app");
      const response = await fetch(`${factory.base}/runtime/${attemptId}/app${path}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: await response.json() };
    }
    const webhookFile = resolve(directory, "webhook-url");
    const current = async () => {
      if (!state.projectId) throw new Error("Owned monitoring Project is missing");
      return monitoringView.parse(
        await serverCall(
          callFactoryFunction(factory.base, "getProjectInputs", [state.projectId], {
            cookie: adminCookie,
          }),
        ),
      );
    };
    try {
      if (!continuation) {
        await forgeHost.api("user/repos", "POST", {
          name: repository.name,
          private: true,
          auto_init: false,
          default_branch: "release",
          description: `Owned monitoring native proof ${state.id}`,
        });
        const files = await Promise.all(
          [".devcontainer/devcontainer.json", ".devcontainer/compose.yaml", "support.mjs"].map(
            async (path) => ({
              path,
              content: await readFile(`test/fixtures/runtime-project/${path}`, "utf8"),
            }),
          ),
        );
        files.push(
          {
            path: "package.json",
            content: JSON.stringify({
              name: "owned-monitoring-app",
              private: true,
              type: "module",
              scripts: { check: "node --check src/server.mjs && node --test" },
            }),
          },
          {
            path: "AGENTS.md",
            content:
              "Implement only the approved invoice defect. Run npm run check. Add focused regression coverage. Preserve dependencies, runtime configuration, CI, and the System Contract. Do not commit or push; Factory owns submission.\n",
          },
          {
            path: ".factory/system.json",
            content: JSON.stringify({
              version: 1,
              primaryApp: "web",
              apps: [
                {
                  id: "web",
                  label: "Invoice service",
                  command: ["node", "src/server.mjs"],
                  port: 4300,
                  healthPath: "/health",
                },
              ],
            }),
          },
          {
            path: ".forgejo/workflows/factory-verification.yml",
            content:
              "name: Factory Verification\non:\n  pull_request:\n    types: [opened, reopened, synchronize]\njobs:\n  verify:\n    runs-on: factory-verification\n    steps:\n      - working-directory: /workspace/project\n        run: npm run check\n",
          },
          {
            path: "src/invoice.mjs",
            content:
              "const invoices = [{ id: 'known', total: 12 }];\nexport function invoiceTotal(id) {\n  return invoices.find((invoice) => invoice.id === id).total;\n}\n",
          },
          {
            path: "src/invoice.test.mjs",
            content:
              "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { invoiceTotal } from './invoice.mjs';\ntest('known invoice retains its total', () => assert.equal(invoiceTotal('known'), 12));\n",
          },
          {
            path: "src/server.mjs",
            content: [
              "import { createServer } from 'node:http';",
              "import { invoiceTotal } from './invoice.mjs';",
              "createServer((request, response) => {",
              "  response.setHeader('content-type', 'application/json');",
              "  if (request.url === '/health') return response.end(JSON.stringify({ status: 'ok' }));",
              "  if (request.url.startsWith('/invoices/')) {",
              "    try {",
              "      const total = invoiceTotal(decodeURIComponent(request.url.slice('/invoices/'.length)));",
              "      response.statusCode = total === null ? 404 : 200;",
              "      return response.end(JSON.stringify({ total }));",
              "    } catch { response.statusCode = 500; return response.end(JSON.stringify({ error: 'Invoice lookup failed' })); }",
              "  }",
              "  response.end(JSON.stringify({ app: 'Owned monitoring invoice fixture' }));",
              "}).listen(4300, '0.0.0.0');",
              "",
            ].join("\n"),
          },
        );
        await forge.createSetupFiles({ repository, branch: "release", setupID: state.id, files });
        const base = await forge.getDefaultBranch(repository);
        await forge.ensureBranch(repository, "main", base.headSha);
        await writeFile(
          resolve(directory, "base.json"),
          JSON.stringify({ sha: base.headSha, branch: "release" }, null, 2),
        );
      }
      await factory.start("test/fixtures/monitoring-native-server.ts", [sourceFile]);
      adminCookie = await factory.signIn();
      const [connection] = await database.client<{ sourceId: number | null }[]>`
        SELECT source_id::int AS "sourceId" FROM factory.forge_connection`;
      await ensureLocalForgeIdentity({
        factoryURL: factory.base,
        forgeURL: forgeHost.origin,
        discoveryURL: `http://host.orb.internal:${new URL(factory.base).port}/api/auth/.well-known/openid-configuration`,
        email: `owned-${factory.id}@factory.local`,
        password: "owned-process-password-not-a-secret",
        signingKey: "owned-process-auth-secret-not-a-production-credential",
        ...(connection?.sourceId ? { retainedSourceID: connection.sourceId } : {}),
        execute: forgeHost.execute,
        reload: forgeHost.reload,
      });
      const initialBranch = await forge.getDefaultBranch(repository);
      const recordedBase = JSON.parse(await readFile(resolve(directory, "base.json"), "utf8"));
      expect(initialBranch.name).toBe("release");
      if (!state.incidentId) expect(initialBranch.headSha).toBe(recordedBase.sha);
      if (!state.projectId) {
        const project = await serverCall(
          callFactoryFunction(
            factory.base,
            "registerProject",
            [
              {
                slug: repository.name,
                name: "Owned monitoring Autofix",
                repositoryUrl: `${forgeHost.origin}/${repository.owner}/${repository.name}.git`,
                defaultBranch: "release",
                devcontainerPath: ".devcontainer/devcontainer.json",
              },
            ],
            { cookie: adminCookie },
          ),
        );
        state.projectId = z.uuid().parse(project.id);
        await save();
      }
      if (!state.managerId) {
        const manager = await serverCall(
          callFactoryFunction(
            factory.base,
            "createAccount",
            [
              {
                name: "Owned monitoring manager-developer",
                email: managerEmail,
                password: managerPassword,
              },
            ],
            { cookie: adminCookie },
          ),
        );
        state.managerId = z.uuid().parse(manager.id);
        await serverCall(
          callFactoryFunction(
            factory.base,
            "saveProjectMember",
            [
              state.projectId,
              {
                email: managerEmail,
                role: "developer",
                manageProject: true,
              },
            ],
            { cookie: adminCookie },
          ),
        );
        await save();
      }
      const login = await request(
        "/api/auth/sign-in/email",
        "POST",
        { email: managerEmail, password: managerPassword },
        "",
      );
      expect(login.ok).toBe(true);
      managerCookie = login.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const projectID = state.projectId;
      if (!projectID) throw new Error("Owned monitoring Project is missing");
      const library = async () =>
        mcpLibraryView.parse(
          await serverCall(
            callFactoryFunction(factory.base, "getMCPLibrary", [projectID], {
              cookie: adminCookie,
            }),
          ),
        );
      let entry = (await library()).entries.find((entry) => entry.id === state.sourceId);
      if (!entry) {
        await serverCall(
          callFactoryFunction(
            factory.base,
            "saveMCPDefinition",
            [
              {
                libraryId: state.sourceId,
                revisionId: state.sourceRevisionId,
                expectedRevision: 0,
                scope: "system",
                content: {
                  name: "Owned authenticated monitoring source",
                  description: "Synthetic incidents for the native Autofix proof.",
                  endpoint: source.endpoint,
                  authentication: "bearer",
                  provider: "custom",
                  roles: ["planning", "build"],
                },
              },
            ],
            { cookie: adminCookie },
          ),
        );
        await serverCall(
          callFactoryFunction(
            factory.base,
            "connectMCP",
            [
              state.sourceId,
              {
                commandId: state.connectCommandId,
                revisionId: state.sourceRevisionId,
                expectedVersion: 0,
                token: source.bearer,
              },
            ],
            { cookie: adminCookie },
          ),
        );
        entry = (await library()).entries.find((entry) => entry.id === state.sourceId);
      }
      if (entry?.connection?.state === "review") {
        await serverCall(
          callFactoryFunction(
            factory.base,
            "reviewMCPAccess",
            [
              state.sourceId,
              {
                expectedVersion: entry.connection.version,
                confirmReadOnlyAccess: true,
                tools: entry.connection.tools.map(({ name, digest }) => ({ name, digest })),
              },
            ],
            { cookie: adminCookie },
          ),
        );
        entry = (await library()).entries.find((entry) => entry.id === state.sourceId);
      }
      if (entry?.connection?.state !== "ready")
        throw new Error("The exact owned MCP connection is not ready; no reconnect is automatic");
      if (!entry.connection.projectGrants.includes(state.projectId))
        await serverCall(
          callFactoryFunction(
            factory.base,
            "grantMCPProject",
            [
              state.sourceId,
              {
                projectId: projectID,
                enabled: true,
                expectedVersion: entry.connection.version,
              },
            ],
            { cookie: adminCookie },
          ),
        );
      const secretWrites = await database.client<{ key: string }[]>`
        SELECT secret_key AS key FROM factory.mcp_secret_write WHERE connection_id=${state.sourceId} AND state='committed'`;
      expect(secretWrites.length).toBeGreaterThan(0);
      await eventually(
        async () =>
          (
            await database.client<{ confirmed: boolean }[]>`
          SELECT confirmed FROM factory.forge_branch_intent WHERE project_id=${fixtureValue(state.projectId, "state.projectId")} AND branch='release'`
          )[0]?.confirmed,
        (confirmed) => confirmed === true,
        "Owned Project protection did not become ready",
        180_000,
      );
      let webhook = await readFile(webhookFile, "utf8").catch(() => undefined);
      if (!webhook) {
        const saved = await serverCall(
          callFactoryFunction(
            factory.base,
            "saveProjectInput",
            [
              projectID,
              {
                id: state.hookId,
                commandId: state.hookCommandId,
                expectedVersion: 0,
                name: "Owned invoice alerts",
                connectionIds: [state.sourceId],
                enabled: true,
                delegation: "application-fix-and-delivery",
              },
            ],
            { cookie: managerCookie },
          ),
        );
        webhook = z.url().parse(saved.url);
        await writeFile(webhookFile, webhook, { mode: 0o600, flag: "wx" });
      }
      let incident = (await current()).incidents.find(
        (incident) => incident.hookId === state.hookId,
      );
      if (!incident) {
        console.info("Monitoring native: submitting owned duplicate alert deliveries");
        const receipts = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            fetch(webhook, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: "Invoice lookup throws for a missing invoice",
                fingerprint: "owned-invoice-42",
                event_id: `owned-delivery-${index}`,
                url: "https://monitoring.factory.test/issues/42",
                context: { issue_id: "42", stack: "src/invoice.mjs:3" },
              }),
            }),
          ),
        );
        for (const receipt of receipts) expect(receipt.status).toBe(202);
        const bodies = await Promise.all(receipts.map((receipt) => receipt.json()));
        expect(bodies.reduce((sum, receipt) => sum + receipt.accepted, 0)).toBe(1);
        expect(bodies.reduce((sum, receipt) => sum + receipt.duplicates, 0)).toBe(7);
        incident = (await current()).incidents[0];
        if (!incident) throw new Error("The owned incident was not retained");
        state.incidentId = incident.id;
        await save();
      }
      if (!state.incidentId) {
        state.incidentId = incident.id;
        await save();
      }
      let previous = "";
      const delivered = await eventually(
        async () => {
          const view = await current();
          const incident = view.incidents.find((incident) => incident.id === state.incidentId);
          if (!incident) throw new Error("The exact owned incident disappeared");
          const snapshot = JSON.stringify({
            incident: incident.state,
            reason: incident.reason,
            ticket: incident.ticketId,
          });
          if (snapshot !== previous) {
            previous = snapshot;
            console.info(`Monitoring native: ${snapshot}`);
            await writeFile(resolve(directory, "latest.json"), snapshot, { mode: 0o600 });
          }
          if (
            ["blocked", "uncertain", "insufficient-context", "not-application-defect"].includes(
              incident.state,
            )
          )
            throw new Error(
              `Owned Autofix ended ${incident.state}: ${incident.reason ?? "No reason"}`,
            );
          await Bun.sleep(1500);
          return incident;
        },
        (incident) => incident.state === "delivered",
        "Owned monitoring did not complete native Delivery",
        3_300_000,
      );
      expect(delivered?.occurrences).toBe(8);
      const [change] = await database.client<
        { id: string }[]
      >`SELECT id FROM factory.change WHERE ticket_id=${delivered.ticketId}`;
      if (!change) throw new Error("The delivered Change is missing");
      const delivery = deliveryViewSchema.parse(
        await serverCall(
          callFactoryFunction(factory.base, "getDelivery", [change.id], { cookie: adminCookie }),
        ),
      );
      expect(delivery.verificationState).toBe("succeeded");
      expect(delivery.reviewState).toBe("passed");
      if (!delivery.verificationCommitSha || !delivery.reviewId)
        throw new Error("Delivery has no exact Verification or independent review");
      const [approval] = await database.client<
        { incident: string; policy: string; review: string; sha: string; actor: string }[]
      >`
        SELECT monitoring_incident_id AS incident,monitoring_policy_id AS policy,
          candidate_review_id AS review,commit_sha AS sha,approved_by AS actor
        FROM factory.delivery_approval WHERE change_id=${change.id}`;
      expect(approval).toMatchObject({
        incident: state.incidentId,
        actor: state.managerId,
        sha: delivery.verificationCommitSha,
        review: delivery.reviewId,
      });
      const [requirements] = await database.client<{ incident: string; policy: string }[]>`
        SELECT monitoring_incident_id AS incident,monitoring_policy_id AS policy FROM factory.requirement_approval WHERE ticket_id=${delivered.ticketId}`;
      expect(requirements).toEqual({
        incident: state.incidentId,
        policy: fixtureValue(approval, "approval").policy,
      });
      const branch = await forge.getDefaultBranch(repository);
      expect(branch.name).toBe("release");
      expect(branch.headSha).toBe(delivery.verificationCommitSha);
      const base = JSON.parse(await readFile(resolve(directory, "base.json"), "utf8"));
      expect((await forge.getBranch(repository, "main"))?.headSha).toBe(base.sha);
      const before = new Map(
        (await forge.listFiles(repository, base.sha)).map((file) => [file.path, file.sha]),
      );
      const after = await forge.listFiles(repository, branch.headSha);
      const changed = after
        .filter((file) => file.sha !== before.get(file.path))
        .map((file) => file.path);
      expect(changed).toContain("src/invoice.mjs");
      expect(changed.some((path) => /\.(test|spec)\.[cm]?js$/.test(path))).toBe(true);
      for (const path of [
        "AGENTS.md",
        "package.json",
        ".factory/system.json",
        ".forgejo/workflows/factory-verification.yml",
        ".devcontainer/devcontainer.json",
        ".devcontainer/compose.yaml",
        "src/server.mjs",
      ])
        expect(after.find((file) => file.path === path)?.sha).toBe(before.get(path));
      const [preview] = await database.client<{ id: string; sha: string; state: string }[]>`
        SELECT attempt.id,preview.revision AS sha,attempt.state FROM factory.staging_preview preview
          JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id WHERE preview.project_id=${state.projectId}`;
      expect(preview).toMatchObject({ sha: branch.headSha, state: "ready" });
      const missing = await app(fixtureValue(preview, "preview").id, "/invoices/missing");
      const known = await app(fixtureValue(preview, "preview").id, "/invoices/known");
      expect(missing).toEqual({ status: 404, body: { total: null } });
      expect(known).toEqual({ status: 200, body: { total: 12 } });
      const reviews = await database.client<{ id: string; sourceCount: number }[]>`
        SELECT review.id,(SELECT count(*)::int FROM factory.agent_turn_mcp source WHERE source.turn_id=review.turn_id) AS "sourceCount"
        FROM factory.candidate_review review WHERE review.change_id=${change.id}`;
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews.every((review) => review.sourceCount === 0)).toBe(true);
      const [count] = await database.client<{ tickets: number; changes: number }[]>`
        SELECT (SELECT count(*)::int FROM factory.ticket WHERE project_id=${state.projectId}) AS tickets,
          (SELECT count(*)::int FROM factory.change WHERE project_id=${state.projectId}) AS changes`;
      expect(count).toEqual({ tickets: 1, changes: 1 });
      await writeFile(
        resolve(directory, "result.json"),
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            boundary:
              "Synthetic authenticated monitoring provider only. Production Factory composition, official MCP SDK, OpenBao, configured real Planning/Coding models, owned Forgejo, pinned Envbox runtimes, real Verification/review/merge/promotion.",
            projectId: state.projectId,
            incidentId: state.incidentId,
            changeId: change.id,
            codingModel,
            planningModel,
            branch: branch.name,
            sha: branch.headSha,
            approval,
            requirements,
            changed,
            missing,
            known,
            reviews,
            count,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      succeeded = true;
    } finally {
      if (!succeeded) {
        console.info(JSON.stringify({ retainedMonitoringProof: stateFile }));
        await database.client.end({ timeout: 2 });
        await factory.pause();
      } else {
        for (const attempt of await database.client<
          { id: string; state: string }[]
        >`SELECT id,state FROM factory.runtime_attempt WHERE project_id=${fixtureValue(state.projectId, "state.projectId")}`) {
          if (attempt.state === "stopped") continue;
          await serverCall(
            callFactoryFunction(
              factory.base,
              "stopRuntimeAttempt",
              [attempt.id],
              { cookie: adminCookie, origin: factory.base, "content-type": "application/json" },
              AbortSignal.timeout(180_000),
            ),
          );
          await eventually(
            async () =>
              (
                await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id}`
              )[0]?.["state"],
            (state) => state === "stopped",
            "Owned monitoring runtime cleanup did not finish",
            180_000,
          );
        }
        const sources = createWorkspaceSourceController(
          database,
          "owned-process-auth-secret-not-a-production-credential",
        );
        try {
          await removeOwnedProjectSources(
            database,
            fixtureValue(state.projectId, "state.projectId"),
            async (id) => {
              const [workspace] = await database.client<
                { owner: string | null; createdBy: string }[]
              >`
              SELECT workspace.owner_user_id AS owner,project.created_by AS "createdBy"
              FROM factory.development_workspace workspace JOIN factory.project project ON project.id=workspace.project_id WHERE workspace.id=${id} AND workspace.project_id=${fixtureValue(state.projectId, "state.projectId")}`;
              if (!workspace) throw new Error("Owned monitoring source identity disappeared");
              return sources.stop(id, workspace.owner ?? workspace.createdBy);
            },
          );
        } finally {
          await sources.close();
        }
        await database.client.end();
        await factory.dispose();
        await bao.dispose();
        await rm(bao.directory, { recursive: true });
        await forgeHost.dispose();
        await unlink(webhookFile);
        await unlink(sourceFile);
        await writeFile(
          resolve(directory, "cleanup.json"),
          JSON.stringify(
            {
              runtimes: "stopped",
              source: "removed with exact ownership",
              factory: "removed",
              openbao: "removed",
              forgejo: "removed",
            },
            null,
            2,
          ),
        );
        state.complete = true;
        await save();
      }
    }
  },
  3_600_000,
);
