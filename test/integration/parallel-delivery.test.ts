import { expect, test } from "bun:test";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createImplementationOrders } from "../../apps/factory/src/change/implementation-orders";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import {
  createDeliveryCoordination,
  deliveryDelegationIn,
} from "../../apps/factory/src/delivery/coordination";
import { createChangeIntegration } from "../../apps/factory/src/delivery/integration";
import { RuntimeParentOperationError } from "../../apps/factory/src/runtime/hub";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { eventually } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

type Fixture = Awaited<ReturnType<typeof candidateReviewFixture>>;
const main = "e".repeat(40);
const integrated = "f".repeat(40);

async function passingReview(f: Fixture, delivery: "ordinary" | "human-required" = "ordinary") {
  const turn = await f.activeReview();
  await f.turns.settle(
    turn.id,
    turn.ownerToken,
    "completed",
    "Exact candidate passed",
    async (sql) => {
      await sql`UPDATE factory.candidate_review SET state='passed',result=${JSON.stringify({
        verdict: "passed",
        delivery,
        summary: "Exact application behavior checked",
        criteria: [{ criterion: 1, status: "passed", evidence: "Owned exact source observation" }],
        findings: [],
        ui: "not-applicable",
      })}::jsonb,completed_at=now() WHERE id=${f.reviewID}`;
      await sql`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    },
  );
}
async function enable(f: Fixture) {
  await f.database.client`UPDATE factory.project_membership SET manage_project=true
    WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
  const queue = createDeliveryCoordination(f.database);
  const policyId = crypto.randomUUID();
  await queue.configure(f.projectID, f.userID, {
    commandId: policyId,
    expectedPolicyId: null,
    enabled: true,
  });
  return { queue, policyId };
}
function delivery(f: Fixture, queued = false, beforeMerge?: () => Promise<void>) {
  let merges = 0;
  let baseReads = 0;
  const forge = {
    getPullRequest: async () => ({ number: 1, headSha: f.commit, merged: merges > 0 }),
    getDefaultBranch: async () => {
      if (++baseReads > 1) await beforeMerge?.();
      return { headSha: merges ? f.commit : "a".repeat(40) };
    },
    listFiles: async (_repository: unknown, ref: string) => [
      { path: "src/application.ts", sha: ref, size: 10 },
    ],
    mergeFastForward: async () => {
      merges++;
      return { headSha: f.commit };
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  const controller = createDeliveryController(
    f.database,
    {
      startVerification: async () => null,
      startStagingReplacement: async () => null,
      stop: async () => null,
    },
    { prompt: async () => null },
    async () => {},
    { client: forge, owner: "owned" },
    queued
      ? {
          reconcile: async () => {
            throw new Error("Unchanged main needs no integration");
          },
        }
      : undefined,
  );
  return { controller, merges: () => merges };
}
async function retainedPR(f: Fixture) {
  await f.database.client`INSERT INTO factory.pull_request_operation(
    id,change_id,repository_owner,repository_name,base_branch,head_branch,first_head_sha,
    title,body,idempotency_key,state,pull_request_number,pull_request_url,completed_at)
    SELECT ${crypto.randomUUID()},id,'owned','review','main',branch_name,${f.commit},
      'Owned candidate','','owned-'||id,'succeeded',1,'https://forge.invalid/owned/review/pulls/1',now()
    FROM factory.change WHERE id=${f.changeID}`;
}
async function additionalTicket(f: Fixture, change = false) {
  const ticketID = crypto.randomUUID(),
    revisionID = crypto.randomUUID(),
    approvalID = crypto.randomUUID(),
    changeID = crypto.randomUUID();
  await f.database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
    VALUES(${ticketID},${f.projectID},'Dependent Ticket','ready',${f.userID})`;
  await f.database
    .client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
    SELECT ${revisionID},${ticketID},1,canonical_content,content_digest,${f.userID} FROM factory.requirement_revision WHERE id=${f.revisionID}`;
  if (change) {
    await f.database
      .client`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
      VALUES(${approvalID},${ticketID},${revisionID},${f.userID})`;
    await f.database
      .client`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
      VALUES(${changeID},${f.projectID},${ticketID},${approvalID},${`factory/change-${ticketID.replaceAll("-", "").slice(0, 12)}`},${"a".repeat(40)},'active',${f.userID})`;
  }
  return {
    ticketID,
    revisionID,
    changeID,
    async dispose() {
      await f.database.client.begin(async (sql) => {
        await sql`SET LOCAL session_replication_role=replica`;
        await sql`DELETE FROM factory.implementation_order WHERE ticket_id=${ticketID}`;
        await sql`DELETE FROM factory.project_delivery_queue WHERE change_id IN (SELECT id FROM factory.change WHERE ticket_id=${ticketID})`;
        await sql`DELETE FROM factory.branch_create_operation WHERE change_id IN (SELECT id FROM factory.change WHERE ticket_id=${ticketID})`;
        await sql`DELETE FROM factory.change_writer WHERE change_id IN (SELECT id FROM factory.change WHERE ticket_id=${ticketID})`;
        await sql`DELETE FROM factory.change WHERE ticket_id=${ticketID}`;
        await sql`DELETE FROM factory.requirement_approval WHERE ticket_id=${ticketID}`;
        await sql`DELETE FROM factory.requirement_revision WHERE ticket_id=${ticketID}`;
        await sql`DELETE FROM factory.ticket_dependency WHERE ticket_id=${ticketID} OR prerequisite_id=${ticketID}`;
        await sql`DELETE FROM factory.ticket WHERE id=${ticketID} AND project_id=${f.projectID}`;
      });
    },
  };
}
async function observedDelivery(f: Fixture, promotion: "succeeded" | "failed" = "succeeded") {
  await passingReview(f);
  const approvalID = crypto.randomUUID();
  await f.database
    .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,candidate_review_id)
    VALUES(${approvalID},${f.changeID},${f.verificationID},${f.commit},${f.userID},${f.reviewID})`;
  await f.database
    .client`INSERT INTO factory.merge_operation(id,change_id,delivery_approval_id,pull_request_number,base_sha,commit_sha,
    idempotency_key,state,observed_default_sha,completed_at) VALUES(${crypto.randomUUID()},${f.changeID},${approvalID},1,${"a".repeat(40)},${f.commit},
      ${`owned-merge:${f.changeID}`},'succeeded',${f.commit},now())`;
  await f.database
    .client`INSERT INTO factory.promotion_operation(id,change_id,project_id,commit_sha,state,completed_at)
    VALUES(${crypto.randomUUID()},${f.changeID},${f.projectID},${f.commit},${promotion}::factory.promotion_operation_state,now())`;
  await f.database
    .client`UPDATE factory.change SET state=${promotion === "succeeded" ? "delivered" : "delivering"}::factory.change_state WHERE id=${f.changeID}`;
  if (promotion === "succeeded")
    await f.database.client`UPDATE factory.ticket SET state='done' WHERE id=${f.ticketID}`;
}

test("Delivery delegation requires manager and development authority and is fenced by revocation", async () => {
  const f = await candidateReviewFixture();
  try {
    const queue = createDeliveryCoordination(f.database);
    await expect(
      queue.configure(f.projectID, f.userID, {
        commandId: crypto.randomUUID(),
        expectedPolicyId: null,
        enabled: true,
      }),
    ).rejects.toThrow("Manager");
    const { policyId } = await enable(f);
    await f.writers.view(f.changeID, f.userID);
    const [writer] = await f.database.client<
      { state: string }[]
    >`SELECT state FROM factory.change_writer WHERE change_id=${f.changeID}`;
    expect(writer?.state).toBe("agent");
    expect((await queue.activePolicy(f.projectID))?.id).toBe(policyId);
    await queue.configure(f.projectID, f.userID, {
      commandId: crypto.randomUUID(),
      expectedPolicyId: policyId,
      enabled: false,
    });
    expect(await queue.activePolicy(f.projectID)).toBeNull();
    await expect(
      f.database.client.begin((sql) => deliveryDelegationIn(sql, f.projectID, policyId)),
    ).rejects.toThrow("no longer active");
  } finally {
    await f.dispose();
  }
}, 60_000);

test("automatic Delivery records its real delegation and never merges after revocation", async () => {
  const f = await candidateReviewFixture();
  try {
    await passingReview(f);
    const { queue, policyId } = await enable(f);
    const d = delivery(f);
    await d.controller.approve(f.changeID, f.userID, undefined, policyId);
    const [approval] = await f.database.client<
      { policy: string; review: string }[]
    >`SELECT delivery_policy_id AS policy,
      candidate_review_id AS review FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
    expect(approval).toEqual({ policy: policyId, review: f.reviewID });
    await queue.configure(f.projectID, f.userID, {
      commandId: crypto.randomUUID(),
      expectedPolicyId: policyId,
      enabled: false,
    });
    await d.controller.reconcile(f.changeID);
    expect(d.merges()).toBe(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("a passing quality review marked human-required cannot authorize automatic Delivery", async () => {
  const f = await candidateReviewFixture();
  try {
    await passingReview(f, "human-required");
    const { policyId } = await enable(f);
    await expect(
      delivery(f).controller.approve(f.changeID, f.userID, undefined, policyId),
    ).rejects.toThrow("human Delivery");
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("lost integration acknowledgement observes the exact operation instead of repeating Git writes", async () => {
  const f = await candidateReviewFixture();
  try {
    const queue = createDeliveryCoordination(f.database);
    await queue.claim(f.projectID, f.changeID);
    await f.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    const actions: string[] = [];
    f.hub.parentOperation = async (_attempt, message, beforeSend) => {
      let sent = false;
      await beforeSend?.(() => {
        sent = true;
      });
      expect(sent).toBe(true);
      actions.push(message.action);
      if (message.action === "git-prepare-integration")
        throw new Error("Owned lost acknowledgement");
      return { commitSHA: integrated, remoteSHA: integrated };
    };
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async () => {
          throw new Error("Clean Git needs no inference");
        },
      },
      { startPersisted: async () => null },
    );
    expect(await integration.reconcile(f.changeID, main)).toBe(false);
    expect(await integration.reconcile(f.changeID, main)).toBe(true);
    expect(actions).toEqual(["git-prepare-integration", "git-observe-commit", "git-push"]);
    const [commit] = await f.database.client<
      { base: string; parent: string; state: string }[]
    >`SELECT integration_base_sha AS base,
      merge_parent_sha AS parent,state FROM factory.change_commit_operation WHERE change_id=${f.changeID} AND source='integration'`;
    expect(commit).toEqual({ base: main, parent: main, state: "succeeded" });
    const [change] = await f.database.client<
      { base: string }[]
    >`SELECT base_sha AS base FROM factory.change WHERE id=${f.changeID}`;
    expect(change?.base).toBe("a".repeat(40));
    await expect(
      createReviewAdmission(f.database)(f.changeID, f.reviewID, f.userID),
    ).rejects.toThrow("current verified candidate");
    const verificationID = crypto.randomUUID(),
      reviewID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by,state,completed_at)
      VALUES(${verificationID},${f.changeID},${integrated},1,'owned-integrated',2,${f.userID},'succeeded',now())`;
    await f.database
      .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by)
      VALUES(${reviewID},${verificationID},${f.changeID},${integrated},${main},${f.userID})`;
    expect((await createReviewAdmission(f.database)(f.changeID, reviewID, f.userID)).replayed).toBe(
      false,
    );
  } finally {
    await f.dispose();
  }
}, 60_000);

test("Project Delivery is exclusive, blocked work can be bypassed, and failed Promotion fences later Delivery after recovery", async () => {
  const f = await candidateReviewFixture(),
    other = await additionalTicket(f, true);
  try {
    const queue = createDeliveryCoordination(f.database);
    const claims = await Promise.all([
      queue.claim(f.projectID, f.changeID),
      queue.claim(f.projectID, other.changeID),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await queue.release(claims[0] ? f.changeID : other.changeID);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(true);
    await queue.release(other.changeID);
    expect(await queue.claim(f.projectID, f.changeID)).toBe(true);
    await observedDelivery(f, "failed");
    await queue.release(f.changeID);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(false);
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, other.changeID)).toBe(
      false,
    );
  } finally {
    await other.dispose();
    await f.dispose();
  }
}, 60_000);

test("one explicit implementation order waits for successful prerequisite Delivery and survives dispatcher recovery", async () => {
  const f = await candidateReviewFixture(),
    dependent = await additionalTicket(f);
  try {
    await f.database
      .client`INSERT INTO factory.ticket_dependency(project_id,ticket_id,prerequisite_id,created_by)
      VALUES(${f.projectID},${dependent.ticketID},${f.ticketID},${f.userID})`;
    let base = "a".repeat(40),
      starts = 0;
    const forge = {
      getDefaultBranch: async () => ({ name: "main", headSha: base }),
      getBranch: async (_repository: unknown, name: string) => ({ name, headSha: base }),
      ensureBranch: async (_repository: unknown, name: string) => ({ name, headSha: base }),
    } as unknown as ReturnType<typeof createForgejoClient>;
    const config = {
      FACTORY_FORGEJO_API_URL: "https://forge.invalid/api/v1",
      FACTORY_FORGEJO_TOKEN: "owned",
      FACTORY_FORGEJO_OWNER: "owned",
    };
    const previous = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
    let changes: ReturnType<typeof createChangeController>;
    try {
      Object.assign(process.env, config);
      changes = createChangeController(
        f.database,
        { stop: async () => null },
        undefined,
        undefined,
        forge,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const commandID = crypto.randomUUID();
    expect(
      await changes.start(dependent.ticketID, f.userID, {
        commandID,
        revisionID: dependent.revisionID,
        admitBuild: async () => {
          starts++;
        },
      }),
    ).toBeNull();
    const agent = {
      admitStartIn: async () => {
        starts++;
      },
    };
    await createImplementationOrders(f.database, changes, agent).reconcile();
    expect(starts).toBe(0);
    expect(
      await f.database.client`SELECT id FROM factory.change WHERE ticket_id=${dependent.ticketID}`,
    ).toHaveLength(0);
    await observedDelivery(f);
    base = f.commit;
    await createImplementationOrders(f.database, changes, agent).reconcile();
    await eventually(
      async () => {
        const [row] = await f.database.client<
          { state: string }[]
        >`SELECT operation.state FROM factory.branch_create_operation operation
        JOIN factory.change change ON change.id=operation.change_id WHERE change.ticket_id=${dependent.ticketID}`;
        return row?.state === "succeeded";
      },
      (ready) => ready,
      "The commissioned dependent branch did not settle",
    );
    expect(starts).toBe(1);
    await createImplementationOrders(f.database, changes, agent).reconcile();
    expect(starts).toBe(1);
    const [order] = await f.database.client<
      { state: string; source: string }[]
    >`SELECT state,source_sha AS source FROM factory.implementation_order WHERE command_id=${commandID}`;
    expect(order).toEqual({ state: "started", source: "a".repeat(40) });
  } finally {
    await dependent.dispose();
    await f.dispose();
  }
}, 60_000);

test("only observed integration conflicts commission the existing implementer", async () => {
  const f = await candidateReviewFixture();
  try {
    await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID);
    await f.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    f.hub.parentOperation = async (_attempt, _message, beforeSend) => {
      await beforeSend?.(() => {});
      throw new RuntimeParentOperationError("git-prepare-integration", "integration has conflicts");
    };
    const prompts: { id: string; text: string }[] = [];
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async (_change, text, _user, id) => {
          prompts.push({ id, text });
        },
      },
      { startPersisted: async () => null },
    );
    expect(await integration.reconcile(f.changeID, main)).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(await integration.reconcile(f.changeID, main)).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain(main);
    expect(prompts[0]?.text).toContain("Do not start another merge");
  } finally {
    await f.dispose();
  }
}, 60_000);

test("a human writer fences integration without dispatching Git or inference", async () => {
  const f = await candidateReviewFixture();
  try {
    await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID);
    await f.database
      .client`UPDATE factory.change_writer SET state='human',user_id=${f.userID},turn_id=NULL WHERE change_id=${f.changeID}`;
    f.hub.parentOperation = async () => {
      throw new Error("Must not dispatch");
    };
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      {
        prompt: async () => {
          throw new Error("Must not infer");
        },
      },
      { startPersisted: async () => null },
    );
    expect(await integration.reconcile(f.changeID, main)).toBe(false);
    expect(
      await f.database
        .client`SELECT id FROM factory.change_commit_operation WHERE change_id=${f.changeID} AND source='integration'`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("a candidate awaiting human Delivery does not reclaim the queue ahead of independent work", async () => {
  const f = await candidateReviewFixture(),
    other = await additionalTicket(f, true);
  try {
    await passingReview(f);
    await retainedPR(f);
    const d = delivery(f, true),
      queue = createDeliveryCoordination(f.database);
    await d.controller.reconcile(f.changeID);
    const [held] = await f.database.client<
      { sha: string }[]
    >`SELECT delivery_waiting_sha AS sha FROM factory.change WHERE id=${f.changeID}`;
    expect(held?.sha).toBe(f.commit);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(true);
    await d.controller.reconcile(f.changeID);
    const [slot] = await f.database.client<
      { id: string }[]
    >`SELECT change_id AS id FROM factory.project_delivery_queue WHERE project_id=${f.projectID}`;
    expect(slot?.id).toBe(other.changeID);
  } finally {
    await other.dispose();
    await f.dispose();
  }
}, 60_000);

test("ordinary delegated Delivery merges the reviewed commit and keeps healthy Staging until its replacement is ready", async () => {
  const f = await candidateReviewFixture(),
    other = await additionalTicket(f, true);
  try {
    await passingReview(f);
    await retainedPR(f);
    const { queue } = await enable(f);
    const previous = crypto.randomUUID(),
      replacement = crypto.randomUUID();
    for (const [id, generation, revision, state] of [
      [previous, 2, "a".repeat(40), "ready"],
      [replacement, 3, f.commit, "starting"],
    ] as const) {
      await f.database
        .client`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${id},${f.projectID},'staging',${generation},${revision},${state}::factory.runtime_attempt_state,
          ${"a".repeat(64)},${"b".repeat(64)},now(),${f.userID})`;
    }
    await f.database
      .client`INSERT INTO factory.staging_preview(project_id,revision,runtime_attempt_id)
      VALUES(${f.projectID},${"a".repeat(40)},${previous})`;
    const d = delivery(f, true);
    await d.controller.reconcile(f.changeID);
    await d.controller.reconcile(f.changeID);
    expect(d.merges()).toBe(1);
    const [promotion] = await f.database.client<
      { id: string }[]
    >`SELECT id FROM factory.promotion_operation WHERE change_id=${f.changeID}`;
    expect(promotion).toBeDefined();
    await f.database
      .client`UPDATE factory.promotion_operation SET state='starting',replacement_runtime_attempt_id=${replacement} WHERE id=${fixtureValue(promotion, "promotion").id}`;
    await d.controller.reconcile(f.changeID);
    const [stillHealthy] = await f.database.client<
      { id: string }[]
    >`SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id=${f.projectID}`;
    expect(stillHealthy?.id).toBe(previous);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(false);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${replacement}`;
    await d.controller.reconcile(f.changeID);
    const [delivered] = await f.database.client<
      { state: string; revision: string }[]
    >`SELECT ticket.state,preview.revision
      FROM factory.ticket ticket JOIN factory.staging_preview preview ON preview.project_id=ticket.project_id WHERE ticket.id=${f.ticketID}`;
    expect(delivered).toEqual({ state: "done", revision: f.commit });
    expect(await queue.claim(f.projectID, other.changeID)).toBe(true);
  } finally {
    await f.database.client`DELETE FROM factory.staging_preview WHERE project_id=${f.projectID}`;
    await other.dispose();
    await f.dispose();
  }
}, 60_000);

test("a cold Ticket Sandbox waits without marking undispatched integration as an uncertain Git write", async () => {
  const f = await candidateReviewFixture();
  try {
    await createDeliveryCoordination(f.database).claim(f.projectID, f.changeID);
    await f.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
    const actions: string[] = [];
    f.hub.parentOperation = async (_attempt, message, beforeSend) => {
      await beforeSend?.(() => {});
      actions.push(message.action);
      return { commitSHA: integrated, remoteSHA: integrated };
    };
    const integration = createChangeIntegration(
      f.database,
      f.hub,
      { prompt: async () => null },
      { startPersisted: async () => null },
    );
    expect(await integration.reconcile(f.changeID, main)).toBe(false);
    expect(actions).toHaveLength(0);
    const [intent] = await f.database.client<{ error: string | null }[]>`SELECT last_error AS error
      FROM factory.change_commit_operation WHERE change_id=${f.changeID} AND source='integration'`;
    expect(intent?.error).toBeNull();
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
    expect(await integration.reconcile(f.changeID, main)).toBe(true);
    expect(actions).toEqual(["git-prepare-integration", "git-push"]);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("renewing a revoked delegation creates a new approval and merge intent without rewriting the failed attempt", async () => {
  const f = await candidateReviewFixture();
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    await passingReview(f);
    await retainedPR(f);
    const { queue, policyId } = await enable(f);
    const d = delivery(f, false, async () => {
      reached.resolve();
      await release.promise;
    });
    await d.controller.approve(f.changeID, f.userID, undefined, policyId);
    await reached.promise;
    await queue.configure(f.projectID, f.userID, {
      commandId: crypto.randomUUID(),
      expectedPolicyId: policyId,
      enabled: false,
    });
    release.resolve();
    await eventually(
      async () => {
        const [row] = await f.database.client<
          { state: string }[]
        >`SELECT state FROM factory.merge_operation WHERE change_id=${f.changeID}`;
        return row?.state;
      },
      (state) => state === "failed",
      "Revoked Delivery did not settle without merging",
    );
    const renewed = crypto.randomUUID();
    await queue.configure(f.projectID, f.userID, {
      commandId: renewed,
      expectedPolicyId: null,
      enabled: true,
    });
    await d.controller.approve(f.changeID, f.userID, undefined, renewed);
    await eventually(
      async () => f.database.client<{ state: string }[]>`SELECT state FROM factory.merge_operation
      WHERE change_id=${f.changeID} ORDER BY requested_at,id`,
      (rows) => rows.length === 2 && rows[1]?.state === "succeeded",
      "Renewed Delivery did not retain both merge outcomes",
    );
    const approvals = await f.database.client<
      { policy: string }[]
    >`SELECT delivery_policy_id AS policy FROM factory.delivery_approval
      WHERE change_id=${f.changeID} ORDER BY approved_at,id`;
    expect(approvals.map((row) => row.policy)).toEqual([policyId, renewed]);
    expect(d.merges()).toBe(1);
  } finally {
    release.resolve();
    await f.dispose();
  }
}, 60_000);

test("a second Factory process cannot reconcile through another process's Project Delivery command", async () => {
  const f = await candidateReviewFixture(),
    owner = f.database.coordination();
  const key = `delivery-project:${f.projectID}`;
  try {
    await passingReview(f);
    await retainedPR(f);
    await owner`SELECT pg_advisory_lock(hashtextextended(${key},0))`;
    const d = delivery(f, true);
    await d.controller.reconcile(f.changeID);
    expect(
      await f.database
        .client`SELECT project_id FROM factory.project_delivery_queue WHERE project_id=${f.projectID}`,
    ).toHaveLength(0);
    await owner`SELECT pg_advisory_unlock(hashtextextended(${key},0))`;
    await d.controller.reconcile(f.changeID);
    expect(
      await f.database
        .client`SELECT project_id FROM factory.project_delivery_queue WHERE project_id=${f.projectID}`,
    ).toHaveLength(1);
    expect(d.merges()).toBe(0);
  } finally {
    await owner.end();
    await f.dispose();
  }
}, 60_000);

test("revocation cannot turn a previously unconfirmed merge into proof that it never happened", async () => {
  const f = await candidateReviewFixture(),
    other = await additionalTicket(f, true);
  try {
    await passingReview(f);
    await retainedPR(f);
    const { queue, policyId } = await enable(f);
    const approvalID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,candidate_review_id,delivery_policy_id)
      VALUES(${approvalID},${f.changeID},${f.verificationID},${f.commit},${f.userID},${f.reviewID},${policyId})`;
    await f.database
      .client`INSERT INTO factory.merge_operation(id,change_id,delivery_approval_id,pull_request_number,base_sha,commit_sha,idempotency_key,state)
      VALUES(${crypto.randomUUID()},${f.changeID},${approvalID},1,${"a".repeat(40)},${f.commit},${`uncertain:${f.changeID}`},'ambiguous')`;
    await f.database.client`UPDATE factory.change SET state='delivering' WHERE id=${f.changeID}`;
    await queue.configure(f.projectID, f.userID, {
      commandId: crypto.randomUUID(),
      expectedPolicyId: policyId,
      enabled: false,
    });
    const d = delivery(f);
    await d.controller.reconcile(f.changeID);
    const [row] = await f.database.client<
      { state: string }[]
    >`SELECT state FROM factory.merge_operation WHERE change_id=${f.changeID}`;
    expect(row?.state).toBe("ambiguous");
    expect(d.merges()).toBe(0);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(false);
  } finally {
    await other.dispose();
    await f.dispose();
  }
}, 60_000);

test("an unconfirmed merge remains fenced when the default branch moves beyond its exact candidate", async () => {
  const f = await candidateReviewFixture(),
    other = await additionalTicket(f, true);
  try {
    await passingReview(f);
    await retainedPR(f);
    const approvalID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,approved_by,candidate_review_id)
        VALUES(${approvalID},${f.changeID},${f.verificationID},${f.commit},${f.userID},${f.reviewID})`;
    await f.database
      .client`INSERT INTO factory.merge_operation(id,change_id,delivery_approval_id,pull_request_number,base_sha,commit_sha,idempotency_key,state)
        VALUES(${crypto.randomUUID()},${f.changeID},${approvalID},1,${"a".repeat(40)},${f.commit},${`uncertain:${f.changeID}`},'ambiguous')`;
    await f.database.client`UPDATE factory.change SET state='delivering' WHERE id=${f.changeID}`;
    const forge = {
      getPullRequest: async () => ({ number: 1, headSha: f.commit, merged: true }),
      getDefaultBranch: async () => ({ headSha: main }),
      mergeFastForward: async () => {
        throw new Error("An unconfirmed merge must not be repeated against a moved branch");
      },
    } as unknown as ReturnType<typeof createForgejoClient>;
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => null,
        startStagingReplacement: async () => null,
        stop: async () => null,
      },
      { prompt: async () => null },
      async () => {},
      { client: forge, owner: "owned" },
    );
    await controller.reconcile(f.changeID);
    const [row] = await f.database.client<
      { state: string; completedAt: string | null }[]
    >`SELECT state,completed_at AS "completedAt" FROM factory.merge_operation WHERE change_id=${f.changeID}`;
    expect(row).toEqual({ state: "ambiguous", completedAt: null });
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, other.changeID)).toBe(
      false,
    );
  } finally {
    await other.dispose();
    await f.dispose();
  }
}, 60_000);
