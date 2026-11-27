import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type BrowserContext, chromium, expect as visible } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { emergencyAdministratorID } from "#auth/policy";
import { createForgejoClient } from "#forge/forge";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { requirePublishedRuntimeArtifacts } from "../../scripts/factory/artifacts";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { proveLocalOpenCodeMCP } from "../fixtures/local-opencode-mcp";
import { ownedMCPAuthorization, ownedMCPAuthProvider } from "../fixtures/mcp-authorization";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";
import { requireNativeLiveHost } from "../fixtures/native-live-configuration";
import { readNativeWorkspaceObservation } from "../fixtures/native-workspace-observation";
import { openProjectMenu } from "../fixtures/project-menu";
import { configuredRuntimeProjectFiles } from "../fixtures/runtime-project";
import { callFactoryFunction } from "../fixtures/server-functions";
import { connectStarterNativeLifecycle } from "../fixtures/starter-native-lifecycle";

test(
  "local OAuth MCP clients and browser participants use one actual native Substrate Workspace",
  async () => {
    const nativeConfiguration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
    if (!nativeConfiguration)
      throw Error(
        "Explicit owned native configuration is required for the live external MCP proof",
      );
    const publicForgeOrigin = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
    if (!publicForgeOrigin) throw Error("Explicit native Forge HTTPS origin is required");
    requireNativeLiveHost();
    const files = await configuredRuntimeProjectFiles(nativeConfiguration);
    const retainedID = process.env["FACTORY_EXTERNAL_MCP_RETAINED_ID"];
    if (retainedID && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(retainedID))
      throw new Error("Invalid owned proof identity");
    const retained = retainedID
      ? (JSON.parse(
          await readFile(
            resolve(".factory/test-results/external-mcp/live", retainedID, "retained.json"),
            "utf8",
          ),
        ) as { id: string; factoryID: string; base: string; projectID: string })
      : undefined;
    if (retained && retained.id !== retainedID)
      throw new Error("Retained proof identity differs from its owned directory");
    const id = retained?.id ?? crypto.randomUUID();
    const runID = crypto.randomUUID();
    const artifactPath = `/workspace/project/external-mcp-${runID}.bin`,
      documentPath = `collaboration-${runID}.txt`;
    const directory = resolve(".factory/test-results/external-mcp/live", id);
    await mkdir(directory, { recursive: true });
    const runtimeHostImage = (await requirePublishedRuntimeArtifacts(".factory"))["runtime-host"];
    const forge = await ownedMonitoringForge(directory, id, undefined, publicForgeOrigin);
    const api = createForgejoClient({ apiURL: `${forge.origin}/api/v1/`, token: forge.token });
    const repository = { owner: forge.owner, name: `external-mcp-${id.slice(0, 8)}` };
    const fixture = await factoryProcess(
      { runtimeHostImage, forgejoToken: forge.token },
      {
        FACTORY_FORGEJO_API_URL: `${forge.origin}/api/v1/`,
        FACTORY_FORGEJO_PUBLIC_URL: publicForgeOrigin,
        FACTORY_FORGEJO_OWNER: forge.owner,
        FACTORY_REGISTRY_CA_FILE: process.env["FACTORY_REGISTRY_CA_FILE"],
        FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: nativeConfiguration,
      } as Parameters<typeof factoryProcess>[1],
      retained ? { id: retained.factoryID, base: retained.base } : undefined,
    ).catch(async (cause) => {
      if (!retained) await forge.dispose();
      throw cause;
    });
    const database = fixture.connect();
    const clients: Client[] = [];
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const actorCookies = new Map<string, string>();
    let success = false;
    let pauseConfirmed = false;
    let pauseRequestID: string | undefined;
    let selected: { workspaceID: string; attemptID: string; actorUID: string } | undefined;
    let workFailure: unknown;
    const projectID = retained?.projectID ?? crypto.randomUUID();
    const owner = emergencyAdministratorID;
    let guest = crypto.randomUUID() as string;
    const password = "owned-external-mcp-password";
    const connect = async (grant: Awaited<ReturnType<typeof ownedMCPAuthorization>>) => {
      const client = new Client({ name: "owned-live-factory-mcp", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${fixture.base}/api/mcp`), {
          authProvider: ownedMCPAuthProvider(grant),
        }),
      );
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const response = await client.callTool(
        { name, arguments: args },
        { timeout: nativeLifecycleWindowMS + 30_000 },
      );
      const part = response.content.find((part) => part.type === "text");
      if (part?.type !== "text") throw new Error(`No MCP result for ${name}`);
      const result = JSON.parse(part.text);
      if (response.isError) throw new Error(`${name}: ${result.error?.message ?? "unconfirmed"}`);
      return result;
    };
    async function cookies(context: BrowserContext, cookie: string) {
      await context.addCookies(
        cookie.split("; ").map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: fixture.base,
        })),
      );
    }
    async function fn<T>(
      name: "ensureDeveloperIDE" | "getDeveloperIDE" | "stopDeveloperIDE",
      args: [] | [string],
      cookie: string,
    ): Promise<T> {
      const result = await callFactoryFunction(fixture.base, name, args, { cookie });
      if (!result.ok) throw new Error(result.message);
      return result.value as unknown as T;
    }
    try {
      const existingRepository = await api.setupRepository(repository, id);
      if (!existingRepository) await api.createSetupRepository({ repository, setupID: id });
      if (!existingRepository || existingRepository.empty)
        await api.createSetupFiles({ repository, branch: "main", setupID: id, files });
      await fixture.startPlanningCache();
      await fixture.start();
      const ownerCookie = await fixture.signIn();
      actorCookies.set(owner, ownerCookie);
      if (retained) {
        const peers = await database.client<
          { id: string }[]
        >`SELECT person.id FROM factory.project_membership member JOIN auth."user" person ON person.id=member.user_id WHERE member.project_id=${projectID} AND person.name='Guest developer' AND person.email=person.id::text||'@factory.invalid'`;
        if (peers.length > 1) throw new Error("Owned proof actor identity is ambiguous");
        if (peers[0]) guest = peers[0].id;
      }
      await database.client`INSERT INTO auth."user"(id,name,email)VALUES(${guest},'Guest developer',${`${guest}@factory.invalid`}) ON CONFLICT(id) DO NOTHING`;
      const [credential] =
        await database.client`SELECT id FROM auth.account WHERE user_id=${guest} AND provider_id='credential'`;
      if (!credential)
        await database.client`INSERT INTO auth.account(id,user_id,account_id,provider_id,password)VALUES(${crypto.randomUUID()},${guest},${guest},'credential',${await hashPassword(password)})`;
      const nativeOrigin = publicForgeOrigin;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
       VALUES(${projectID},${repository.name},'External MCP live proof',${`${nativeOrigin}/${repository.owner}/${repository.name}.git`},'main','.factory/actor-template.json',${owner}) ON CONFLICT(id) DO NOTHING`;
      const [ownedProject] =
        await database.client`SELECT id FROM factory.project WHERE id=${projectID} AND slug=${repository.name} AND created_by=${owner} AND repository_url=${`${nativeOrigin}/${repository.owner}/${repository.name}.git`}`;
      if (!ownedProject) throw new Error("Owned proof Project identity differs");
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)VALUES(${projectID},${guest},'developer',${owner}) ON CONFLICT(project_id,user_id) DO NOTHING`;
      const login = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: fixture.base, "content-type": "application/json" },
        body: JSON.stringify({ email: `${guest}@factory.invalid`, password }),
      });
      expect(login.ok).toBe(true);
      const guestCookie = login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      actorCookies.set(guest, guestCookie);
      const ownerGrant = await ownedMCPAuthorization(fixture.base, ownerCookie),
        guestGrant = await ownedMCPAuthorization(fixture.base, guestCookie);
      let ownerClient = await connect(ownerGrant);
      const guestClient = await connect(guestGrant);
      const source = await call(ownerClient, "openWorkspace", { projectID });
      const workspaceID = String(source.workspaceID);
      console.log(`Owned native MCP proof ${id}: source ${workspaceID}`);
      await call(ownerClient, "startWorkspace", { workspaceID, requestID: crypto.randomUUID() });
      const startedWorkspace = await call(ownerClient, "getWorkspace", { workspaceID });
      const attemptID = z.uuid().parse(startedWorkspace.runtime.id);
      const originalActorUID = z.uuid().parse(startedWorkspace.runtime.native?.actorUID);
      selected = { workspaceID, attemptID, actorUID: originalActorUID };
      const native = await readNativeWorkspaceObservation(database, {
        attemptID,
        workspaceID,
        projectID,
        actorUID: originalActorUID,
      });
      const context = await call(ownerClient, "getContainerContext", { workspaceID });
      expect(context).toEqual({
        workspaceFolder: "/workspace/project",
        checkoutFolder: "/workspace/project",
        userID: 1000,
      });
      const commandID = crypto.randomUUID();
      const started = await call(ownerClient, "runCommand", {
        workspaceID,
        requestID: commandID,
        command: [
          "set -eu",
          "printf 'native-uid='; id -u",
          "printf 'native-node='; node --version",
          "printf 'native-git='; git --version",
          "printf 'native-workspace='; pwd -P",
          "printf 'native-checkout='; git rev-parse --show-toplevel",
          "printf 'native-head='; git rev-parse --verify HEAD",
          `printf 'native-package='; node -p "require('./package.json').name"`,
          `printf 'native-actor=%s\\n' "$(cat /run/ate/identity/uid)"`,
          "sleep 3",
          "printf 'detached-done\\n'",
        ].join("; "),
      });
      expect(started.attemptID).toBe(attemptID);
      await ownerClient.close();
      ownerClient = await connect(ownerGrant);
      await eventually(
        () => call(ownerClient, "getCommand", { commandID }),
        (value) => value.state === "exited",
        "Detached command did not finish",
        30_000,
      );
      const output = await call(ownerClient, "readCommandOutput", { commandID });
      expect(output.stdout).toMatch(/^native-uid=1000$/m);
      expect(output.stdout).toMatch(/^native-node=v\d+\.\d+\.\d+$/m);
      expect(output.stdout).toMatch(/^native-git=git version \d+\.\d+\.\d+/m);
      expect(output.stdout).toContain(`native-workspace=${context.workspaceFolder}\n`);
      expect(output.stdout).toContain(`native-checkout=${context.checkoutFolder}\n`);
      expect(output.stdout).toMatch(/^native-head=[a-f0-9]{40}$/m);
      expect(output.stdout).toContain("native-package=open-factory-runtime-fixture\n");
      expect(output.stdout).toContain(`native-actor=${originalActorUID}\n`);
      expect(output.stdout).toContain("detached-done");
      expect(output.exitCode).toBe(0);
      const currentWorkspace = await call(ownerClient, "getWorkspace", { workspaceID });
      expect(currentWorkspace.runtime).toMatchObject({
        id: attemptID,
        native: { actorUID: originalActorUID },
      });
      const terminalID = crypto.randomUUID();
      await call(ownerClient, "openTerminal", { workspaceID, requestID: terminalID });
      await call(ownerClient, "writeTerminal", {
        terminalID,
        requestID: crypto.randomUUID(),
        input: "P=retained; printf '__PTY_%s__\\n' \"$P\"\n",
      });
      await eventually(
        () => call(ownerClient, "readTerminal", { terminalID }),
        (value) => String(value.stdout).includes("__PTY_retained__"),
        "PTY state was not observed",
      );
      await call(ownerClient, "closeTerminal", { terminalID });
      const content = Buffer.alloc((3 << 20) + 17);
      for (let index = 0; index < content.length; index++) content[index] = index % 251;
      const checksum = createHash("sha256").update(content).digest("hex");
      const upload = await call(ownerClient, "beginFileTransfer", {
        requestID: crypto.randomUUID(),
        workspaceID,
        path: artifactPath,
        direction: "upload",
        bytes: content.length,
        sha256: checksum,
      });
      for (let offset = 0; offset < content.length; offset += upload.chunkBytes) {
        const sent = await fetch(`${upload.url}?offset=${offset}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${ownerGrant.accessToken}` },
          body: content.subarray(offset, offset + upload.chunkBytes),
        });
        expect(sent.ok).toBe(true);
      }
      expect(
        (await call(ownerClient, "commitFileTransfer", { transferID: upload.transferID })).state,
      ).toBe("committed");
      await call(ownerClient, "releaseFileTransfer", { transferID: upload.transferID });
      const download = await call(ownerClient, "beginFileTransfer", {
        requestID: crypto.randomUUID(),
        workspaceID,
        path: upload.path,
        direction: "download",
      });
      const hash = createHash("sha256");
      let offset = 0;
      for (;;) {
        const response = await fetch(`${download.url}?offset=${offset}`, {
          headers: { authorization: `Bearer ${ownerGrant.accessToken}` },
        });
        expect(response.ok).toBe(true);
        hash.update(new Uint8Array(await response.arrayBuffer()));
        offset = Number(response.headers.get("x-factory-next-offset"));
        if (response.headers.get("x-factory-complete") === "true") break;
      }
      expect(hash.digest("hex")).toBe(checksum);
      await call(ownerClient, "releaseFileTransfer", { transferID: download.transferID });
      const [previousShare] = await database.client<
        { version: string }[]
      >`SELECT version::text FROM factory.workspace_share WHERE workspace_id=${workspaceID} AND user_id=${guest}`;
      const granted = await call(ownerClient, "shareWorkspace", {
        commandID: crypto.randomUUID(),
        workspaceID,
        userID: guest,
        permission: "collaborate",
        expectedVersion: Number(previousShare?.version ?? 0),
      });
      const guestView = await call(guestClient, "getWorkspace", { workspaceID });
      expect(guestView.runtime.id).toBe(attemptID);
      await call(ownerClient, "writeFile", {
        workspaceID,
        path: documentPath,
        content: "shared source\n",
      });
      browser = await chromium.launch({
        headless: true,
        ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
          ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
          : {}),
      });
      const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
        guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await cookies(ownerContext, ownerCookie);
      await cookies(guestContext, guestCookie);
      const localOpenCode = await proveLocalOpenCodeMCP({
        factoryURL: fixture.base,
        workspaceID,
        browser: ownerContext,
        evidenceDirectory: directory,
      });
      const localResult = await call(ownerClient, "getCommand", {
        commandID: localOpenCode.commandID,
      });
      expect(localResult.state).toBe("exited");
      expect(localResult.exitCode).toBe(0);
      expect(
        (await call(ownerClient, "readCommandOutput", { commandID: localOpenCode.commandID }))
          .stdout,
      ).toContain("local-opencode-native-proof");
      const ownerPage = await ownerContext.newPage(),
        guestPage = await guestContext.newPage();
      for (const [cookie, page] of [
        [ownerCookie, ownerPage],
        [guestCookie, guestPage],
      ] as const) {
        await fn("ensureDeveloperIDE", [projectID], cookie);
        await eventually(
          async () => {
            const editor = await fn<{ state: string; failure: string | null }>(
              "getDeveloperIDE",
              [],
              cookie,
            );
            if (editor.state === "failed")
              throw new Error(editor.failure ?? "Native editor failed");
            return editor;
          },
          (value) => value.state === "ready",
          "Native editor did not become ready",
          nativeLifecycleWindowMS,
        );
        await page.goto(`${fixture.base}/api/developer-ide/access?workspace=${workspaceID}`);
        await page.getByText(documentPath, { exact: true }).dblclick({ timeout: 60_000 });
        await visible(page.locator(".monaco-editor:visible .view-lines").first()).toContainText(
          "shared source",
          { timeout: 30_000 },
        );
        await visible(
          page.getByText(/shared saved source|shared unsaved edits/).first(),
        ).toBeVisible({ timeout: 30_000 });
      }
      const edit = async (page: typeof ownerPage, text: string) => {
        const editor = page.locator(".monaco-editor:visible").first();
        await editor.click();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.type(text);
      };
      await Promise.all([edit(ownerPage, "owner "), edit(guestPage, "guest ")]);
      for (const page of [ownerPage, guestPage]) {
        await visible(page.locator(".monaco-editor:visible .view-lines").first()).toContainText(
          "owner",
        );
        await visible(page.locator(".monaco-editor:visible .view-lines").first()).toContainText(
          "guest",
        );
      }
      await visible
        .poll(() => ownerPage.locator('[class*="yRemoteSelectionHead-"]').count())
        .toBeGreaterThan(0);
      await ownerPage.screenshot({ path: resolve(directory, "coediting-desktop.png") });
      await ownerPage.close();
      await edit(guestPage, "after-owner-disconnect ");
      await guestPage.keyboard.press("ControlOrMeta+s");
      await eventually(
        () => call(guestClient, "readFile", { workspaceID, path: documentPath }),
        (value) => String(value.content).includes("after-owner-disconnect"),
        "Shared Save after owner disconnect did not reach source",
      );
      const main = await ownerContext.newPage();
      await main.goto(fixture.base);
      await openProjectMenu(main);
      await main.getByRole("button").filter({ hasText: repository.name }).click();
      await main.getByRole("button", { name: "IDE", exact: true }).click();
      await main
        .getByRole("button", { name: "Share Workspace", exact: true })
        .click({ timeout: 60_000 });
      await visible(main.getByRole("dialog", { name: "Share Workspace" })).toBeVisible();
      await main.screenshot({ path: resolve(directory, "sharing-desktop.png") });
      await main.getByRole("button", { name: "Done", exact: true }).click();
      await main.setViewportSize({ width: 390, height: 844 });
      await main.getByRole("button", { name: "Share Workspace", exact: true }).click();
      await visible(main.getByRole("dialog", { name: "Share Workspace" })).toBeVisible();
      await main.screenshot({ path: resolve(directory, "sharing-narrow.png") });
      await main.getByRole("button", { name: "Done", exact: true }).click();
      const survivingCommandID = crypto.randomUUID();
      await call(guestClient, "runCommand", {
        workspaceID,
        requestID: survivingCommandID,
        command: "sleep 2; printf guest-work-after-kick",
      });
      await call(ownerClient, "shareWorkspace", {
        commandID: crypto.randomUUID(),
        workspaceID,
        userID: guest,
        permission: null,
        expectedVersion: granted.version,
      });
      const denied = await guestClient.callTool({
        name: "getWorkspace",
        arguments: { workspaceID },
      });
      expect(denied.isError).toBe(true);
      const current = await call(ownerClient, "getWorkspace", { workspaceID });
      expect(current.runtime.id).toBe(attemptID);
      expect(current.runtime.state).toBe("ready");
      await eventually(
        () => call(ownerClient, "getCommand", { commandID: survivingCommandID }),
        (value) => value.state === "exited",
        "Revocation cancelled admitted shared work",
      );
      expect(
        (await call(ownerClient, "readCommandOutput", { commandID: survivingCommandID })).stdout,
      ).toContain("guest-work-after-kick");
      const preview = await call(ownerClient, "getPreview", { workspaceID });
      const previewPage = await ownerContext.newPage();
      await previewPage.goto(preview.url);
      await visible(
        previewPage.getByRole("heading", { name: "Runtime fixture ready" }),
      ).toBeVisible();
      await browser.close();
      browser = undefined;
      await call(ownerClient, "pauseWorkspace", { workspaceID, requestID: crypto.randomUUID() });
      await eventually(
        () => call(ownerClient, "getWorkspace", { workspaceID }),
        (value) => value.runtime.state === "paused",
        "Pause did not settle",
        nativeLifecycleWindowMS,
      );
      const resumedID = crypto.randomUUID();
      await call(ownerClient, "runCommand", {
        workspaceID,
        requestID: resumedID,
        command: `printf resumed; test -f ${documentPath}`,
      });
      await eventually(
        () => call(ownerClient, "getCommand", { commandID: resumedID }),
        (value) => value.state === "exited",
        "Resumed command did not finish",
      );
      expect((await call(ownerClient, "getCommand", { commandID: resumedID })).exitCode).toBe(0);
      expect(
        (await call(ownerClient, "readCommandOutput", { commandID: resumedID })).stdout,
      ).toContain("resumed");
      expect((await call(ownerClient, "getWorkspace", { workspaceID })).runtime.id).toBe(attemptID);
      expect(
        (await call(ownerClient, "getWorkspace", { workspaceID })).runtime.native?.actorUID,
      ).toBe(originalActorUID);
      await writeFile(
        resolve(directory, "journey.json"),
        JSON.stringify(
          {
            id,
            projectID,
            workspaceID,
            attemptID,
            checksum,
            bytes: content.length,
            coediting: true,
            ownerDisconnect: true,
            kickPreservedCompute: true,
            pauseResume: true,
            localOpenCode,
            native,
            work: { context, commandID, stdout: output.stdout, exitCode: output.exitCode },
            scope: "journey-assertions-before-native-pause",
          },
          null,
          2,
        ),
      );
      success = true;
    } catch (cause) {
      workFailure = cause;
    }
    const cleanupFailures: unknown[] = [];
    const cleanup = async (action: () => unknown) => {
      try {
        await action();
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    };
    // Transport failures must not bypass successful-journey Pause or the
    // retained inventory receipt. Failed/unknown work is never implicitly cancelled.
    await cleanup(() => browser?.close());
    for (const client of clients) await cleanup(() => client.close());
    try {
      if (success) {
        if (!selected) throw new Error("Owned successful Workspace identity is missing");
        const { workspaceID, attemptID, actorUID } = selected;
        const ownerCookie = await fixture.signIn();
        for (const cookie of actorCookies.values()) await fn("stopDeveloperIDE", [], cookie);
        await eventually(
          async () => {
            const [row] = await database.client<
              { count: number }[]
            >`SELECT count(*)::int AS count FROM factory.operation
              WHERE kind='workspace.developer_ide' AND scope_type='user' AND scope_id IN (${owner},${guest}) AND state<>'stopped'`;
            return row?.count ?? -1;
          },
          (count) => count === 0,
          "Owned editor Stop was not confirmed",
          nativeLifecycleWindowMS,
        );
        const retainedOwnership = () => database.client`
          SELECT attempt.id AS "attemptID",attempt.generation::text AS generation,
            attempt.stop_intended_at AS "stopIntendedAt",
            attempt.actor_uid AS "actorUID",attempt.atespace,attempt.actor_name AS "actorName",
            attempt.delete_intended_at AS "deleteIntendedAt",attempt.deleted_at AS "deletedAt",
            source.writer_epoch::text AS "writerEpoch",to_jsonb(source) AS source,
            to_jsonb(workspace) AS workspace,to_jsonb(writer) AS writer
          FROM factory.runtime_attempt attempt
          JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
          JOIN factory.substrate_source source ON source.workspace_id=workspace.id
          LEFT JOIN factory.change_writer writer ON writer.change_id=workspace.change_id
          WHERE attempt.project_id=${projectID} AND workspace.id=${workspaceID} AND attempt.atespace IS NOT NULL
          ORDER BY attempt.generation`;
        const beforePause = await retainedOwnership();
        expect(beforePause).toHaveLength(1);
        expect(beforePause[0]).toMatchObject({
          attemptID,
          actorUID,
          stopIntendedAt: null,
          deleteIntendedAt: null,
          deletedAt: null,
          workspace: { id: workspaceID, project_id: projectID, owner_user_id: owner },
          source: { actor_uid: actorUID, owner: "actor", writable: true, checkpoint_id: null },
        });
        expect(beforePause[0]?.["writerEpoch"]).toMatch(/^[1-9][0-9]*$/);
        const lifecycle = await connectStarterNativeLifecycle(fixture.base, ownerCookie);
        try {
          pauseRequestID = crypto.randomUUID();
          await writeFile(
            resolve(directory, `cleanup-pause-${runID}.json`),
            JSON.stringify({ projectID, ...selected, requestID: pauseRequestID, beforePause }),
            { flag: "wx", mode: 0o600 },
          );
          expect(await lifecycle.pause(workspaceID, pauseRequestID)).toMatchObject({
            id: attemptID,
            projectId: projectID,
            workspaceId: workspaceID,
            native: { actorUID },
          });
          const paused = await eventually(
            () => lifecycle.workspace(workspaceID),
            (value) => value.runtime?.state === "paused",
            "Owned Workspace Pause was not confirmed",
            nativeLifecycleWindowMS,
          );
          expect(paused.runtime).toMatchObject({
            id: attemptID,
            projectId: projectID,
            workspaceId: workspaceID,
            state: "paused",
            native: { actorUID, state: "ACTOR_STATE_SUSPENDED" },
          });
          // Inspect retained metadata only: current file reads could wake the Actor.
          expect(await retainedOwnership()).toEqual(beforePause);
          pauseConfirmed = true;
        } finally {
          await lifecycle.close();
        }
        await writeFile(
          resolve(directory, "retained.json"),
          JSON.stringify(
            {
              id,
              factoryID: fixture.id,
              base: fixture.base,
              projectID,
              ...selected,
              pauseRequestID,
              computePaused: true,
              actorRetained: true,
              sourceRetained: true,
              writerRetained: true,
              editorsStopped: true,
              destructiveDisposal: false,
              nativeResourceInventoryRetained: true,
              ownedControlPlaneRetained: true,
              forgeContainer: forge.container,
              ownedForgeRetained: true,
            },
            null,
            2,
          ),
        );
      } else {
        await writeFile(
          resolve(directory, "retained.json"),
          JSON.stringify(
            {
              id,
              factoryID: fixture.id,
              base: fixture.base,
              projectID,
              forgeContainer: forge.container,
            },
            null,
            2,
          ),
        );
        console.log(`Owned failed native proof retained at ${directory}`);
      }
    } catch (cause) {
      cleanupFailures.push(cause);
    } finally {
      let controlPlanePaused = false;
      await cleanup(async () => {
        await fixture.pause();
        controlPlanePaused = true;
      });
      await cleanup(() => database.client.end({ timeout: 2 }));
      await cleanup(async () => {
        await writeFile(
          resolve(directory, `run-state-${runID}.json`),
          JSON.stringify({
            id,
            factoryID: fixture.id,
            base: fixture.base,
            projectID,
            forgeContainer: forge.container,
            journeyAssertionsPassed: success,
            pauseRequestID,
            pauseConfirmed,
            controlPlanePaused,
            cleanupConfirmed: cleanupFailures.length === 0,
            nativeResourceInventoryRetained: true,
            destructiveDisposal: false,
          }),
          { flag: "wx", mode: 0o600 },
        );
      });
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        [...(success ? [] : [workFailure]), ...cleanupFailures],
        "External MCP proof or owned native fixture shutdown failed",
      );
    if (!success) throw workFailure;
    if (success && pauseConfirmed)
      await writeFile(
        resolve(directory, `result-${runID}.json`),
        JSON.stringify({
          passed: true,
          journey: "journey.json",
          state: `run-state-${runID}.json`,
          nativeResourceInventoryRetained: true,
          fullFactoryE2E: false,
        }),
        { flag: "wx", mode: 0o600 },
      );
  },
  nativeLifecycleWindowMS * 6,
);
