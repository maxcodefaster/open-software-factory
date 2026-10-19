import { expect, test } from "bun:test";
import { chromium, expect as visible } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { createForgejoAccess, forgeUsername } from "../../packages/forge/src/access";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { changeIdentity } from "../../packages/change-domain/src/change";
import {
  developerIDEViewSchema,
  runtimeAttemptSchema,
  sourceWorkspaceViewSchema,
} from "../../apps/factory/src/api-contracts";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { ownedRuntimeTerminal } from "../fixtures/runtime-access";
import {
  editorFixtureNamespaces,
  recordedEditorIdentity,
  removeOwnedProjectSources,
  removeStoppedEditorSourceNamespace,
} from "../fixtures/editor-source-resources";

test.skipIf(process.env["FACTORY_RUN_CHANGE_WRITER_RUNTIME_PROOF"] !== "1")(
  "real Ticket compute takeover removes detached writers while Theia and canonical files stay available",
  async () => {
    const id = crypto.randomUUID();
    const repository = { owner: "factory-mutation", name: `writer-live-${id.slice(0, 12)}` };
    const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const apiURL = "http://127.0.0.1:33030/api/v1/";
    const forge = createForgejoClient({ apiURL, token });
    const protection = createForgejoAccess({ apiURL, token });
    const image = async (name: string) => (await readFile(`.factory/${name}-image`, "utf8")).trim();
    const owned = await factoryProcess(
      { runtimeHostImage: await image("runtime-host"), forgejoToken: token },
      {
        FACTORY_FORGEJO_ADMIN_TOKEN: token,
      },
    );
    const database = owned.connect();
    const browser = await chromium.launch({ headless: true });
    const before = await editorFixtureNamespaces();
    let cookie = "";
    let userID = "";
    let workspaceID = "";
    let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
    let currentAttempt = "";
    let repoCreated = false;
    let editorCreated = false;
    let nativeUserCreated = false;
    async function nativeUser(action: "create" | "delete") {
      const args = [
        "docker",
        "exec",
        "local-forgejo-1",
        "forgejo",
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
      const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      if (await child.exited) throw new Error(`Owned native writer ${action} failed`);
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
        .parse(await (await api(`/api/runtime-attempts?projectId=${id}`)).json());
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
        240_000,
      );
    try {
      await owned.start();
      console.info("Ticket writer proof: owned Factory ready");
      cookie = await owned.signIn();
      const email = `writer-${id}@factory.invalid`;
      const password = "owned-writer-password-not-a-secret";
      const account = await api("/api/admin/users", {
        name: "Ticket writer Developer",
        email,
        password,
      });
      userID = z.object({ id: z.uuid() }).parse(await account.json()).id;
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
        await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${id},${repository.name},'Ticket handoff proof',${`http://127.0.0.1:33030/${repository.owner}/${repository.name}.git`},'main','.devcontainer/devcontainer.json',${userID})`;
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
      const sourceResponse = await api(
        `/api/changes/${identity.changeID}/source-workspace/ensure`,
        {},
      );
      if (!sourceResponse.ok)
        throw new Error(
          `Owned source ensure HTTP ${sourceResponse.status}: ${JSON.stringify(await sourceResponse.json())}`,
        );
      const source = sourceWorkspaceViewSchema.parse(await sourceResponse.json());
      workspaceID = source.workspaceID;
      console.info("Ticket writer proof: source preparation admitted");
      await eventually(
        async () =>
          sourceWorkspaceViewSchema.parse(
            await (await api(`/api/workspaces/${workspaceID}/source`)).json(),
          ),
        (value) => value.state === "ready",
        "Owned source not ready",
        120_000,
      );
      console.info("Ticket writer proof: canonical source ready");
      const acquired = await api(`/api/changes/${identity.changeID}/writer`, {
        commandID: crypto.randomUUID(),
      });
      if (!acquired.ok)
        throw new Error(
          `Owned initial writer HTTP ${acquired.status}: ${JSON.stringify(await acquired.json())}`,
        );
      const first = runtimeAttemptSchema.parse(
        await (await api(`/api/changes/${identity.changeID}/ticket-workspace/ensure`, {})).json(),
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
      await api(`/api/projects/${id}/developer-ide/ensure`, {});
      editorCreated = true;
      await eventually(
        async () => developerIDEViewSchema.parse(await (await api("/api/developer-ide")).json()),
        (value) => value.state === "ready",
        "Owned Theia not ready",
        120_000,
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
      await visible(
        page.getByText("Observation mode. The Agent owns this implementation."),
      ).toBeVisible({ timeout: 30_000 });
      await visible(
        page.getByRole("button", { name: "Take over editing", exact: true }),
      ).toBeVisible();
      await visible(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
      await visible(page.getByRole("button", { name: "Restart", exact: true })).toBeDisabled();
      await mkdir(".factory/screenshots/enterprise-access", { recursive: true });
      await page.screenshot({
        path: ".factory/screenshots/enterprise-access/ticket-observation-desktop.png",
      });
      await page.setViewportSize({ width: 900, height: 760 });
      await page.screenshot({
        path: ".factory/screenshots/enterprise-access/ticket-observation-narrow.png",
      });
      const documentID = await page.evaluate(() => performance.timeOrigin);
      await page.getByRole("button", { name: "Take over editing", exact: true }).click();
      await visible(page.locator(".factory-writer-status")).toBeHidden({ timeout: 60_000 });
      console.info("Ticket writer proof: native editing takeover confirmed");
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
      expect((await api(`/api/changes/${identity.changeID}/writer`)).ok).toBe(true);
      const second = runtimeAttemptSchema.parse(
        await (await api(`/api/changes/${identity.changeID}/ticket-workspace/ensure`, {})).json(),
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
    } finally {
      console.info("Ticket writer proof: cleaning owned resources");
      terminal?.close();
      await browser.close();
      if (currentAttempt) {
        expect((await api(`/api/runtime-attempts/${currentAttempt}/stop`, {})).ok).toBe(true);
        await eventually(
          () => attempt(currentAttempt),
          (value) => value.state === "stopped",
          "Owned final Stop incomplete",
          120_000,
        );
      }
      if (workspaceID)
        await removeOwnedProjectSources(database, id, (workspace) =>
          api(`/api/workspaces/${workspace}/source/stop`, {}),
        );
      if (editorCreated) {
        await api("/api/developer-ide/stop", {});
        await eventually(
          async () =>
            developerIDEViewSchema.parse(await (await api("/api/developer-ide")).json()).state,
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
      await database.client.end({ timeout: 2 });
      await owned.dispose();
      const remaining = await editorFixtureNamespaces();
      // Other owned proofs may create resources concurrently. Only removal or
      // replacement of an existing namespace would violate this proof's boundary.
      expect(
        before.filter(
          (namespace) =>
            !remaining.some(
              (current) => current.name === namespace.name && current.uid === namespace.uid,
            ),
        ),
      ).toEqual([]);
    }
  },
  900_000,
);
