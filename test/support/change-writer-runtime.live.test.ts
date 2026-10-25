import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as visible } from "@playwright/test";
import { z } from "zod";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createForgejoAccess, forgeUsername } from "../../packages/forge/src/access";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import {
  editorFixtureKubectl,
  editorFixtureNamespaces,
  recordedEditorIdentity,
  removeOwnedProjectSources,
  removeStoppedEditorSourceNamespace,
} from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";
import { ownedRuntimeTerminal } from "../fixtures/runtime-access";
import { callFactoryFunction, factoryFunctionRequest } from "../fixtures/server-functions";

const nativeProofTimeout = 900_000;

test.skipIf(process.env["FACTORY_RUN_CHANGE_WRITER_RUNTIME_PROOF"] !== "1")(
  "real Ticket compute takeover removes detached writers while Theia and canonical files stay available",
  async () => {
    const id = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/server-functions/writer-runtime", id);
    await mkdir(artifacts, { recursive: true });
    const before = await editorFixtureNamespaces();
    const forgeHost = await ownedMonitoringForge(artifacts, id);
    const repository = { owner: forgeHost.owner, name: `writer-live-${id.slice(0, 12)}` };
    const token = forgeHost.token;
    const apiURL = `${forgeHost.origin}/api/v1/`;
    const forge = createForgejoClient({ apiURL, token });
    const protection = createForgejoAccess({ apiURL, token });
    const image = async (name: string) => (await readFile(`.factory/${name}-image`, "utf8")).trim();
    const owned = await factoryProcess(
      { runtimeHostImage: await image("runtime-host"), forgejoToken: token },
      {
        FACTORY_FORGEJO_ADMIN_TOKEN: token,
        FACTORY_FORGEJO_API_URL: apiURL,
        FACTORY_FORGEJO_OWNER: forgeHost.owner,
      },
    ).catch(async (cause) => {
      await forgeHost.dispose();
      throw cause;
    });
    await writeFile(
      resolve(artifacts, "intent.json"),
      JSON.stringify({
        projectID: id,
        factoryID: owned.id,
        factoryOrigin: owned.base,
        forgeContainer: forgeHost.container,
        forgeOrigin: forgeHost.origin,
      }),
      { mode: 0o600 },
    );
    const database = owned.connect();
    const browser = await chromium.launch({ headless: true });
    let cookie = "";
    let userID = "";
    let workspaceID = "";
    let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
    let currentAttempt = "";
    let repoCreated = false;
    let editorCreated = false;
    let nativeUserCreated = false;
    let cleanupFailure: { cause: unknown } | undefined;
    async function nativeUser(action: "create" | "delete") {
      const args = [
        "admin",
        "user",
        action,
        "--username",
        forgeUsername(userID),
        ...(action === "create"
          ? [
              "--random-password",
              "--email",
              `${id}@writer-proof.invalid`,
              "--must-change-password=false",
            ]
          : []),
      ];
      await forgeHost.execute(args);
    }
    const api = (path: string, body?: unknown) =>
      fetch(`${owned.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: owned.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    const attempt = async (attemptID: string) => {
      const { attempts } = z
        .object({ attempts: z.array(runtimeAttemptSchema) })
        .parse(
          await serverCall(
            callFactoryFunction(
              owned.base,
              "getRuntimeAttempts",
              [id],
              { cookie, origin: owned.base, "content-type": "application/json" },
              AbortSignal.timeout(60_000),
            ),
          ),
        );
      const value = attempts.find((item) => item.id === attemptID);
      if (!value) throw new Error("Owned runtime missing");
      return value;
    };
    const ready = (attemptID: string) =>
      eventually(
        async () => {
          const value = await attempt(attemptID);
          if (["failed", "cleanup-failed"].includes(value.state))
            throw new Error(`Owned runtime failed: ${value.failure}`);
          return value;
        },
        (value) => value.state === "ready",
        "Owned Ticket compute did not start",
        nativeProofTimeout,
      );
    try {
      await owned.start();
      console.info("Ticket writer proof: owned Factory ready");
      cookie = await owned.signIn();
      const email = `writer-${id}@factory.invalid`;
      const password = "owned-writer-password-not-a-secret";
      const account = await serverCall(
        callFactoryFunction(
          owned.base,
          "createAccount",
          [
            {
              name: "Ticket writer Developer",
              email,
              password,
            },
          ],
          { cookie },
        ),
      );
      userID = z.object({ id: z.uuid() }).parse(account).id;
      const signedIn = await api("/api/auth/sign-in/email", { email, password });
      cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      await nativeUser("create");
      nativeUserCreated = true;
      await forge.createSetupRepository({ repository, setupID: id });
      repoCreated = true;
      const tracked = Bun.spawn(["git", "ls-files"], {
        cwd: resolve(".factory/runtime-fixture-repository"),
        stdout: "pipe",
        stderr: "ignore",
      });
      const paths = (await new Response(tracked.stdout).text()).trim().split("\n");
      if ((await tracked.exited) || !paths.includes(".devcontainer/devcontainer.json"))
        throw new Error("Owned runtime fixture is incomplete");
      await forge.createSetupFiles({
        repository,
        setupID: id,
        branch: "main",
        files: await Promise.all(
          paths.map(async (path) => ({
            path,
            content: await readFile(resolve(".factory/runtime-fixture-repository", path), "utf8"),
          })),
        ),
      });
      const head = await forge.getDefaultBranch(repository);
      await protection.repositoryGrant(repository.owner, repository.name, userID, true);
      const ticketID = crypto.randomUUID();
      const revisionID = crypto.randomUUID();
      const approvalID = crypto.randomUUID();
      const identity = changeIdentity(ticketID, approvalID);
      const canonical = canonicalRequirementContent({
        summary: "Runtime handoff proof",
        acceptanceCriteria: ["Retain files while replacing compute"],
        nonGoals: [],
      });
      await database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${id},${repository.name},'Ticket handoff proof',${`${forgeHost.origin}/${repository.owner}/${repository.name}.git`},'main','.devcontainer/devcontainer.json',${userID})`;
        await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${id},${userID},'developer',${userID})`;
        await sql`INSERT INTO factory.ticket(id,project_id,title,created_by) VALUES(${ticketID},${id},'Retained Ticket editing',${userID})`;
        await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revisionID},${ticketID},1,${canonical},${createHash("sha256").update(canonical).digest("hex")},${userID})`;
        await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
        await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${identity.changeID},${id},${ticketID},${approvalID},${identity.branchName},${head.headSha},'active',${userID})`;
        await sql`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at) VALUES(${identity.branchOperationID},${identity.changeID},${repository.owner},${repository.name},${identity.branchName},${head.headSha},${`change:${identity.changeID}:create-branch`},'succeeded',${head.headSha},now())`;
      });
      // No paid inference. This fixture installs the already confirmed Agent state.
      await protection.protectBranch({
        owner: repository.owner,
        repository: repository.name,
        branch: identity.branchName,
        writers: [repository.owner],
        merger: repository.owner,
      });
      await forge.ensureBranch(repository, identity.branchName, head.headSha);
      await protection.protectBranch({
        owner: repository.owner,
        repository: repository.name,
        branch: identity.branchName,
        writers: [],
        merger: repository.owner,
      });
      // The user's independent IDE can warm while source and compute start.
      // Admission remains explicit and happens only once in this proof.
      await serverCall(callFactoryFunction(owned.base, "ensureDeveloperIDE", [id], { cookie }));
      editorCreated = true;
      const source = await serverCall(
        callFactoryFunction(owned.base, "ensureChangeSource", [identity.changeID], { cookie }),
      );
      workspaceID = source.workspaceID;
      console.info("Ticket writer proof: source preparation admitted");
      await eventually(
        async () => {
          const view = await serverCall(
            callFactoryFunction(owned.base, "getWorkspaceSource", [workspaceID], { cookie }),
          );
          if (view.state === "failed") throw new Error("Owned source preparation failed");
          return view;
        },
        (value) => value.state === "ready",
        "Owned source not ready",
        // The proof already has one outer deadline. A shorter observation
        // window must not destroy and recreate a still-pending admission.
        nativeProofTimeout,
      );
      console.info("Ticket writer proof: canonical source ready");
      const currentWriter = await serverCall(
        callFactoryFunction(owned.base, "getChangeWriterStatus", [identity.changeID], { cookie }),
      );
      await serverCall(
        callFactoryFunction(
          owned.base,
          "takeOverChangeEditing",
          [identity.changeID, { commandID: crypto.randomUUID(), epoch: currentWriter.epoch }],
          { cookie },
        ),
      );
      const first = runtimeAttemptSchema.parse(
        await serverCall(
          callFactoryFunction(
            owned.base,
            "startTicketWorkspace",
            [identity.changeID],
            { cookie, origin: owned.base, "content-type": "application/json" },
            AbortSignal.timeout(60_000),
          ),
        ),
      );
      currentAttempt = first.id;
      await ready(first.id);
      console.info("Ticket writer proof: initial compute ready");
      terminal = await ownedRuntimeTerminal(owned.base, cookie, first.id);
      expect(
        await terminal.evaluate<boolean>(
          `const fs=require("fs");fs.writeFileSync("human-retained.txt","retained-before-takeover");fs.mkdirSync(".opencode",{recursive:true});fs.writeFileSync(".opencode/retained-proof.txt","retained-agent-data");fs.writeFileSync("/workspace/data/handoff-proof.txt","retained-development-data");const child=require("child_process").spawn(process.execPath,["-e",'setInterval(()=>require("fs").appendFileSync("detached-writes.txt","x"),100)'],{detached:true,stdio:"ignore"});child.unref();return true;`,
        ),
      ).toBe(true);
      await eventually(
        async () => {
          const response = await api(`/api/workspaces/${workspaceID}/source/read`, {
            path: "detached-writes.txt",
          });
          // The detached timer has not necessarily performed its first write yet.
          if (response.status === 404) return "";
          if (!response.ok) throw new Error(`Owned detached file read HTTP ${response.status}`);
          return z.object({ content: z.string() }).parse(await response.json()).content;
        },
        (value) => Buffer.from(value, "base64").length >= 3,
        "Detached process did not write",
      );
      await database.client`UPDATE factory.change_writer SET state='agent',epoch=epoch+1,user_id=NULL,turn_id=${crypto.randomUUID()} WHERE change_id=${identity.changeID}`;
      await database.client`INSERT INTO factory.change_agent_session(change_id,runtime_attempt_id,opencode_session_id,state,created_by) VALUES(${identity.changeID},${first.id},${`ses_owned_${id.replaceAll("-", "")}`},'stopped',${userID})`;
      expect(
        (
          await api(`/api/workspaces/${workspaceID}/source/write`, {
            path: "denied.txt",
            content: Buffer.from("denied").toString("base64"),
          })
        ).status,
      ).toBe(409);
      await expect(terminal.evaluate("return true")).rejects.toThrow();
      terminal.close();
      terminal = undefined;
      await eventually(
        () => serverCall(callFactoryFunction(owned.base, "getDeveloperIDE", [], { cookie })),
        (value) => value.state === "ready",
        "Owned Theia not ready",
        nativeProofTimeout,
      );
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addCookies(
        cookie.split("; ").map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: owned.base,
        })),
      );
      const page = await context.newPage();
      await page.goto(`${owned.base}/api/developer-ide/access?workspace=${workspaceID}`);
      const writerStatus = page.locator(".factory-writer-status");
      await visible(writerStatus).toContainText("Agent working.");
      await visible(writerStatus).toContainText("Observation mode.");
      await visible(
        page.getByRole("button", { name: "Take over editing", exact: true }),
      ).toBeVisible();
      await visible(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
      await visible(page.getByRole("button", { name: "Restart", exact: true })).toBeDisabled();
      await page.screenshot({
        path: resolve(artifacts, "ticket-observation-desktop.png"),
      });
      await page.setViewportSize({ width: 900, height: 760 });
      await page.screenshot({
        path: resolve(artifacts, "ticket-observation-narrow.png"),
      });
      const documentID = await page.evaluate(() => performance.timeOrigin);
      const observedWriter = await serverCall(
        callFactoryFunction(owned.base, "getChangeWriterStatus", [identity.changeID], { cookie }),
      );
      const takeoverID = crypto.randomUUID();
      const cancellation = new AbortController();
      const takeoverResponse = fetch(
        await factoryFunctionRequest(
          owned.base,
          "takeOverChangeEditing",
          [identity.changeID, { commandID: takeoverID, epoch: observedWriter.epoch }],
          { cookie },
          cancellation.signal,
        ),
      );
      void takeoverResponse.catch(() => undefined);
      const intended = await eventually(
        async () => {
          const [row] = await database.client<{ state: string }[]>`
            SELECT writer.state FROM factory.change_writer writer
            JOIN factory.change_editing_decision decision ON decision.change_id=writer.change_id
            WHERE writer.change_id=${identity.changeID} AND decision.command_id=${takeoverID}
              AND decision.actor_id=${userID} AND decision.writer_epoch=${observedWriter.epoch}`;
          return row;
        },
        (value) => Boolean(value),
        "Native editing takeover did not persist its exact intent",
      );
      // Lose only the caller's response after durable admission. Never resend
      // the command or cancel the admitted source/process/branch transition.
      cancellation.abort();
      const lost = await takeoverResponse.catch(() => undefined);
      await lost?.body?.cancel().catch(() => {});
      await visible(page.locator(".factory-writer-status")).toBeHidden({ timeout: 60_000 });
      console.info("Ticket writer proof: native editing takeover confirmed");
      const confirmedWriter = await serverCall(
        callFactoryFunction(owned.base, "observeChangeWriter", [identity.changeID], { cookie }),
      );
      expect(confirmedWriter).toMatchObject({ state: "human", canWrite: true, yours: true });
      const [decisions] = await database.client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM factory.change_editing_decision
        WHERE change_id=${identity.changeID} AND command_id=${takeoverID}`;
      expect(decisions?.count).toBe(1);
      console.info(
        `Ticket writer proof: lost native response recovered from recorded ${intended?.state} without replay`,
      );
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentID);
      expect((await attempt(first.id)).state).toBe("stopped");
      const read = async (path: string) =>
        z
          .object({ content: z.string(), version: z.string() })
          .parse(await (await api(`/api/workspaces/${workspaceID}/source/read`, { path })).json());
      const stoppedWrites = (await read("detached-writes.txt")).version;
      await Bun.sleep(350);
      expect((await read("detached-writes.txt")).version).toBe(stoppedWrites);
      expect(Buffer.from((await read("human-retained.txt")).content, "base64").toString()).toBe(
        "retained-before-takeover",
      );
      expect(
        (
          await api(`/api/workspaces/${workspaceID}/source/write`, {
            path: "after-takeover.txt",
            content: Buffer.from("human-after-takeover").toString("base64"),
          })
        ).ok,
      ).toBe(true);
      await owned.shutdown();
      await owned.start();
      console.info("Ticket writer proof: owned Factory restarted");
      expect(
        (
          await callFactoryFunction(owned.base, "observeChangeWriter", [identity.changeID], {
            cookie,
          })
        ).ok,
      ).toBe(true);
      const second = runtimeAttemptSchema.parse(
        await serverCall(
          callFactoryFunction(
            owned.base,
            "startTicketWorkspace",
            [identity.changeID],
            { cookie, origin: owned.base, "content-type": "application/json" },
            AbortSignal.timeout(60_000),
          ),
        ),
      );
      currentAttempt = second.id;
      console.info("Ticket writer proof: replacement compute admitted");
      expect(second.id).not.toBe(first.id);
      await ready(second.id);
      console.info("Ticket writer proof: replacement compute ready");
      terminal = await ownedRuntimeTerminal(owned.base, cookie, second.id);
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync("after-takeover.txt","utf8")',
        ),
      ).toBe("human-after-takeover");
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync(".opencode/retained-proof.txt","utf8")',
        ),
      ).toBe("retained-agent-data");
      expect(
        await terminal.evaluate<string>(
          'return require("fs").readFileSync("/workspace/data/handoff-proof.txt","utf8")',
        ),
      ).toBe("retained-development-data");
    } catch (cause) {
      for (const [index, page] of browser
        .contexts()
        .flatMap((context) => context.pages())
        .entries()) {
        if (page.isClosed()) continue;
        await page
          .screenshot({
            path: resolve(artifacts, `failure-browser-${index}.png`),
          })
          .catch(() => {});
        const visibleText = await page
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "");
        await writeFile(
          resolve(artifacts, `failure-browser-${index}.txt`),
          visibleText.slice(0, 32_000),
          { mode: 0o600 },
        );
      }
      const current = currentAttempt ? await attempt(currentAttempt).catch(() => null) : null;
      const [resource] = currentAttempt
        ? await database.client<
            { namespace: string; pod: string; uid: string | null; image: string }[]
          >`SELECT attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS pod,
              attempt.kubernetes_uid AS uid,artifact.runtime_host_image AS image
            FROM factory.runtime_attempt attempt
            JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
            WHERE attempt.id=${currentAttempt} AND attempt.project_id=${id}`
        : [];
      let timings: unknown[] = [];
      if (resource?.uid) {
        const observedUID = await editorFixtureKubectl([
          "get",
          "pod",
          resource.pod,
          "-n",
          resource.namespace,
          "--ignore-not-found",
          "-o",
          "jsonpath={.metadata.uid}",
        ]).catch(() => "");
        if (observedUID === resource.uid) {
          // The pinned Connector writes only fixed phase names and clocks here,
          // never commands, assignments, provider data or credentials.
          const output = await editorFixtureKubectl([
            "exec",
            "-n",
            resource.namespace,
            resource.pod,
            "-c",
            "envbox",
            "--",
            "docker",
            "exec",
            "workspace_cvm",
            "cat",
            "/tmp/factory-startup-timings.jsonl",
          ]).catch(() => "");
          timings = output
            .split("\n")
            .filter((line) => line.startsWith("factory-startup "))
            .map((line) => JSON.parse(line.slice("factory-startup ".length)));
        }
      }
      await writeFile(
        resolve(artifacts, "failure-state.json"),
        JSON.stringify({
          projectID: id,
          workspaceID,
          runtimeAttemptID: currentAttempt,
          current,
          resource,
          timings,
        }),
        { mode: 0o600 },
      );
      throw cause;
    } finally {
      console.info("Ticket writer proof: cleaning owned resources");
      try {
        terminal?.close();
        await browser.close();
        if (currentAttempt) {
          await serverCall(
            callFactoryFunction(
              owned.base,
              "stopRuntimeAttempt",
              [currentAttempt],
              { cookie },
              AbortSignal.timeout(60_000),
            ),
          );
          await eventually(
            () => attempt(currentAttempt),
            (value) => value.state === "stopped",
            "Owned final Stop incomplete",
            120_000,
          );
        }
        if (workspaceID)
          await removeOwnedProjectSources(database, id, (workspace) =>
            serverCall(
              callFactoryFunction(owned.base, "stopWorkspaceSource", [workspace], { cookie }),
            ),
          );
        if (editorCreated) {
          await serverCall(callFactoryFunction(owned.base, "stopDeveloperIDE", [], { cookie }));
          await eventually(
            async () =>
              (await serverCall(callFactoryFunction(owned.base, "getDeveloperIDE", [], { cookie })))
                .state,
            (state) => state === "stopped",
            "Owned IDE Stop incomplete",
            30_000,
          );
          const [editor] = await database.client<
            { uid: string }[]
          >`SELECT namespace_uid AS uid FROM factory.developer_ide WHERE user_id=${userID}`;
          const identity = await recordedEditorIdentity(database, userID);
          expect(identity).toBeDefined();
          if (identity)
            await removeStoppedEditorSourceNamespace(identity.namespace, {
              ownerID: userID,
              ...(editor?.uid ? { uid: editor.uid } : {}),
            });
        }
        if (repoCreated) {
          expect(await forge.setupRepository(repository, id)).not.toBeNull();
          expect(
            (
              await fetch(`${apiURL}repos/${repository.owner}/${repository.name}`, {
                method: "DELETE",
                headers: { authorization: `Bearer ${token}` },
              })
            ).ok,
          ).toBe(true);
        }
        if (nativeUserCreated) await nativeUser("delete");
        const remaining = await editorFixtureNamespaces();
        expect(
          before.filter(
            (namespace) =>
              !remaining.some(
                (current) => current.name === namespace.name && current.uid === namespace.uid,
              ),
          ),
        ).toEqual([]);
        await database.client.end({ timeout: 2 });
        await owned.dispose();
        await forgeHost.dispose();
      } catch (cause) {
        await writeFile(
          resolve(artifacts, "cleanup-unconfirmed.json"),
          JSON.stringify({
            projectID: id,
            factoryID: owned.id,
            factoryOrigin: owned.base,
            forgeContainer: forgeHost.container,
            forgeOrigin: forgeHost.origin,
            workspaceID,
            runtimeAttemptID: currentAttempt,
            editorUserID: userID,
          }),
          { mode: 0o600 },
        );
        // Retain admission, source and the owned Forge until positive teardown
        // evidence exists. A failed cleanup must not discard its recovery data.
        await owned.pause();
        await database.client.end({ timeout: 2 });
        cleanupFailure = { cause };
      }
    }
    if (cleanupFailure) throw cleanupFailure.cause;
  },
  nativeProofTimeout,
);
