import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { createForgejoClient } from "../../packages/forge/src/forge";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../packages/requirement-domain/src/requirement";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { ticketWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { removeOwnedFactoryboxFixture } from "../fixtures/factorybox-cleanup";
import { callFactoryFunction } from "../fixtures/server-functions";

// No inference: isolate real exact-commit CI from editor/Agent/second-Ticket startup.
test.skipIf(process.env["FACTORY_RUN_NATIVE_VERIFICATION_PROOF"] !== "1")(
  "fresh exact-commit Verification runs its actual Forgejo job in Factorybox",
  async () => {
    const forgeToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const processFixture = await factoryProcess({
      runtimeHostImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
      forgejoToken: forgeToken,
    });
    const database = processFixture.connect();
    const repository = { owner: "factory-mutation", name: "runtime-fixture" };
    const forge = createForgejoClient({
      apiURL: "http://127.0.0.1:33030/api/v1/",
      token: forgeToken,
    });
    const base = (await forge.getDefaultBranch(repository)).headSha;
    const projectID = crypto.randomUUID();
    const ticketID = crypto.randomUUID();
    const userID = crypto.randomUUID();
    const revisionID = crypto.randomUUID();
    const approvalID = crypto.randomUUID();
    const identity = changeIdentity(ticketID, approvalID);
    const workspace = ticketWorkspaceIdentity(identity.changeID);
    const historical = runtimeIdentity(workspace.workspaceID, 1);
    const owned = {
      projectID,
      userID,
      changeID: identity.changeID,
      attemptID: historical.attemptID,
    };
    const change = { branch: identity.branchName };
    const requirement = canonicalRequirementContent({
      summary: "Owned exact-commit CI",
      acceptanceCriteria: ["The declared syntax check passes"],
      nonGoals: ["No Agent Build"],
    });
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Owned native CI',${`native-ci-${projectID}@factory.local`},true)`;
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`native-ci-${projectID.slice(0, 8)}`},'Owned native CI','http://127.0.0.1:33030/factory-mutation/runtime-fixture.git','main','.devcontainer/devcontainer.json',${userID})`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${userID},'developer',${userID})`;
      await sql`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${ticketID},${projectID},'Owned native CI','in-progress',${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by) VALUES(${revisionID},${ticketID},1,${requirement},${requirementDigest(requirement)},${userID})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by) VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by) VALUES(${identity.changeID},${projectID},${ticketID},${approvalID},${identity.branchName},${base},'active',${userID})`;
      await sql`INSERT INTO factory.development_workspace(id,project_id,kind,ticket_id,change_id,source_branch,source_revision,created_by)
        VALUES(${workspace.workspaceID},${projectID},'ticket',${ticketID},${identity.changeID},${identity.branchName},${base},${userID})`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${historical.attemptID},${projectID},${identity.changeID},${workspace.workspaceID},1,${base},'stopped',${"a".repeat(64)},${"b".repeat(64)},now(),${userID})`;
    });
    const directory = resolve(".factory/test-results/verification-runtime", owned.projectID);
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "intent.json"),
      JSON.stringify({
        projectID: owned.projectID,
        changeID: owned.changeID,
        branch: change.branch,
        base,
      }),
    );
    let cookie = "";
    let candidate: string | undefined;
    let safeToDispose = false;
    try {
      await database.client`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key)
        VALUES(${identity.branchOperationID},${owned.changeID},${repository.owner},${repository.name},${change.branch},${base},${`change:${owned.changeID}:create-branch`})`;
      await forge.ensureBranch(repository, change.branch, base);
      await database.client`UPDATE factory.branch_create_operation SET state='succeeded',observed_head_sha=${base},completed_at=now() WHERE change_id=${owned.changeID}`;
      const file = await fetch(
        `http://127.0.0.1:33030/api/v1/repos/factory-mutation/runtime-fixture/contents/src/version.txt?ref=${encodeURIComponent(change.branch)}`,
        { headers: { authorization: `token ${forgeToken}` } },
      );
      if (!file.ok) throw new Error("Owned native source lookup failed");
      const content = z
        .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
        .parse(await file.json());
      const update = await fetch(
        "http://127.0.0.1:33030/api/v1/repos/factory-mutation/runtime-fixture/contents/src/version.txt",
        {
          method: "PUT",
          headers: { authorization: `token ${forgeToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            branch: change.branch,
            sha: content.sha,
            message: "Owned native exact-commit Verification",
            content: Buffer.from(`native-verification-${owned.projectID}\n`).toString("base64"),
          }),
        },
      );
      if (!update.ok) throw new Error("Owned native commit failed");
      candidate = z
        .object({ commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) })
        .parse(await update.json()).commit.sha;
      await writeFile(resolve(directory, "commit.json"), JSON.stringify({ candidate }));
      await database.client`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
        VALUES(${crypto.randomUUID()},${owned.changeID},${owned.attemptID},1,${change.branch},${base},${candidate},${candidate},'Owned native Verification',${`native-verification:${owned.changeID}:commit`},'succeeded',${owned.userID},now())`;
      await processFixture.start();
      cookie = await processFixture.signIn();
      let observed = "";
      const verification = await eventually(
        async () => {
          const [currentChange] = await database.client<
            Array<{ state: string; failure: string | null }>
          >`SELECT state,failure FROM factory.change WHERE id=${owned.changeID}`;
          if (currentChange?.state === "failed")
            throw new Error(
              `Owned native Change failed: ${currentChange.failure ?? "unknown outcome"}`,
            );
          const [current] = await database.client<
            Array<{
              state: string;
              sha: string;
              runtime: string | null;
              failure: string | null;
              namespace: string | null;
              pod: string | null;
            }>
          >`
          SELECT verification.state,verification.commit_sha AS sha,attempt.state AS runtime,attempt.failure,
            attempt.kubernetes_namespace AS namespace,attempt.kubernetes_pod_name AS pod
          FROM factory.verification verification LEFT JOIN factory.runtime_attempt attempt ON attempt.id=verification.runtime_attempt_id
          WHERE verification.change_id=${owned.changeID} ORDER BY verification.created_at DESC LIMIT 1`;
          const state = `${current?.state ?? "not started"}/${current?.runtime ?? "not created"}`;
          if (state !== observed) {
            console.info(`Native Verification: ${state}`);
            observed = state;
            await writeFile(resolve(directory, "state.json"), JSON.stringify(current ?? null));
          }
          if (
            current?.state === "failed" ||
            ["failed", "cleanup-failed"].includes(current?.runtime ?? "")
          )
            throw new Error(
              `Owned native Verification failed: ${current?.failure ?? current?.state}`,
            );
          return current;
        },
        (current) => current?.state === "succeeded",
        "Owned native Verification did not execute its real job",
        360_000,
      );
      expect(verification?.sha).toBe(candidate);
      await writeFile(resolve(directory, "verified.json"), JSON.stringify(verification));
    } finally {
      try {
        const cleanup = async () => {
          if (cookie) {
            await serverCall(
              callFactoryFunction(
                processFixture.base,
                "cancelChange",
                [owned.changeID],
                { cookie, origin: processFixture.base, "content-type": "application/json" },
                AbortSignal.timeout(90_000),
              ),
            );
            await eventually(
              async () => {
                const attempts = await database.client<
                  Array<{ id: string }>
                >`SELECT id FROM factory.runtime_attempt WHERE project_id=${owned.projectID} AND state<>'stopped'`;
                for (const attempt of attempts)
                  await serverCall(
                    callFactoryFunction(
                      processFixture.base,
                      "stopRuntimeAttempt",
                      [attempt.id],
                      { cookie, origin: processFixture.base, "content-type": "application/json" },
                      AbortSignal.timeout(90_000),
                    ),
                  );
                return attempts.length;
              },
              (count) => count === 0,
              "Owned native Verification compute cleanup failed",
              120_000,
            );
          }
          const pull = await forge.getPullRequest(repository, "main", change.branch);
          if (pull && !pull.merged && pull.state === "open") {
            if (pull.headSha !== candidate) throw new Error("Owned native PR head changed");
            const closed = await fetch(
              `http://127.0.0.1:33030/api/v1/repos/factory-mutation/runtime-fixture/pulls/${pull.number}`,
              {
                method: "PATCH",
                headers: {
                  authorization: `token ${forgeToken}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ state: "closed" }),
              },
            );
            if (!closed.ok) throw new Error("Owned native PR could not close");
          }
          const branch = await forge.getBranch(repository, change.branch);
          if (branch) {
            if (![base, candidate].includes(branch.headSha))
              throw new Error("Owned native branch head changed");
            await forge.deleteBranch(repository, change.branch);
          }
          await removeOwnedFactoryboxFixture(processFixture, directory);
          await writeFile(
            resolve(directory, "cleanup.json"),
            JSON.stringify({ ownedRuntimesRemoved: true, ownedBranchRemoved: true }),
          );
          safeToDispose = true;
        };
        await cleanup();
      } finally {
        await database.client.end({ timeout: 2 });
        if (safeToDispose) await processFixture.dispose();
        else await processFixture.shutdown();
      }
    }
  },
  600_000,
);
