import { expect, test } from "bun:test";
import { createWorkspaceSubmission } from "../../apps/factory/src/workspace/submission";
import { fixture } from "../fixtures/change-agent-turns";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { prepareVerificationHandoff } from "../../apps/factory/src/runtime/verification-handoff";
import type { createForgejoClient } from "../../packages/forge/src/forge";

test("a collaborator submits the saved shared Ticket checkout once without granting Delivery approval", async () => {
  const f = await fixture();
  await f.database
    .client`UPDATE factory.project SET repository_url='https://forge.factory.invalid/owned/project.git' WHERE id=${f.projectID}`;
  const peer = crypto.randomUUID();
  const sha = "d".repeat(40),
    base = "a".repeat(40);
  let remote = base;
  const calls: string[] = [];
  let losePrepared = true;
  let connected = true;
  await f.database
    .client`INSERT INTO auth."user"(id,name,email)VALUES(${peer},'Shared developer',${`${peer}@factory.invalid`})`;
  await f.database
    .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)VALUES(${f.projectID},${peer},'developer',${f.userID})`;
  await f.database
    .client`UPDATE factory.development_workspace SET collaboration_enabled=true WHERE id=${f.workspaceID}`;
  await f.database
    .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=epoch+1 WHERE change_id=${f.changeID}`;
  const hub = {
    connected: () => connected,
    parentOperation: async (
      attemptID: string,
      input: Record<string, string | number>,
      beforeSend?: (send: () => void) => Promise<void>,
    ) => {
      expect(attemptID).toBe(f.attemptID);
      await beforeSend?.(() => {});
      calls.push(String(input["action"]));
      if (input["action"] === "git-prepare-commit" && losePrepared) {
        losePrepared = false;
        throw new Error("lost exact commit response");
      }
      if (input["action"] === "git-push") {
        expect(input["expectedSha"]).toBe(base);
        remote = sha;
        return { remoteSHA: sha };
      }
      return { commitSHA: sha };
    },
  };
  const service = createWorkspaceSubmission(
    f.database,
    hub,
    { assertSaved: async () => {} },
    { getBranch: async () => ({ name: "branch", headSha: remote }) },
    { username: "fixture", password: "fixture-not-retained" },
  );
  const input = {
    requestID: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    expectedHead: base,
    expectedRemoteHead: base,
    message: "Submit reviewed shared source",
  };
  try {
    await expect(service.submit(peer, input)).rejects.toThrow("lost exact commit response");
    expect((await service.observe(peer, input.requestID)).state).toBe("commit-intended");
    const result = await service.submit(peer, input);
    expect(result).toMatchObject({ state: "succeeded", commitSHA: sha, submittedBy: peer });
    expect(await service.submit(peer, input)).toEqual(result);
    connected = false;
    expect(await service.submit(peer, input)).toEqual(result);
    expect(calls).toEqual(["git-prepare-commit", "git-observe-commit", "git-push"]);
    await expect(service.submit(peer, { ...input, message: "changed decision" })).rejects.toThrow(
      "different input",
    );
    const [commit] = await f.database.client<
      { source: string; sha: string; remote: string }[]
    >`SELECT source::text,commit_sha AS sha,observed_remote_sha AS remote FROM factory.change_commit_operation WHERE id=${input.requestID}`;
    expect(commit).toEqual({ source: "workspace", sha, remote: sha });
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    const [writer] = await f.database.client<
      { state: string }[]
    >`SELECT state FROM factory.change_writer WHERE change_id=${f.changeID}`;
    expect(writer?.state).toBe("unassigned");
  } finally {
    await service.close();
    await f.database
      .client`DELETE FROM factory.workspace_submission WHERE workspace_id=${f.workspaceID}`;
    await f.dispose();
  }
}, 30000);

