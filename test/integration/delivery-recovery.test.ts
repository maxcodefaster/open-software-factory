import { expect, test } from "bun:test";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

async function deliveryFixture() {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const sha = "d".repeat(40);
    await database.client`UPDATE factory.project SET repository_url = 'http://forge.invalid/owned/build.git'
      WHERE id = ${owned.projectID}`;
    await database.client`INSERT INTO factory.change_commit_operation(
      id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
      commit_sha, observed_remote_sha, commit_message, idempotency_key, state, created_by, completed_at)
      SELECT ${crypto.randomUUID()}, id, runtime_attempt_id, 1, branch_name, base_sha,
        ${sha}, ${sha}, 'Owned Delivery regression', ${crypto.randomUUID()}, 'succeeded', created_by, now()
      FROM factory.change WHERE id = ${owned.changeID}`;
    await database.client`INSERT INTO factory.pull_request_operation(
      id, change_id, repository_owner, repository_name, base_branch, head_branch,
      first_head_sha, title, body, idempotency_key, state, pull_request_number, pull_request_url, completed_at)
      SELECT ${crypto.randomUUID()}, id, 'owned', 'build', 'main', branch_name, ${sha},
        'Owned', '', ${crypto.randomUUID()}, 'succeeded', 1, 'http://forge.invalid/pr/1', now()
      FROM factory.change WHERE id = ${owned.changeID}`;
    let head = sha;
    let base = "a".repeat(40);
    let status = "failure";
    const forge = {
      ...createForgejoClient({ apiURL: "http://127.0.0.1:9/api/v1/", token: "owned-unused" }),
      getPullRequest: async () => ({
        number: 1,
        url: "http://forge.invalid/pr/1",
        headSha: head,
        merged: false,
        state: "open",
        baseBranch: "main",
        baseSha: base,
        headBranch: "factory/owned",
      }),
      getDefaultBranch: async () => ({ name: "main", headSha: base }),
      getFile: async () => "owned protected workflow",
      listActionRuns: async () => [
        {
          id: 1,
          workflowID: "factory-verification.yml",
          event: "pull_request",
          status,
          commitSha: head,
          url: "http://forge.invalid/run/1",
        },
      ],
    };
    return {
      process,
      database,
      owned,
      sha,
      forge,
      setHead(value: string) {
        head = value;
      },
      setBase(value: string) {
        base = value;
      },
      setStatus(value: string) {
        status = value;
      },
      async close() {
        await database.client.end({ timeout: 0 });
        await process.dispose();
      },
    };
  } catch (cause) {
    await database.client.end({ timeout: 0 });
    await process.dispose();
    throw cause;
  }
}

