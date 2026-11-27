import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "#db/client";
import type { createForgejoClient } from "#forge/forge";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createImplementationOrders } from "../../apps/factory/src/change/implementation-orders";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import {
  createDeliveryCoordination,
  deliveryDelegationIn,
} from "../../apps/factory/src/delivery/coordination";
import { createChangeIntegration } from "../../apps/factory/src/delivery/integration";
import { RuntimeParentOperationError } from "../../apps/factory/src/runtime/hub";
import { candidateReviewFixture as sharedCandidateReviewFixture } from "../fixtures/candidate-review";
import { eventually } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";
import { fixtureValue } from "../fixtures/value";

type Fixture = Awaited<ReturnType<typeof candidateReviewFixture>>;
const main = "e".repeat(40);
const integrated = "f".repeat(40);

// These controller proofs need PostgreSQL and injected peers, not an application build.
let postgresServer: ReturnType<typeof ownedPostgresServer> | undefined;
afterAll(async () => {
  await (await postgresServer)?.dispose();
}, 60_000);
async function candidateReviewFixture(
  canonical?: string,
  externalDatabase?: ReturnType<typeof createDatabase>,
) {
  if (externalDatabase) return sharedCandidateReviewFixture(canonical, externalDatabase);
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  if (!supplied) postgresServer ??= ownedPostgresServer();
  const ownedServer = await postgresServer;
  const identity: PostgresIdentity | undefined = supplied
    ? JSON.parse(supplied)
    : ownedServer?.identity;
  if (!identity) throw Error("Owned Delivery PostgreSQL identity is missing");
  const target = await ownedTestDatabase(identity, crypto.randomUUID());
  const previous = process.env["DATABASE_URL"];
  let database: ReturnType<typeof createDatabase>;
  try {
    process.env["DATABASE_URL"] = target.url;
    database = createDatabase();
  } finally {
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
  }
  let owned: Awaited<ReturnType<typeof sharedCandidateReviewFixture>> | undefined;
  async function dispose() {
    try {
      await owned?.shutdown();
    } finally {
      owned?.restoreEnvironment();
      await database.client.end({ timeout: 1 });
      await target.dispose();
    }
  }
  try {
    owned = await sharedCandidateReviewFixture(canonical, database);
    return { ...owned, dispose };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

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
function delivery(
  f: Fixture,
  queued = false,
  beforeMerge?: () => Promise<void>,
  runtime?: Parameters<typeof createDeliveryController>[1],
) {
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
    runtime ?? {
      startVerification: async () => null,
      startStagingReplacement: async () => null,
      pause: async (id) => {
        expect(id).toBe(f.attemptID);
        return null;
      },
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
  await f.database.client`INSERT INTO factory.operation(
    id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,result,created_by,completed_at)
    SELECT ${crypto.randomUUID()},'delivery.pull_request','change',id::text,
      'delivery.pull_request:owned-'||id,NULL,'succeeded',
      jsonb_build_object(
        'changeId',id::text,'repositoryOwner','owned','repositoryName','review',
        'baseBranch','main','headBranch',branch_name,'commitSha',${f.commit}::text,
        'firstHeadSha',${f.commit}::text,'title','Owned candidate','body',''
      ),
      jsonb_build_object('number',1,'url','https://forge.invalid/owned/review/pulls/1'),
      created_by,now()
    FROM factory.change WHERE id=${f.changeID}`;
}

test.each(["released", "claimed-by-another-change"] as const)(
  "Delivery slot release during manual approval: %s",
  async (interleaving) => {
    const f = await candidateReviewFixture();
    let controller: ReturnType<typeof createDeliveryController> | undefined;
    let other: Awaited<ReturnType<typeof additionalTicket>> | undefined;
    try {
      await passingReview(f);
      await retainedPR(f);
      if (interleaving === "claimed-by-another-change") other = await additionalTicket(f, true);
      const queue = createDeliveryCoordination(f.database);
      let released = false;
      const forge = {
        getPullRequest: async () => {
          if (!released) {
            released = true;
            await queue.release(f.changeID);
            if (other) expect(await queue.claim(f.projectID, other.changeID)).toBe(true);
          }
          return { number: 1, headSha: f.commit, merged: false };
        },
        getDefaultBranch: async () => ({ headSha: "a".repeat(40) }),
        mergeFastForward: async () => ({ headSha: f.commit }),
      } as unknown as ReturnType<typeof createForgejoClient>;
      controller = createDeliveryController(
        f.database,
        {
          startVerification: async () => null,
          startStagingReplacement: async () => null,
          pause: async () => {
            throw new Error("A lost Delivery slot must not pause Coding compute");
          },
          stop: async () => null,
        },
        { prompt: async () => null },
        async () => {},
        { client: forge, owner: "owned" },
        {
          reconcile: async () => {
            throw new Error("Unchanged main needs no integration");
          },
        },
      );
      if (other) {
        await expect(controller.approve(f.changeID, f.userID)).rejects.toThrow(
          "This candidate no longer owns the Project Delivery slot.",
        );
        expect(
          await f.database
            .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
        ).toHaveLength(0);
        const [slot] = await f.database.client<{ changeID: string }[]>`
          SELECT payload->>'changeId' AS "changeID" FROM factory.operation
          WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`}`;
        expect(slot?.changeID).toBe(other.changeID);
      } else {
        await controller.approve(f.changeID, f.userID);
        expect(
          await f.database.client`SELECT id FROM factory.delivery_approval
            WHERE change_id=${f.changeID} AND candidate_review_id=${f.reviewID}
              AND verification_id=${f.verificationID} AND commit_sha=${f.commit}`,
        ).toHaveLength(1);
        expect(
          await f.database
            .client`SELECT id FROM factory.operation WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`,
        ).toHaveLength(1);
      }
      expect(released).toBe(true);
    } finally {
      await controller?.close();
      await other?.dispose();
      await f.dispose();
    }
  },
  60_000,
);

test("Delivery slot release rechecks a merge intent after waiting for its row lock", async () => {
  const f = await candidateReviewFixture();
  let release: Promise<void> | undefined;
  try {
    await passingReview(f);
    const queue = createDeliveryCoordination(f.database);
    expect(await queue.claim(f.projectID, f.changeID)).toBe(true);
    await f.database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.operation
        WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`} FOR UPDATE`;
      release = queue.release(f.changeID);
      await eventually(
        () => f.database.client<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND wait_event_type='Lock' AND query LIKE '%"factory"."operation"%' AND query LIKE '%active_key%') AS waiting`,
        (rows) => rows[0]?.waiting === true,
        "The original release did not reach the locked Delivery slot",
      );
      const approvalID = crypto.randomUUID();
      await sql`INSERT INTO factory.delivery_approval(
        id,change_id,verification_id,commit_sha,approved_by,candidate_review_id)
        VALUES(${approvalID},${f.changeID},${f.verificationID},${f.commit},${f.userID},${f.reviewID})`;
      await sql`INSERT INTO factory.operation(
        id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
        VALUES(${crypto.randomUUID()},'delivery.merge','change',${f.changeID},
          ${`delivery.merge:owned-release-race:${f.changeID}`},${`delivery.merge:${f.changeID}`},'pending',
          jsonb_build_object(
            'changeId',${f.changeID}::text,'commitSha',${f.commit}::text,'baseSha',${"a".repeat(40)}::text,
            'pullRequestNumber',1,'approvalId',${approvalID}::text,'deliveryPolicyId',NULL::text
          ),${f.userID})`;
    });
    await release;
    const [slot] = await f.database.client<{ changeID: string | null }[]>`
      SELECT payload->>'changeId' AS "changeID" FROM factory.operation
      WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`}`;
    expect(slot?.changeID).toBe(f.changeID);
  } finally {
    await release?.catch(() => {});
    await f.dispose();
  }
}, 60_000);

test.each(["open", "implemented"] as const)(
  "human feedback %s blocks integration and merge, not submitted checks or independent review",
  async (feedbackState) => {
    const f = await candidateReviewFixture();
    const feedbackID = crypto.randomUUID();
    let integrations = 0;
    let reviews = 0;
    try {
      await retainedPR(f);
      await f.database.client`UPDATE factory.change_agent_session SET state='committed'
        WHERE change_id=${f.changeID}`;
      await f.database.client`DELETE FROM factory.candidate_review WHERE id=${f.reviewID}`;
      await f.database.client`DELETE FROM factory.verification WHERE id=${f.verificationID}`;
      await f.database.client`INSERT INTO factory.review_feedback
        (id,change_id,author_id,kind,state,commit_sha)
        VALUES(${feedbackID},${f.changeID},${f.userID},'thread',${feedbackState},${f.commit})`;
      const forge = {
        getPullRequest: async () => ({ number: 1, headSha: f.commit, merged: false }),
        getDefaultBranch: async () => ({ headSha: main }),
        getFile: async () => "Owned protected workflow",
        listActionRuns: async () => [],
      } as unknown as ReturnType<typeof createForgejoClient>;
      const controller = createDeliveryController(
        f.database,
        {
          startVerification: async () => {
            throw new Error("Owned checks wait for the forge run observation");
          },
          startStagingReplacement: async () => {
            throw new Error("Open human feedback cannot promote");
          },
          pause: async () => {
            throw new Error("Open human feedback cannot pause Coding compute");
          },
          stop: async () => null,
        },
        {
          prompt: async () => {
            throw new Error("Checking submitted work cannot commission implementation");
          },
          review: async (changeID, reviewID, userID) => {
            const admitted = await createReviewAdmission(f.database)(changeID, reviewID, userID);
            if (!admitted.replayed) reviews++;
          },
        },
        async () => {},
        { client: forge, owner: "owned" },
        {
          reconcile: async () => {
            integrations++;
            throw new Error("Open human feedback cannot integrate source");
          },
        },
      );
      await controller.reconcile(f.changeID);
      const [verification] = await f.database.client<
        { id: string; state: string; commit: string }[]
      >`
        SELECT id,state,commit_sha AS commit FROM factory.verification WHERE change_id=${f.changeID}`;
      expect(verification).toMatchObject({ state: "pending", commit: f.commit });
      await f.database.client`UPDATE factory.verification SET state='succeeded',completed_at=now(),
        action_run_id=1 WHERE id=${fixtureValue(verification, "verification").id}`;
      await controller.reconcile(f.changeID);
      expect(reviews).toBe(1);
      expect(integrations).toBe(0);
      expect((await controller.get(f.changeID))?.["openReviewThreads"]).toBe(1);
      expect(
        await f.database
          .client`SELECT id FROM factory.operation WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`,
      ).toHaveLength(0);
      expect(
        await f.database
          .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
      ).toHaveLength(0);
      const [thread] = await f.database.client<{ state: string }[]>`
        SELECT state FROM factory.review_feedback WHERE id=${feedbackID}`;
      expect(thread?.state).toBe(feedbackState);
      const independent = await additionalTicket(f, true);
      try {
        const queue = createDeliveryCoordination(f.database);
        expect(await queue.claim(f.projectID, independent.changeID)).toBe(true);
        await queue.release(independent.changeID);
      } finally {
        await independent.dispose();
      }
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

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
        await sql`DELETE FROM factory.operation WHERE kind='tickets.implementation_order' AND scope_type='ticket' AND scope_id=${ticketID}`;
        await sql`DELETE FROM factory.operation WHERE kind='project.delivery_queue' AND payload->>'changeId' IN (SELECT id::text FROM factory.change WHERE ticket_id=${ticketID})`;
        await sql`DELETE FROM factory.operation WHERE kind='delivery.branch_create' AND scope_type='change' AND scope_id IN (SELECT id::text FROM factory.change WHERE ticket_id=${ticketID})`;
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
    .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,result,created_by,completed_at)
    VALUES(${crypto.randomUUID()},'delivery.merge','change',${f.changeID},
      ${`delivery.merge:owned-merge:${f.changeID}`},NULL,'succeeded',
      jsonb_build_object(
        'changeId',${f.changeID}::text,'commitSha',${f.commit}::text,'baseSha',${"a".repeat(40)}::text,
        'pullRequestNumber',1,'approvalId',${approvalID}::text,'deliveryPolicyId',NULL::text
      ),
      jsonb_build_object('mergeSha',${f.commit}::text),${f.userID},now())`;
  await f.database
    .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by,completed_at)
    VALUES(${crypto.randomUUID()},'delivery.promotion','change',${f.changeID},
      ${`delivery.promotion:${f.changeID}:1`},NULL,${promotion},
      jsonb_build_object(
        'changeId',${f.changeID}::text,'projectId',${f.projectID}::text,'commitSha',${f.commit}::text,
        'previousRuntimeAttemptId',NULL::text,'replacementRuntimeAttemptId',NULL::text,
        'ordinal',1,'supersedesId',NULL::text,'retryCommandId',NULL::text
      ),${f.userID},now())`;
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
    expect(actions).toEqual(["git-prepare-integration"]);
    expect(await integration.reconcile(f.changeID, main)).toBe(true);
    expect(actions).toEqual(["git-prepare-integration", "git-observe-commit", "git-push"]);
    const [commit] = await f.database.client<
      { base: string; isMerge: boolean; state: string }[]
    >`SELECT integration_base_sha AS base,
      is_merge AS "isMerge",state FROM factory.change_commit_operation WHERE change_id=${f.changeID} AND source='integration'`;
    expect(commit).toEqual({ base: main, isMerge: true, state: "succeeded" });
    await expect(
      Promise.resolve(f.database.client`
      UPDATE factory.change_commit_operation SET integration_base_sha=${"c".repeat(40)}
      WHERE change_id=${f.changeID} AND source='integration'
    `),
    ).rejects.toThrow("immutable");
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
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,created_by,state,completed_at)
      VALUES(${verificationID},${f.changeID},${integrated},1,2,${f.userID},'succeeded',now())`;
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
        >`SELECT operation.state FROM factory.operation operation
        JOIN factory.change change ON change.id::text=operation.scope_id
        WHERE operation.kind='delivery.branch_create' AND operation.scope_type='change'
          AND change.ticket_id=${dependent.ticketID}`;
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
    >`SELECT state,payload->>'sourceSha' AS source FROM factory.operation WHERE kind='tickets.implementation_order' AND id=${commandID}`;
    expect(order).toEqual({ state: "started", source: "a".repeat(40) });
  } finally {
    await dependent.dispose();
    await f.dispose();
  }
}, 60_000);