test("a Workspace submission with no Coding turn or Agent Session enters exact Verification and independent review", async () => {
  const f = await fixture();
  const base = "a".repeat(40),
    commit = "f".repeat(40);
  let remote = base,
    checksPassed = false;
  await f.database
    .client`UPDATE factory.project SET repository_url='https://forge.invalid/owned/workspace.git' WHERE id=${f.projectID}`;
  await f.database.client`DELETE FROM factory.change_agent_session WHERE change_id=${f.changeID}`;
  await f.database
    .client`UPDATE factory.change SET state='failed',failure='Previous Coding failed' WHERE id=${f.changeID}`;
  await f.database
    .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=epoch+1 WHERE change_id=${f.changeID}`;
  const submission = createWorkspaceSubmission(
    f.database,
    {
      connected: () => true,
      parentOperation: async (_attemptID, input, beforeSend) => {
        await beforeSend?.(() => {});
        if (input.action === "git-push") remote = commit;
        return { commitSHA: commit, remoteSHA: remote };
      },
    },
    { assertSaved: async () => {} },
    { getBranch: async () => ({ name: "branch", headSha: remote }) },
    { username: "fixture", password: "fixture" },
  );
  const verificationStarts: string[] = [],
    reviewTurns: string[] = [],
    revokedRunners: number[] = [];
  const forge = {
    ensureDefaultBranchProtection: async () => {},
    ensurePullRequest: async () => ({
      number: 1,
      url: "https://forge.invalid/owned/workspace/pulls/1",
      headSha: commit,
      merged: false,
    }),
    getPullRequest: async () => ({ number: 1, headSha: commit, merged: false }),
    getDefaultBranch: async () => ({ headSha: base }),
    getFile: async () => "protected workflow",
    listFiles: async () => [],
    listActionRuns: async () => [
      {
        id: 1,
        workflowID: "factory-verification.yml",
        event: "pull_request",
        status: checksPassed ? "success" : "waiting",
        url: "https://forge.invalid/owned/workspace/actions/runs/1",
      },
    ],
    registerEphemeralRunner: async () => ({
      id: 42,
      uuid: "9adfd2a8-5bd3-412f-af74-7cbdc0e0a542",
      token: "owned-fixture-token",
    }),
    deleteRunner: async (_repository: unknown, id: number) => {
      revokedRunners.push(id);
    },
    observeVerification: async () => ({ status: "success", complete: true }),
  } as unknown as ReturnType<typeof createForgejoClient>;
  const delivery = createDeliveryController(
    f.database,
    {
      startVerification: async (verificationID) => {
        verificationStarts.push(verificationID);
        const handoff = await prepareVerificationHandoff(
          f.database,
          { claimIdle: () => true, releaseIdle: () => {} },
          verificationID,
        );
        expect(handoff).toEqual({ ready: false, stopAttemptID: f.attemptID });
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now() WHERE id=${f.attemptID} AND state='stop-intended'`;
        expect(
          await prepareVerificationHandoff(
            f.database,
            { claimIdle: () => true, releaseIdle: () => {} },
            verificationID,
          ),
        ).toEqual({ ready: true });
        return null;
      },
      startStagingReplacement: async () => null,
      stop: async () => null,
    },
    {
      review: async (changeID, reviewID, userID) => {
        const admitted = await createReviewAdmission(f.database, async (_sql, context) => {
          expect(context).toEqual({ projectID: f.projectID, userID: f.userID });
          return { modelId: "project-review-model" };
        })(changeID, reviewID, userID);
        expect(admitted.turn.authority).toMatchObject({
          mode: "build",
          modelId: "project-review-model",
          requirementRevisionId: f.revisionID,
          review: { verificationId: verificationStarts[0], commitSha: commit, baseSha: base },
        });
        reviewTurns.push(admitted.turn.id);
      },
      prompt: async () => {
        throw new Error("Workspace submission must not fabricate a Coding turn");
      },
    },
    async () => {},
    { client: forge, owner: "owned" },
    {
      reconcile: async () => {
        throw new Error("Unchanged base needs no integration");
      },
    },
  );
  try {
    expect(
      await f.database.client`SELECT id FROM factory.agent_turn WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    await submission.submit(f.userID, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      expectedHead: base,
      expectedRemoteHead: base,
      message: "Submit human implementation",
    });
    await delivery.sweep();
    const [change] = await f.database.client<
      { failure: string | null }[]
    >`SELECT failure FROM factory.change WHERE id=${f.changeID}`;
    expect(change?.failure).toBeNull();
    expect(verificationStarts).toHaveLength(1);
    const [verification] = await f.database.client<
      { commit: string; state: string }[]
    >`SELECT commit_sha AS commit,state FROM factory.verification WHERE change_id=${f.changeID}`;
    expect(verification).toEqual({ commit, state: "runner-starting" });
    checksPassed = true;
    await delivery.sweep();
    expect(reviewTurns).toHaveLength(1);
    expect(revokedRunners).toEqual([42]);
    expect(
      await f.database
        .client`SELECT change_id FROM factory.change_agent_session WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    expect(
      await f.database
        .client`SELECT id FROM factory.agent_turn WHERE change_id=${f.changeID} AND input->>'kind'<>'change-review'`,
    ).toHaveLength(0);
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
  } finally {
    await delivery.close();
    await submission.close();
    await f.database
      .client`DELETE FROM factory.workspace_submission WHERE workspace_id=${f.workspaceID}`;
    await f.dispose();
  }
}, 30000);

test("shared submission refuses unsaved buffers and recovers a lost push by observing its exact SHA", async () => {
  const f = await fixture();
  const base = "a".repeat(40),
    commit = "e".repeat(40);
  let dirty = true,
    remote = base,
    pushes = 0;
  await f.database
    .client`UPDATE factory.project SET repository_url='https://forge.factory.invalid/owned/project.git' WHERE id=${f.projectID}`;
  await f.database
    .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=epoch+1 WHERE change_id=${f.changeID}`;
  const service = createWorkspaceSubmission(
    f.database,
    {
      connected: () => true,
      parentOperation: async (_attemptID, input, beforeSend) => {
        await beforeSend?.(() => {});
        if (input.action === "git-push") {
          pushes++;
          remote = commit;
          throw new Error("lost push acknowledgement");
        }
        return { commitSHA: commit };
      },
    },
    {
      assertSaved: async () => {
        if (dirty) throw new Error("Save shared buffers first");
      },
    },
    { getBranch: async () => ({ name: "branch", headSha: remote }) },
    { username: "fixture", password: "fixture" },
  );
  const input = {
    requestID: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    expectedHead: base,
    expectedRemoteHead: base,
    message: "Submit saved checkout",
  };
  try {
    await expect(service.submit(f.userID, input)).rejects.toThrow("Save shared buffers");
    expect(await f.database.client`SELECT id FROM factory.workspace_submission`).toHaveLength(0);
    dirty = false;
    await expect(service.submit(f.userID, input)).rejects.toThrow("lost push");
    await f.database
      .client`UPDATE factory.change SET state='failed',failure='A newer human decision' WHERE id=${f.changeID}`;
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},epoch=epoch+1 WHERE change_id=${f.changeID}`;
    expect((await service.submit(f.userID, input)).commitSHA).toBe(commit);
    expect(pushes).toBe(1);
    const [later] = await f.database.client<
      { state: string; failure: string }[]
    >`SELECT state,failure FROM factory.change WHERE id=${f.changeID}`;
    expect(later).toEqual({ state: "failed", failure: "A newer human decision" });
  } finally {
    await service.close();
    await f.database
      .client`DELETE FROM factory.workspace_submission WHERE workspace_id=${f.workspaceID}`;
    await f.dispose();
  }
}, 30000);