test("failed exact Verification requests one bounded repair on the same Change", async () => {
  const f = await deliveryFixture();
  const prompts: Array<{
    changeID: string;
    text: string;
    userID: string;
    commandID: string;
    repair: boolean | undefined;
  }> = [];
  try {
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => {
          throw new Error("Completed failed run must not start compute");
        },
        startStagingReplacement: async () => null,
        stop: async () => null,
      },
      {
        prompt: async (changeID, text, userID, commandID, repair) => {
          prompts.push({ changeID, text, userID, commandID, repair });
        },
      },
      async () => {},
      { client: f.forge, owner: "owned" },
    );
    await controller.reconcile(f.owned.changeID);
    await controller.reconcile(f.owned.changeID);
    const [verification] = await f.database.client<
      { id: string; state: string; sha: string; repaired: boolean }[]
    >`
      SELECT id, state, commit_sha AS sha, repair_prompted_at IS NOT NULL AS repaired
      FROM factory.verification WHERE change_id = ${f.owned.changeID}`;
    expect(verification).toMatchObject({ state: "failed", sha: f.sha, repaired: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      changeID: f.owned.changeID,
      userID: f.owned.userID,
      commandID: verification?.id,
      repair: true,
    });
    expect(prompts[0]?.text).toContain(f.sha.slice(0, 12));
    expect(prompts[0]?.text).toContain("without committing or pushing");
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id = ${f.owned.changeID}`,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 60_000);

test.each(["head", "base"] as const)(
  "exact human delivery rejects moving %s",
  async (moved) => {
    const f = await deliveryFixture();
    try {
      f.setStatus("success");
      const controller = createDeliveryController(
        f.database,
        {
          startVerification: async () => null,
          startStagingReplacement: async () => null,
          stop: async () => null,
        },
        {
          prompt: async () => {
            throw new Error("Green run must not repair");
          },
        },
        async () => {},
        { client: f.forge, owner: "owned" },
      );
      await controller.reconcile(f.owned.changeID);
      if (moved === "head") f.setHead("e".repeat(40));
      else f.setBase("e".repeat(40));
      await expect(controller.approve(f.owned.changeID, f.owned.userID)).rejects.toThrow(
        "Current commit is not eligible for delivery",
      );
      expect(
        await f.database
          .client`SELECT id FROM factory.delivery_approval WHERE change_id = ${f.owned.changeID}`,
      ).toHaveLength(0);
      expect(
        await f.database
          .client`SELECT id FROM factory.merge_operation WHERE change_id = ${f.owned.changeID}`,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("promotion retains the healthy Staging while starting, then retries only owned cleanup", async () => {
  const f = await deliveryFixture();
  try {
    const previous = crypto.randomUUID();
    const replacement = crypto.randomUUID();
    const verification = crypto.randomUUID();
    const approval = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number, runner_name, state, action_run_id, created_by, completed_at)
      VALUES (${verification}, ${f.owned.changeID}, ${f.sha}, 1, 'owned-complete', 'succeeded', 1, ${f.owned.userID}, now())`;
    await f.database
      .client`INSERT INTO factory.delivery_approval(id, change_id, verification_id, commit_sha, approved_by)
      VALUES (${approval}, ${f.owned.changeID}, ${verification}, ${f.sha}, ${f.owned.userID})`;
    await f.database
      .client`INSERT INTO factory.merge_operation(id, change_id, delivery_approval_id, pull_request_number, base_sha, commit_sha, idempotency_key, state, observed_default_sha, completed_at)
      VALUES (${crypto.randomUUID()}, ${f.owned.changeID}, ${approval}, 1, ${"a".repeat(40)}, ${f.sha}, ${crypto.randomUUID()}, 'succeeded', ${f.sha}, now())`;
    for (const [id, revision, state, generation] of [
      [previous, "a".repeat(40), "ready", 2],
      [replacement, f.sha, "starting", 3],
    ] as const) {
      await f.database
        .client`INSERT INTO factory.runtime_attempt(id, project_id, isolated_kind, generation, revision, state, parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
        VALUES (${id}, ${f.owned.projectID}, 'staging', ${generation}, ${revision}, ${state}::factory.runtime_attempt_state, ${"a".repeat(64)}, ${"b".repeat(64)}, now(), ${f.owned.userID})`;
    }
    await f.database
      .client`INSERT INTO factory.staging_preview(project_id, revision, runtime_attempt_id) VALUES (${f.owned.projectID}, ${"a".repeat(40)}, ${previous})`;
    await f.database
      .client`INSERT INTO factory.promotion_operation(id, change_id, project_id, commit_sha, state, previous_runtime_attempt_id, replacement_runtime_attempt_id)
      VALUES (${crypto.randomUUID()}, ${f.owned.changeID}, ${f.owned.projectID}, ${f.sha}, 'starting', ${previous}, ${replacement})`;
    const stopped: string[] = [];
    const retired: string[] = [];
    let failed = false;
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => null,
        startStagingReplacement: async () => null,
        stop: async (id) => {
          stopped.push(id);
          if (!failed) {
            failed = true;
            throw new Error("Owned cleanup response lost");
          }
          return null;
        },
      },
      { prompt: async () => null },
      async (id) => {
        retired.push(id);
      },
      {
        client: f.forge,
        owner: "owned",
      },
    );
    await controller.reconcile(f.owned.changeID);
    const [before] = await f.database.client<
      { id: string }[]
    >`SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id = ${f.owned.projectID}`;
    expect(before?.id).toBe(previous);
    expect(stopped).toEqual([]);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state = 'ready' WHERE id = ${replacement}`;
    await controller.reconcile(f.owned.changeID);
    const [switched] = await f.database.client<
      { id: string; sha: string }[]
    >`SELECT runtime_attempt_id AS id, revision AS sha FROM factory.staging_preview WHERE project_id = ${f.owned.projectID}`;
    expect(switched).toEqual({ id: replacement, sha: f.sha });
    expect((await controller.get(f.owned.changeID))?.["cleanupError"]).toBe(
      "Owned cleanup response lost",
    );
    await controller.reconcile(f.owned.changeID);
    expect((await controller.get(f.owned.changeID))?.["cleanupError"]).toBeNull();
    expect(stopped).toEqual([previous, previous, f.owned.attemptID]);
    expect(stopped).not.toContain(replacement);
    expect(retired).toEqual([f.owned.changeID]);
  } finally {
    await f.close();
  }
}, 60_000);