test("implementation dispatcher cancels obsolete commands and retains blocked or unknown outcomes without planning idle Tickets", async () => {
  const f = await candidateReviewFixture();
  const tickets: Awaited<ReturnType<typeof additionalTicket>>[] = [];
  const epicID = crypto.randomUUID();
  const commands: {
    ticketID: string;
    commandID: string;
    revisionID: string;
    reasoning: string | undefined;
  }[] = [];
  let admissions = 0;
  try {
    await f.database.client`INSERT INTO factory.epic(id,project_id,title,created_by)
      VALUES(${epicID},${f.projectID},'Owned converted intent',${f.userID})`;
    const states = [
      "trashed",
      "cancelled",
      "done",
      "converted",
      "blocked",
      "unknown",
      "idle",
    ] as const;
    for (const state of states) {
      const saved = await additionalTicket(f);
      tickets.push(saved);
      if (state === "trashed")
        await f.database
          .client`UPDATE factory.ticket SET trashed_at=now() WHERE id=${saved.ticketID}`;
      else if (state === "cancelled" || state === "done")
        await f.database
          .client`UPDATE factory.ticket SET state=${state} WHERE id=${saved.ticketID}`;
      else if (state === "converted")
        await f.database
          .client`UPDATE factory.ticket SET converted_to_epic_id=${epicID} WHERE id=${saved.ticketID}`;
      if (state !== "idle")
        await f.database
          .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
          VALUES(${saved.ticketID},'tickets.implementation_order','ticket',${saved.ticketID},
            ${`tickets.implementation_order:${saved.ticketID}`},
            ${`tickets.implementation_order:${saved.ticketID}`},'waiting',
            ${JSON.stringify({
              commandId: saved.ticketID,
              projectId: f.projectID,
              ticketId: saved.ticketID,
              createdBy: f.userID,
              requirementRevisionId: saved.revisionID,
              technicalDesignRevisionId: null,
              codingReasoning: "high",
              sourceSha: "a".repeat(40),
              changeId: null,
              cancelledBy: null,
              cancelledAt: null,
              lastError: null,
            })}::text::jsonb,${f.userID})`;
    }
    const blocked = fixtureValue(tickets[4], "blocked");
    const unknown = fixtureValue(tickets[5], "unknown");
    const dispatcher = createImplementationOrders(
      f.database,
      {
        async start(ticketID, userID, input) {
          expect(userID).toBe(f.userID);
          if (!input?.commandID || !input.revisionID)
            throw new Error("Explicit saved command required");
          commands.push({
            ticketID,
            commandID: input.commandID,
            revisionID: input.revisionID,
            reasoning: input.codingReasoning,
          });
          if (ticketID === blocked.ticketID) throw new CommandError("forbidden", "x".repeat(2100));
          expect(ticketID).toBe(unknown.ticketID);
          throw new Error("Owned external acknowledgement is unknown");
        },
      },
      {
        async admitStartIn() {
          admissions++;
        },
      },
    );
    await Promise.all([dispatcher.reconcile(), dispatcher.reconcile()]);
    expect(commands).toEqual(
      [blocked, unknown].map((saved) => ({
        ticketID: saved.ticketID,
        commandID: saved.ticketID,
        revisionID: saved.revisionID,
        reasoning: "high",
      })),
    );
    for (const saved of tickets.slice(0, 4)) {
      const [order] = await f.database.client`
        SELECT state,payload->>'cancelledAt' AS at,payload->>'sourceSha' AS source,
          payload->>'requirementRevisionId' AS revision
        FROM factory.operation WHERE kind='tickets.implementation_order' AND id=${saved.ticketID}`;
      expect(order).toMatchObject({
        state: "cancelled",
        source: "a".repeat(40),
        revision: saved.revisionID,
      });
      expect(order?.["at"]).toBeTruthy();
    }
    const [rejected] = await f.database
      .client`SELECT state,error AS last_error FROM factory.operation WHERE kind='tickets.implementation_order' AND id=${blocked.ticketID}`;
    expect(rejected).toEqual({ state: "blocked", last_error: "x".repeat(2000) });
    const readUnknown = async () =>
      (
        await f.database.client`
      SELECT state,error AS last_error,updated_at,payload->>'sourceSha' AS source_sha,created_by
      FROM factory.operation WHERE kind='tickets.implementation_order' AND id=${unknown.ticketID}`
      )[0];
    const retained = await readUnknown();
    expect(retained).toMatchObject({
      state: "waiting",
      source_sha: "a".repeat(40),
      created_by: f.userID,
      last_error:
        "Implementation start is unconfirmed. Factory will reconcile this retained order.",
    });
    await dispatcher.reconcile();
    expect(await readUnknown()).toEqual(retained);
    expect(commands.at(-1)).toEqual(commands[1]);
    expect(commands).toHaveLength(3);
    expect(admissions).toBe(0);
    expect(
      await f.database
        .client`SELECT id FROM factory.change WHERE ticket_id=ANY(${tickets.map((saved) => saved.ticketID)}::uuid[])`,
    ).toHaveLength(0);
  } finally {
    try {
      for (const saved of tickets) await saved.dispose();
      await f.database
        .client`DELETE FROM factory.epic WHERE id=${epicID} AND project_id=${f.projectID}`;
    } finally {
      await f.dispose();
    }
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
    >`SELECT payload->>'changeId' AS id FROM factory.operation WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`}`;
    expect(slot?.id).toBe(other.changeID);
  } finally {
    await other.dispose();
    await f.dispose();
  }
}, 60_000);

test("ordinary delegated Delivery merges the reviewed commit and keeps healthy Staging until its replacement is ready", async () => {
  const owned = await candidateReviewFixture();
  const database = owned.database;
  let native: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  let controller: ReturnType<typeof createDeliveryController> | undefined;
  try {
    const f = owned;
    const other = await additionalTicket(f, true);
    const jobs = await nativeJobsFixture(database, f.projectID);
    native = jobs;
    await passingReview(f);
    await retainedPR(f);
    const { queue } = await enable(f);
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'delivery.staging_preview','project',${f.projectID},
        ${`delivery.staging_preview:${f.projectID}`},'pending',
        ${JSON.stringify({
          projectId: f.projectID,
          revision: "a".repeat(40),
          runtimeAttemptId: null,
        })}::text::jsonb)`;
    const previous = await jobs.startStaging(f.userID);
    await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${previous}`;
    const paused: string[] = [];
    const d = delivery(f, true, undefined, {
      startVerification: async () => {
        throw Error("Completed exact checks must not commission another native job");
      },
      startStagingReplacement: async (id, userID) => {
        await jobs.startStaging(userID, id);
        return null;
      },
      pause: async (id) => {
        expect(id).toBe(f.attemptID);
        paused.push(id);
        return null;
      },
      stop: async (id) => {
        expect(id).not.toBe(f.attemptID);
        await jobs.stop(id);
        return null;
      },
    });
    controller = d.controller;
    await d.controller.reconcile(f.changeID);
    await d.controller.reconcile(f.changeID);
    expect(d.merges()).toBe(1);
    const [promotion] = await f.database.client<
      { id: string; replacement: string }[]
    >`SELECT id,payload->>'replacementRuntimeAttemptId' AS replacement
      FROM factory.operation WHERE kind='delivery.promotion' AND scope_type='change' AND scope_id=${f.changeID}`;
    expect(promotion).toBeDefined();
    const replacement = fixtureValue(promotion, "promotion").replacement;
    expect(replacement).not.toBe(previous);
    await d.controller.reconcile(f.changeID);
    const [stillHealthy] = await f.database.client<
      { id: string }[]
    >`SELECT payload->>'runtimeAttemptId' AS id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}`;
    expect(stillHealthy?.id).toBe(previous);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(false);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${replacement}`;
    await d.controller.reconcile(f.changeID);
    const [delivered] = await f.database.client<
      { state: string; revision: string }[]
    >`SELECT ticket.state,preview.payload->>'revision' AS revision
      FROM factory.ticket ticket
      JOIN factory.operation preview ON preview.kind='delivery.staging_preview'
        AND preview.scope_type='project' AND preview.scope_id=ticket.project_id::text
      WHERE ticket.id=${f.ticketID}`;
    expect(delivered).toEqual({ state: "done", revision: f.commit });
    expect(paused).toEqual([f.attemptID]);
    expect(await queue.claim(f.projectID, other.changeID)).toBe(true);
    expect(jobs.calls.filter((call) => call.method === "CreateActor")).toHaveLength(2);
    expect(jobs.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(1);
    const [retired] = await database.client`SELECT deleted_at IS NOT NULL AS confirmed
      FROM factory.runtime_attempt WHERE id=${previous}`;
    expect(retired).toEqual({ confirmed: true });
  } finally {
    try {
      await controller?.close();
      await native?.close();
      await owned.dispose();
    } finally {
      owned?.restoreEnvironment();
    }
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
        >`SELECT state FROM factory.operation WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`;
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
      async () => f.database.client<{ state: string }[]>`SELECT state FROM factory.operation
      WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID} ORDER BY created_at,id`,
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
        .client`SELECT id FROM factory.operation WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`}`,
    ).toHaveLength(0);
    await owner`SELECT pg_advisory_unlock(hashtextextended(${key},0))`;
    await d.controller.reconcile(f.changeID);
    expect(
      await f.database
        .client`SELECT id FROM factory.operation WHERE kind='project.delivery_queue' AND idempotency_key=${`project.delivery_queue:${f.projectID}`}`,
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
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${crypto.randomUUID()},'delivery.merge','change',${f.changeID},
        ${`delivery.merge:uncertain:${f.changeID}`},${`delivery.merge:${f.changeID}`},'ambiguous',
        jsonb_build_object(
          'changeId',${f.changeID}::text,'commitSha',${f.commit}::text,'baseSha',${"a".repeat(40)}::text,
          'pullRequestNumber',1,'approvalId',${approvalID}::text,'deliveryPolicyId',${policyId}::text
        ),${f.userID})`;
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
    >`SELECT state FROM factory.operation WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`;
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
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
        VALUES(${crypto.randomUUID()},'delivery.merge','change',${f.changeID},
          ${`delivery.merge:uncertain:${f.changeID}`},${`delivery.merge:${f.changeID}`},'ambiguous',
          jsonb_build_object(
            'changeId',${f.changeID}::text,'commitSha',${f.commit}::text,'baseSha',${"a".repeat(40)}::text,
            'pullRequestNumber',1,'approvalId',${approvalID}::text,'deliveryPolicyId',NULL::text
          ),${f.userID})`;
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
        pause: async () => {
          throw new Error("An unconfirmed merge must not pause Coding compute");
        },
        stop: async () => null,
      },
      { prompt: async () => null },
      async () => {},
      { client: forge, owner: "owned" },
    );
    await controller.reconcile(f.changeID);
    const [row] = await f.database.client<
      { state: string; completedAt: string | null }[]
    >`SELECT state,completed_at AS "completedAt" FROM factory.operation WHERE kind='delivery.merge' AND scope_type='change' AND scope_id=${f.changeID}`;
    expect(row).toEqual({ state: "ambiguous", completedAt: null });
    expect(await createDeliveryCoordination(f.database).claim(f.projectID, other.changeID)).toBe(
      false,
    );
  } finally {
    await other.dispose();
    await f.dispose();
  }
}, 60_000);
