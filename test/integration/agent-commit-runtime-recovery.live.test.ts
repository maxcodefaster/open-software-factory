import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../packages/requirement-domain/src/requirement";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { ownedRuntimeTerminal as terminal } from "../fixtures/runtime-access";
import { callFactoryFunction, conversationCommand } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const userID = "01994a7d-0000-7000-8000-000000000001";

function promptHistorySource(sessionID: string) {
  return `const response = await fetch(${JSON.stringify(`http://127.0.0.1:4096/api/session/${sessionID}/history?limit=100`)}); if (!response.ok) throw new Error(); const body = await response.json(); if (body.hasMore) throw new Error(); return body.data.filter(entry => entry.type === "session.next.prompted").map(entry => entry.data.messageID);`;
}

for (const boundary of ["lost commit acknowledgement", "running Build"] as const) {
  test.skipIf(process.env["FACTORY_LIVE_COMMIT_RECOVERY"] !== "1")(
    `actual model, Envbox and Connector recover ${boundary} after Factory SIGKILL`,
    async () => {
      for (const key of [
        "FACTORY_MODEL_BASE_URL",
        "FACTORY_MODEL_API_KEY",
        "FACTORY_AGENT_MODEL_ID",
      ]) {
        if (!process.env[key]) throw new Error(`Live gate requires ${key}`);
      }
      const selectedModel = process.env["FACTORY_LIVE_MODEL_ID"];
      const modelID = selectedModel ?? process.env["FACTORY_AGENT_MODEL_ID"];
      if (!modelID) throw new Error("Live gate requires a Build model");
      const runtimeHostImage = (await readFile(".factory/runtime-host-image", "utf8")).trim();
      const forgejoToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
      const processFixture = await factoryProcess({ runtimeHostImage, forgejoToken });
      const database = processFixture.connect();
      const forge = createForgejoClient({
        apiURL: "http://127.0.0.1:33030/api/v1/",
        token: forgejoToken,
      });
      const projectID = crypto.randomUUID();
      const ticketID = crypto.randomUUID();
      const revisionID = crypto.randomUUID();
      const approvalID = crypto.randomUUID();
      const identity = changeIdentity(ticketID, approvalID);
      const slug = `commit-runtime-${projectID.slice(0, 8)}`;
      const evidenceDirectory = `.factory/test-results/runtime-commit/${slug}`;
      await mkdir(evidenceDirectory, { recursive: true });
      const terminals: Awaited<ReturnType<typeof terminal>>[] = [];
      let cookie = "";
      let branchCreateIntended = false;
      let recoveredSHA: string | undefined;
      let baseSHA = "";
      let safeToDispose = false;
      async function command(path: string, body: unknown = {}) {
        const response = await fetch(`${processFixture.base}${path}`, {
          method: "POST",
          headers: { cookie, origin: processFixture.base, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok) throw new Error(`Owned command ${path} failed: ${response.status}`);
        return response;
      }
      async function attempt() {
        const rows = await database.client<{ id: string; state: string; failure: string | null }[]>`
        SELECT id, state, failure FROM factory.runtime_attempt WHERE project_id = ${projectID}
          AND change_id = ${identity.changeID} ORDER BY generation DESC LIMIT 1`;
        return rows[0];
      }
      async function ready() {
        return eventually(
          async () => {
            const row = await attempt();
            if (["failed", "cleanup-failed"].includes(row?.state ?? ""))
              throw new Error(`Owned runtime failed: ${row?.failure?.slice(0, 500)}`);
            return row;
          },
          (row) => row?.state === "ready",
          "Owned runtime did not become ready",
          300_000,
        );
      }
      try {
        const first = await processFixture.start();
        cookie = await processFixture.signIn();
        if (selectedModel) {
          const settingsResponse = await callFactoryFunction(
            processFixture.base,
            "saveModelSettings",
            [
              {
                version: 0,
                planningModelId: selectedModel,
                buildModelId: selectedModel,
              },
            ],
            { cookie },
          );
          expect(settingsResponse.ok).toBe(true);
        }
        const base = await forge.getDefaultBranch(repository);
        baseSHA = base.headSha;
        const content = canonicalRequirementContent({
          summary: `Set src/version.txt to ${slug}. Keep the existing application intact.`,
          acceptanceCriteria: [
            ...(boundary === "running Build"
              ? [
                  "First run node .git/factory-owned-check.cjs and wait for it to finish. Do not bypass or modify this check. Preserve manual-during.txt unchanged.",
                ]
              : []),
            `src/version.txt contains exactly ${slug} followed by a newline.`,
            "node --check src/server.mjs passes.",
          ],
          nonGoals: ["Change dependencies, runtime configuration, or other files."],
        });
        await database.client.begin(async (sql) => {
          await sql`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
          VALUES (${projectID}, ${slug}, 'Owned commit runtime recovery',
          'http://127.0.0.1:33030/factory-mutation/runtime-fixture.git', 'main', '.devcontainer/devcontainer.json', ${userID})`;
          await sql`INSERT INTO factory.ticket(id, project_id, title, state, created_by)
          VALUES (${ticketID}, ${projectID}, 'Owned commit runtime recovery', 'in-progress', ${userID})`;
          await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
          VALUES (${revisionID}, ${ticketID}, 1, ${content}, ${requirementDigest(content)}, ${userID})`;
          await sql`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by)
          VALUES (${approvalID}, ${ticketID}, ${revisionID}, ${userID})`;
          await sql`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
          VALUES (${identity.changeID}, ${projectID}, ${ticketID}, ${approvalID}, ${identity.branchName}, ${baseSHA}, 'active', ${userID})`;
          await sql`INSERT INTO factory.branch_create_operation(id, change_id, repository_owner, repository_name,
          branch_name, start_sha, idempotency_key, state, observed_head_sha, completed_at)
          VALUES (${identity.branchOperationID}, ${identity.changeID}, ${repository.owner}, ${repository.name},
          ${identity.branchName}, ${baseSHA}, ${`owned-runtime:${identity.changeID}`}, 'pending', NULL, NULL)`;
          await sql`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
          VALUES (${crypto.randomUUID()}, ${projectID}, ${ticketID}, 'build', ${userID})`;
        });
        if (selectedModel) {
          const commandID = crypto.randomUUID();
          await conversationCommand(
            processFixture.base,
            projectID,
            {
              commandId: commandID,
              text: "Answer in one sentence: do you have a checkout or implementation authority? Do not propose requirements.",
            },
            { cookie },
          );
          const [planning] = await database.client<Array<{ state: string; model: string }>>`
            SELECT state, authority->>'modelId' AS model FROM factory.agent_turn WHERE command_id = ${commandID}
          `;
          expect(planning?.state).toBe("completed");
          expect(planning?.model).toBe(selectedModel);
          await writeFile(
            `${evidenceDirectory}/model-selection.json`,
            `${JSON.stringify({ planningCommandID: commandID, planningModel: planning?.model, buildDefault: selectedModel }, null, 2)}\n`,
          );
        }
        expect(await forge.getBranch(repository, identity.branchName)).toBeNull();
        // The branch identity and external create intent above precede the external create.
        branchCreateIntended = true;
        const branch = await forge.ensureBranch(repository, identity.branchName, baseSHA);
        expect(branch.headSha).toBe(baseSHA);
        await database.client`UPDATE factory.branch_create_operation SET state = 'succeeded', observed_head_sha = ${baseSHA},
        completed_at = now() WHERE id = ${identity.branchOperationID}`;
        await serverCall(
          callFactoryFunction(
            processFixture.base,
            "startTicketWorkspace",
            [identity.changeID],
            { cookie, origin: processFixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          ),
        );
        const running = await ready();
        if (!running) throw new Error("Owned runtime missing");
        const before = await terminal(
          processFixture.base,
          cookie,
          running.id,
          "owned-commit-proof",
        );
        terminals.push(before);
        const [workspace] = await database.client<Array<{ id: string }>>`
          SELECT id FROM factory.development_workspace WHERE change_id=${identity.changeID}`;
        if (!workspace) throw new Error("Owned canonical Workspace missing");
        const sourceIdentity = async () => {
          const [source] = await database.client<
            Array<{
              state: string;
              epoch: number;
              podUID: string;
              namespaceUID: string;
              claimUID: string;
            }>
          >`SELECT state,access_epoch::float8 AS epoch,pod_uid AS "podUID",
            namespace_uid AS "namespaceUID",claim_uid AS "claimUID"
            FROM factory.workspace_source WHERE workspace_id=${workspace.id}`;
          return source;
        };
        const sourceBefore = await sourceIdentity();
        expect(sourceBefore?.state).toBe("ready");
        const sourceFile = z.object({ content: z.string(), version: z.string() });
        const readCanonicalVersion = async () =>
          sourceFile.parse(
            await (
              await command(`/api/workspaces/${workspace.id}/source/read`, {
                path: "src/version.txt",
              })
            ).json(),
          );
        const humanVersion = `human-before-agent-${slug}\n`;
        const originalVersion = await readCanonicalVersion();
        await command(`/api/workspaces/${workspace.id}/source/write`, {
          path: "src/version.txt",
          version: originalVersion.version,
          content: Buffer.from(humanVersion).toString("base64"),
        });
        expect(
          await before.evaluate<string>(
            'return require("node:fs").readFileSync("src/version.txt", "utf8");',
          ),
        ).toBe(humanVersion);
        // Only this owned fixture's .git hook is changed. No application code or upstream component is patched.
        const hook = [
          "#!/bin/sh",
          "set -eu",
          'git -c safe.directory="$PWD" rev-parse HEAD > .git/factory-owned-sha',
          'git -c safe.directory="$PWD" show -s --format=%P HEAD > .git/factory-owned-parent',
          'git -c safe.directory="$PWD" show -s --format=%B HEAD > .git/factory-owned-body',
          "printf 'owned staged edit\\n' > manual-index.txt",
          'git -c safe.directory="$PWD" add manual-index.txt',
          "printf 'owned unstaged edit\\n' > manual-later.txt",
          "touch .git/factory-owned-commit-held",
          ...(boundary === "lost commit acknowledgement" ? ["sleep 12"] : []),
          "",
        ].join("\n");
        await before.evaluate(
          `const fs = require("node:fs"); fs.writeFileSync(".git/hooks/post-commit", ${JSON.stringify(hook)}, { mode: 0o755 }); return true;`,
        );
        if (boundary === "running Build") {
          const check = `const fs = require("node:fs");
const witness = { pid: process.pid, startedAt: Date.now() };
fs.writeFileSync(".git/factory-owned-build-held", JSON.stringify(witness));
(async () => {
  const deadline = Date.now() + 180000;
  while (!fs.existsSync(".git/factory-owned-build-release")) {
    if (Date.now() > deadline) throw new Error("Owned check release timed out");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log("Owned recovery check passed");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
          await before.evaluate(
            `const fs = require("node:fs"); fs.writeFileSync(".git/factory-owned-check.cjs", ${JSON.stringify(check)}); fs.writeFileSync("manual-during.txt", "owned manual edit during Build\\n"); return true;`,
          );
        }
        const commandID = crypto.randomUUID();
        await serverCall(
          callFactoryFunction(
            processFixture.base,
            "startCoding",
            [identity.changeID, { commandId: commandID }],
            { cookie, origin: processFixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          ),
        );
        await serverCall(
          callFactoryFunction(
            processFixture.base,
            "startCoding",
            [identity.changeID, { commandId: commandID }],
            { cookie, origin: processFixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          ),
        );
        let inspection = before;
        if (boundary === "running Build") {
          const witnessSource =
            'const fs = require("node:fs"); if (!fs.existsSync(".git/factory-owned-build-held")) return null; const witness = JSON.parse(fs.readFileSync(".git/factory-owned-build-held", "utf8")); process.kill(witness.pid, 0); return { ...witness, manual: fs.readFileSync("manual-during.txt", "utf8"), index: require("node:crypto").createHash("sha256").update(fs.readFileSync(".git/index")).digest("hex") };';
          const witness = await eventually(
            () =>
              before.evaluate<{
                pid: number;
                startedAt: number;
                manual: string;
                index: string;
              } | null>(witnessSource),
            (value) => value !== null,
            "Actual Build did not reach its running check",
            300_000,
          );
          const sessions = await database.client<
            { sessionID: string; promptID: string; turnID: string; state: string }[]
          >`
          SELECT session.opencode_session_id AS "sessionID", session.active_inbox_id AS "promptID",
            session.active_turn_id AS "turnID", turn.state
          FROM factory.change_agent_session session JOIN factory.agent_turn turn ON turn.id = session.active_turn_id
          WHERE session.change_id = ${identity.changeID} AND turn.command_id = ${commandID}`;
          const admitted = sessions[0];
          expect(admitted?.state).toBe("running");
          expect(admitted?.sessionID).toBeString();
          expect(admitted?.promptID).toBeString();
          if (!admitted) throw new Error("Owned running admission missing");
          const prompted = await before.evaluate<string[]>(promptHistorySource(admitted.sessionID));
          expect(prompted).toEqual([admitted.promptID]);
          expect(
            await before.evaluate<boolean>(
              `const response = await fetch("http://127.0.0.1:4096/api/session/active"); if (!response.ok) throw new Error(); const body = await response.json(); return ${JSON.stringify(admitted.sessionID)} in body.data;`,
            ),
          ).toBe(true);
          expect(
            await database.client`SELECT id FROM factory.change_commit_operation WHERE change_id = ${identity.changeID}`,
          ).toHaveLength(0);
          await writeFile(
            `${evidenceDirectory}/running.json`,
            `${JSON.stringify({ boundary, projectID, changeID: identity.changeID, attemptID: running.id, runtimeHostImage, commandID, admitted, prompted, witness }, null, 2)}\n`,
          );
          await processFixture.kill(first);
          before.close();
          const restarted = await processFixture.start();
          expect(restarted.pid).not.toBe(first.pid);
          cookie = await processFixture.signIn();
          await ready();
          inspection = await terminal(
            processFixture.base,
            cookie,
            running.id,
            "owned-commit-proof",
          );
          terminals.push(inspection);
          expect(await inspection.evaluate<typeof witness>(witnessSource)).toEqual(witness);
          const recovered = await database.client<
            { sessionID: string; promptID: string; turnID: string; state: string }[]
          >`
          SELECT session.opencode_session_id AS "sessionID", session.active_inbox_id AS "promptID",
            session.active_turn_id AS "turnID", turn.state
          FROM factory.change_agent_session session JOIN factory.agent_turn turn ON turn.id = session.active_turn_id
          WHERE session.change_id = ${identity.changeID} AND turn.command_id = ${commandID}`;
          expect(recovered).toEqual(sessions);
          expect(
            await inspection.evaluate<string[]>(promptHistorySource(admitted.sessionID)),
          ).toEqual(prompted);
          await writeFile(
            `${evidenceDirectory}/running-recovered.json`,
            `${JSON.stringify({ recovered, witness, sameRuntime: (await attempt())?.id === running.id }, null, 2)}\n`,
          );
          await inspection.evaluate(
            'require("node:fs").writeFileSync(".git/factory-owned-build-release", "release\\n"); return true;',
          );
        }
        await eventually(
          () =>
            inspection.evaluate<boolean>(
              'return require("node:fs").existsSync(".git/factory-owned-commit-held");',
            ),
          Boolean,
          "Actual commit did not reach the held acknowledgement",
          300_000,
        );
        const files =
          'const fs = require("node:fs"); const read = path => fs.readFileSync(path, "utf8"); const indexDigest = () => require("node:crypto").createHash("sha256").update(fs.readFileSync(".git/index")).digest("hex");';
        const prepared = await inspection.evaluate<{
          sha: string;
          parent: string;
          body: string;
          index: string;
        }>(
          `${files} return { sha: read(".git/factory-owned-sha").trim(), parent: read(".git/factory-owned-parent").trim(), body: read(".git/factory-owned-body").trim(), index: indexDigest() };`,
        );
        recoveredSHA = prepared.sha;
        const operations = await database.client<
          { id: string; state: string; commitSHA: string | null }[]
        >`
        SELECT id, state, commit_sha AS "commitSHA" FROM factory.change_commit_operation WHERE change_id = ${identity.changeID}`;
        expect(operations).toHaveLength(1);
        if (boundary === "lost commit acknowledgement") {
          expect(operations[0]?.state).toBe("commit-intended");
          expect(operations[0]?.commitSHA).toBeNull();
        }
        expect(prepared.parent).toBe(baseSHA);
        expect(prepared.body).toContain(`Factory-Operation: ${operations[0]?.id}`);
        if (boundary === "lost commit acknowledgement")
          expect((await forge.getBranch(repository, identity.branchName))?.headSha).toBe(baseSHA);
        const sessions = await database.client<{ id: string }[]>`SELECT opencode_session_id AS id
        FROM factory.change_agent_session WHERE change_id = ${identity.changeID}`;
        const sessionID = sessions[0]?.id;
        if (!sessionID) throw new Error("Owned OpenCode Session missing");
        const historySource = promptHistorySource(sessionID);
        const historyBefore = await inspection.evaluate<string[]>(historySource);
        expect(historyBefore).toHaveLength(1);
        await writeFile(
          `${evidenceDirectory}/prepared.json`,
          `${JSON.stringify({ projectID, changeID: identity.changeID, attemptID: running.id, runtimeHostImage, commandID, prepared, operations, historyBefore }, null, 2)}\n`,
        );
        if (boundary === "lost commit acknowledgement") {
          await processFixture.kill(first);
          before.close();
          const restarted = await processFixture.start();
          expect(restarted.pid).not.toBe(first.pid);
          cookie = await processFixture.signIn();
          await ready();
          inspection = await terminal(
            processFixture.base,
            cookie,
            running.id,
            "owned-commit-proof",
          );
          terminals.push(inspection);
        }
        const after = inspection;
        const observed = await eventually(
          async () => {
            const rows = await database.client<{ state: string; commitSHA: string | null }[]>`
          SELECT state, commit_sha AS "commitSHA" FROM factory.change_commit_operation WHERE change_id = ${identity.changeID}`;
            return rows[0];
          },
          (row) => row?.state === "succeeded",
          "Native commit was not settled after Factory recovery",
          boundary === "running Build" ? 90_000 : 30_000,
        );
        expect(observed?.commitSHA).toBe(prepared.sha);
        expect((await forge.getBranch(repository, identity.branchName))?.headSha).toBe(
          prepared.sha,
        );
        const preserved = await after.evaluate<{
          sha: string;
          index: string;
          staged: string;
          manual: string;
          version: string;
        }>(
          `${files} const head = read(".git/HEAD").trim(); return { sha: head.startsWith("ref: ") ? read(".git/" + head.slice(5)).trim() : head, index: indexDigest(), staged: read("manual-index.txt"), manual: read("manual-later.txt"), version: read("src/version.txt") };`,
        );
        expect(preserved).toEqual({
          sha: prepared.sha,
          index: prepared.index,
          staged: "owned staged edit\n",
          manual: "owned unstaged edit\n",
          version: `${slug}\n`,
        });
        const commitResponse = await fetch(
          `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/git/commits/${prepared.sha}`,
          { headers: { authorization: `token ${forgejoToken}` } },
        );
        expect(commitResponse.ok).toBe(true);
        const remoteCommit = (await commitResponse.json()) as { parents: { sha: string }[] };
        expect(remoteCommit.parents.map((parent) => parent.sha)).toEqual([baseSHA]);
        expect(await after.evaluate<string[]>(historySource)).toEqual(historyBefore);
        const turns = await database.client<
          { state: string; model: string }[]
        >`SELECT state, authority->>'modelId' AS model
        FROM factory.agent_turn WHERE change_id = ${identity.changeID}`;
        expect(turns.map((turn) => ({ ...turn }))).toEqual([
          { state: "completed", model: modelID },
        ]);
        const sourceAfter = await eventually(
          sourceIdentity,
          (source) => source?.state === "ready",
          "Owned canonical source did not recover",
          60_000,
        );
        expect(sourceAfter).toEqual(sourceBefore);
        const canonicalVersion = await readCanonicalVersion();
        expect(Buffer.from(canonicalVersion.content, "base64").toString()).toBe(`${slug}\n`);
        await writeFile(
          `${evidenceDirectory}/recovered.json`,
          `${JSON.stringify({ observed, preserved, turns, historyBefore, sourceBefore, sourceAfter, canonicalAgentVersionConfirmed: true }, null, 2)}\n`,
        );
        if (process.env["FACTORY_LIVE_DELIVERY"] === "1") {
          const verification = await eventually(
            async () => {
              const [row] = await database.client<
                { id: string; state: string; sha: string; attemptID: string; revision: string }[]
              >`
              SELECT verification.id, verification.state, verification.commit_sha AS sha,
                attempt.id AS "attemptID", attempt.revision FROM factory.verification verification
              JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
              WHERE verification.change_id = ${identity.changeID} AND verification.commit_sha = ${prepared.sha}`;
              return row;
            },
            (row) => row?.state === "succeeded",
            "Exact recovered commit did not pass Verification",
            360_000,
          );
          if (!verification) throw new Error("Owned exact Verification missing");
          expect(verification?.sha).toBe(prepared.sha);
          expect(verification?.revision).toBe(prepared.sha);
          // Sequence native fixtures: the local node also hosts the user's retained runtimes.
          await eventually(
            async () => {
              const [row] = await database.client<Array<{ state: string }>>`
                SELECT state FROM factory.runtime_attempt WHERE id=${verification.attemptID}`;
              return row?.state;
            },
            (state) => state === "stopped",
            "Owned Verification cleanup did not finish",
            180_000,
          );
          await serverCall(
            callFactoryFunction(
              processFixture.base,
              "ensureStaging",
              [projectID],
              { cookie, origin: processFixture.base, "content-type": "application/json" },
              AbortSignal.timeout(180_000),
            ),
          );
          const staging = async () => {
            const [row] = await database.client<{ id: string; revision: string; state: string }[]>`
              SELECT attempt.id, preview.revision, attempt.state FROM factory.staging_preview preview
              JOIN factory.runtime_attempt attempt ON attempt.id = preview.runtime_attempt_id
              WHERE preview.project_id = ${projectID}`;
            return row;
          };
          const initial = await eventually(
            staging,
            (row) => row?.state === "ready",
            "Initial owned Staging not ready",
            300_000,
          );
          expect(initial?.revision).toBe(baseSHA);
          await serverCall(
            callFactoryFunction(processFixture.base, "approveDelivery", [identity.changeID], {
              cookie: cookie,
            }),
          );
          await eventually(
            async () => {
              const [row] = await database.client<
                { state: string }[]
              >`SELECT state FROM factory.change WHERE id = ${identity.changeID}`;
              return row?.state;
            },
            (state) => state === "delivered",
            "Owned approved Change not delivered",
            360_000,
          );
          const promoted = await staging();
          expect(promoted).toMatchObject({ state: "ready", revision: prepared.sha });
          expect(promoted?.id).not.toBe(initial?.id);
          expect((await forge.getDefaultBranch(repository)).headSha).toBe(prepared.sha);
          await eventually(
            async () => {
              const [promotion] = await database.client<
                Array<{ state: string; cleanupError: string | null }>
              >`SELECT state,last_error AS "cleanupError" FROM factory.promotion_operation
                WHERE change_id=${identity.changeID}`;
              return promotion;
            },
            (promotion) => promotion?.state === "succeeded" && promotion.cleanupError === null,
            "Owned Delivery cleanup did not finish",
            180_000,
          );
          expect(await forge.getBranch(repository, identity.branchName)).toBeNull();
          const grant = await fetch(
            `${processFixture.base}/api/runtime-access?${new URLSearchParams({ path: `/runtime/${promoted?.id}/app/` })}`,
            { headers: { cookie }, redirect: "manual" },
          );
          expect(grant.status).toBe(302);
          const location = new URL(grant.headers.get("location") ?? "");
          const redeemed = await fetch(
            `${processFixture.base}${location.pathname}${location.search}`,
            { redirect: "manual" },
          );
          expect(redeemed.status).toBe(302);
          const accessCookie = redeemed.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          const preview = await fetch(`${processFixture.base}/runtime/${promoted?.id}/app/`, {
            headers: { cookie: accessCookie },
          });
          expect(preview.status).toBe(200);
          expect(await preview.text()).toContain('<output id="version">');
          const source = await fetch(`${processFixture.base}/runtime/${promoted?.id}/app/source`, {
            headers: { cookie: accessCookie },
          });
          expect(source.status).toBe(200);
          expect(await source.json()).toMatchObject({ version: slug });
          await writeFile(
            `${evidenceDirectory}/delivery.json`,
            `${JSON.stringify({ verification, initial, promoted, previewServedExpectedVersion: true }, null, 2)}\n`,
          );
        }
      } catch (cause) {
        const commits = await database.client<
          { state: string; error: string | null; commitSHA: string | null }[]
        >`
          SELECT state, last_error AS error, commit_sha AS "commitSHA" FROM factory.change_commit_operation
          WHERE change_id = ${identity.changeID}`;
        const runtime = await attempt();
        await writeFile(
          `${evidenceDirectory}/failure.json`,
          `${JSON.stringify({ phase: "live-gate", error: cause instanceof Error ? cause.message : "Unknown test failure", commits, runtime }, null, 2)}\n`,
        );
        throw cause;
      } finally {
        for (const opened of terminals) opened.close();
        const cleanOwnedResources = async () => {
          // Preserve recovery identities if any external cleanup cannot be confirmed.
          if (!(await fetch(`${processFixture.base}/health/ready`).catch(() => null))?.ok)
            await processFixture.start();
          cookie = await processFixture.signIn();
          const owned = await database.client<
            { slug: string; state: string | null }[]
          >`SELECT project.slug, change.state FROM factory.project project
            LEFT JOIN factory.change change ON change.project_id = project.id
            WHERE project.id = ${projectID}`;
          if (owned.length) {
            expect(owned.map((row) => row.slug)).toEqual([slug]);
            if (owned[0]?.state !== "delivered") {
              await serverCall(
                callFactoryFunction(
                  processFixture.base,
                  "stopCoding",
                  [identity.changeID],
                  { cookie, origin: processFixture.base, "content-type": "application/json" },
                  AbortSignal.timeout(180_000),
                ),
              );
              await serverCall(
                callFactoryFunction(
                  processFixture.base,
                  "cancelChange",
                  [identity.changeID],
                  { cookie, origin: processFixture.base, "content-type": "application/json" },
                  AbortSignal.timeout(180_000),
                ),
              );
            }
            // Confirm every owned runtime is stopped before removing the disposable database.
            const stoppedAttempts = new Set<string>();
            await eventually(
              async () => {
                const ownedAttempts = await database.client<Array<{ id: string }>>`
                  SELECT id FROM factory.runtime_attempt WHERE project_id = ${projectID}
                    AND state <> 'stopped'
                `;
                for (const attempt of ownedAttempts) {
                  if (stoppedAttempts.has(attempt.id)) continue;
                  await serverCall(
                    callFactoryFunction(
                      processFixture.base,
                      "stopRuntimeAttempt",
                      [attempt.id],
                      { cookie, origin: processFixture.base, "content-type": "application/json" },
                      AbortSignal.timeout(180_000),
                    ),
                  );
                  stoppedAttempts.add(attempt.id);
                }
                if (ownedAttempts.length) return ownedAttempts.length;
                await removeOwnedProjectSources(database, projectID, (workspaceID) =>
                  serverCall(
                    callFactoryFunction(processFixture.base, "stopWorkspaceSource", [workspaceID], {
                      cookie,
                    }),
                  ),
                );
                const child = Bun.spawn(
                  [
                    "kubectl",
                    "--context",
                    "orbstack",
                    "get",
                    "namespaces",
                    "-l",
                    `factory.dev/project=${projectID}`,
                    "-o",
                    "json",
                  ],
                  { stdout: "pipe", stderr: "pipe" },
                );
                const [output, status] = await Promise.all([
                  new Response(child.stdout).text(),
                  child.exited,
                ]);
                if (status !== 0) throw new Error("Cannot confirm owned runtime cleanup");
                return (
                  ownedAttempts.length + (JSON.parse(output) as { items: unknown[] }).items.length
                );
              },
              (count) => count === 0,
              "Owned Namespace remained after cancellation",
              180_000,
            );
            const pulls = await database.client<
              { number: number | null }[]
            >`SELECT pull_request_number AS number FROM factory.pull_request_operation WHERE change_id = ${identity.changeID}`;
            for (const pull of pulls)
              if (pull.number !== null) {
                const observed = await forge.getPullRequest(
                  repository,
                  "main",
                  identity.branchName,
                );
                if (!observed || observed.number !== Number(pull.number))
                  throw new Error("Owned pull request cleanup refused unexpected identity");
                if (observed.merged || observed.state === "closed") continue;
                if (observed.headSha !== recoveredSHA)
                  throw new Error("Owned pull request cleanup refused unexpected head");
                const closed = await fetch(
                  `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${repository.name}/pulls/${pull.number}`,
                  {
                    method: "PATCH",
                    headers: {
                      authorization: `token ${forgejoToken}`,
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({ state: "closed" }),
                  },
                );
                if (!closed.ok) throw new Error("Owned pull request cleanup failed");
              }
          }
          if (branchCreateIntended) {
            const current = await forge.getBranch(repository, identity.branchName);
            if (current && ![baseSHA, recoveredSHA].includes(current.headSha))
              throw new Error("Owned branch cleanup refused unexpected head");
            if (current) await forge.deleteBranch(repository, identity.branchName);
          }
          safeToDispose = true;
          await writeFile(
            `${evidenceDirectory}/cleanup.json`,
            `${JSON.stringify({ projectID, runtimeResourcesRemoved: true, branchRemoved: branchCreateIntended }, null, 2)}\n`,
          );
        };
        try {
          await cleanOwnedResources();
        } finally {
          await database.client.end();
          if (safeToDispose) await processFixture.dispose();
          else await processFixture.shutdown();
        }
      }
    },
    process.env["FACTORY_LIVE_DELIVERY"] === "1" ? 1_500_000 : 720_000,
  );
}
