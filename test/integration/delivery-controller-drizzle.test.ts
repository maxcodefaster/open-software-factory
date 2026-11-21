import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql as query } from "drizzle-orm";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import {
  createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../packages/db/src/client";
import { candidateReview } from "../../packages/db/src/schema";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { verificationReceipt } from "../fixtures/verification";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

async function fixture() {
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = target.url;
  const database = createDatabase(4);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    ticketID = crypto.randomUUID();
  const changeID = crypto.randomUUID(),
    revisionID = crypto.randomUUID(),
    approvalID = crypto.randomUUID();
  const verificationID = crypto.randomUUID(),
    reviewID = crypto.randomUUID();
  const baseSHA = "a".repeat(40),
    commitSHA = "b".repeat(40);
  const branchName = `factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`;
  const content = canonicalRequirementContent({
    summary: "Owned Delivery Drizzle regression",
    acceptanceCriteria: ["The exact reviewed candidate can be delivered"],
    nonGoals: [],
  });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const controllers: ReturnType<typeof createDeliveryController>[] = [];
  let status = "waiting",
    base = baseSHA,
    merges = 0,
    starts = 0,
    reviews = 0,
    registrations = 0,
    observations = 0;
  let candidateHead = commitSHA,
    candidateMerged = false;
  let beforeRegistration: (() => Promise<void>) | undefined;
  let beforeRevocation: (() => Promise<void>) | undefined;
  let rejectRevocation = false;
  const revoked: number[] = [];
  const pullRequest = () => ({
    number: 1,
    url: "https://forge.invalid/owned/delivery/pulls/1",
    headSha: candidateHead,
    merged: candidateMerged,
    state: "open",
    baseBranch: "main",
    baseSha: base,
    headBranch: branchName,
  });
  const forge = {
    ...createForgejoClient({ apiURL: "http://127.0.0.1:9/api/v1/", token: "owned-unused" }),
    getFile: async () => "owned protected workflow",
    ensureDefaultBranchProtection: async () => {},
    ensurePullRequest: async () => {
      const [intent] = await database.client`SELECT id FROM factory.pull_request_operation
        WHERE change_id=${changeID} AND state='executing'`;
      expect(intent).toBeDefined();
      return pullRequest();
    },
    getPullRequest: async () => pullRequest(),
    getDefaultBranch: async () => ({ name: "main", headSha: base }),
    listActionRuns: async () => {
      observations++;
      return [
        {
          id: 1,
          workflowID: "factory-verification.yml",
          event: "pull_request",
          status,
          commitSha: commitSHA,
          url: "https://forge.invalid/owned/delivery/actions/runs/1",
        },
      ];
    },
    registerEphemeralRunner: async () => {
      const [intent] = await database.client`SELECT id,commit_sha AS commit,created_by AS actor
        FROM factory.verification WHERE change_id=${changeID} AND commit_sha=${commitSHA}`;
      expect(intent).toMatchObject({ commit: commitSHA, actor: userID });
      registrations++;
      await beforeRegistration?.();
      return { id: 42, uuid: crypto.randomUUID(), token: "owned-private-runner-token" };
    },
    deleteRunner: async (_repository: unknown, id: number) => {
      revoked.push(id);
      await beforeRevocation?.();
      if (rejectRevocation) throw new Error("Owned revocation unavailable");
    },
    observeVerification: async () => verificationReceipt(commitSHA),
    listFiles: async (_repository: unknown, ref: string) => [
      { path: "src/app.ts", sha: ref === baseSHA ? "c".repeat(40) : "d".repeat(40) },
    ],
    mergeFastForward: async () => {
      merges++;
      base = commitSHA;
      return { headSha: base };
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  function controller(connection = database) {
    const delivery = createDeliveryController(
      connection,
      {
        startVerification: async () => {
          starts++;
          return null;
        },
        startStagingReplacement: async () => null,
        stop: async () => null,
      },
      {
        prompt: async () => {
          throw new Error("This offline proof must not dispatch Coding");
        },
        review: async () => {
          reviews++;
        },
      },
      async () => {},
      { client: forge, owner: "owned" },
    );
    controllers.push(delivery);
    return delivery;
  }
  async function seedVerification(state: "running" | "succeeded" | "cancelled" = "running") {
    await database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,state,completed_at,created_by)
      VALUES(${verificationID},${changeID},${commitSHA},1,'owned-delivery',1,${state}::factory.verification_state,
        CASE WHEN ${state} IN ('succeeded','cancelled') THEN now() ELSE NULL END,${userID})`;
  }
  async function seedReview(
    delivery = "ordinary",
    ordinal = 1,
    state: "passed" | "changes-requested" | "incomplete" = "passed",
    findingSourceID: string | null = null,
    focusReviewID: string | null = null,
  ) {
    const id = ordinal === 1 ? reviewID : crypto.randomUUID(),
      turnID = crypto.randomUUID();
    await database.client`INSERT INTO factory.agent_turn(
      id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state)
      VALUES(${turnID},${turnID},${projectID},${ticketID},${changeID},${userID},
        '{"kind":"change-review"}',${digest(turnID)},
        ${JSON.stringify({ mode: "build", review: {}, requirementRevisionId: revisionID })}::jsonb,'completed')`;
    await database.client`INSERT INTO factory.candidate_review(
      id,verification_id,ordinal,change_id,commit_sha,base_sha,created_by,turn_id,state,result,completed_at,
      finding_source_id,focus_review_id,ui_required,evidence,coverage_version)
      VALUES(${id},${verificationID},${ordinal},${changeID},${commitSHA},${baseSHA},${userID},${turnID},${state},
        ${JSON.stringify({
          verdict: state,
          delivery,
          summary: "Owned independent review",
          criteria: [{ criterion: 1, status: "passed", evidence: "Owned exact candidate checked" }],
          findings:
            state === "changes-requested"
              ? [
                  {
                    severity: "blocking",
                    title: "Owned bounded defect",
                    explanation: "Owned reproducible defect",
                    path: "src/app.ts",
                    reproduction: "Run the owned regression",
                  },
                ]
              : [],
          ui: "not-applicable",
        })}::jsonb,now(),${findingSourceID},${focusReviewID},${state === "changes-requested"},
          ${JSON.stringify(state === "changes-requested" ? [{ kind: "owned" }] : [])}::jsonb,
          ${state === "changes-requested" ? 2 : 1})`;
    return id;
  }
  async function dispose() {
    try {
      await Promise.all(controllers.map((delivery) => delivery.close()));
    } finally {
      await database.client.end({ timeout: 2 });
      await target.dispose();
    }
  }
  try {
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${userID},'Owned Delivery',${`${userID}@delivery.invalid`},true)`;
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${`delivery-${projectID}`},'Owned Delivery','https://forge.invalid/owned/delivery.git',
          'main','.devcontainer/devcontainer.json',${userID})`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by,manage_project)
        VALUES(${projectID},${userID},'developer',${userID},true)`;
      await sql`INSERT INTO factory.ticket(id,project_id,title,created_by)
        VALUES(${ticketID},${projectID},'Owned Delivery',${userID})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${revisionID},${ticketID},1,${content},${digest(content)},${userID})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
        VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
        VALUES(${changeID},${projectID},${ticketID},${approvalID},${branchName},${baseSHA},'active',${userID})`;
      await sql`INSERT INTO factory.change_commit_operation(
        id,change_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,
        idempotency_key,state,created_by,completed_at,source,repository_path,repository_blob_sha,repository_content,content_digest)
        VALUES(${crypto.randomUUID()},${changeID},1,${branchName},${baseSHA},${commitSHA},${commitSHA},
          'Owned candidate',${crypto.randomUUID()},'succeeded',${userID},now(),'repository-document',
          'README.md',${baseSHA},${content},${digest(content)})`;
    });
    return {
      database,
      controller,
      changeID,
      projectID,
      ticketID,
      revisionID,
      userID,
      verificationID,
      reviewID,
      commitSHA,
      baseSHA,
      seedVerification,
      seedReview,
      dispose,
      revoked,
      merges: () => merges,
      starts: () => starts,
      reviews: () => reviews,
      registrations: () => registrations,
      observations: () => observations,
      candidate: (headSHA: string, merged: boolean) => {
        candidateHead = headSHA;
        candidateMerged = merged;
      },
      status: (value: string) => {
        status = value;
      },
      onRegistration: (operation: () => Promise<void>) => {
        beforeRegistration = operation;
      },
      onRevocation: (operation: () => Promise<void>) => {
        beforeRevocation = operation;
      },
      rejectRevocation: (value: boolean) => {
        rejectRevocation = value;
      },
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

test("PR and Verification intents precede external work and retries retain their identities", async () => {
  const f = await fixture();
  try {
    const delivery = f.controller();
    await delivery.reconcile(f.changeID);
    const [first] = await f.database.client<
      { id: string; runner: string | null }[]
    >`SELECT id,runner_id::text AS runner FROM factory.verification
      WHERE change_id=${f.changeID}`;
    expect(first?.runner).toBe("42");
    expect(f.starts()).toBe(1);
    expect(f.registrations()).toBe(1);
    await delivery.reconcile(f.changeID);
    const [second] = await f.database.client<
      { id: string }[]
    >`SELECT id FROM factory.verification WHERE change_id=${f.changeID}`;
    expect(second?.id).toBe(first?.id);
    expect(f.registrations()).toBe(1);
    expect(
      await f.database
        .client`SELECT id FROM factory.pull_request_operation WHERE change_id=${f.changeID}`,
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test.each(["moved", "merged"] as const)(
  "Verification does not observe or start checks for a %s PR candidate",
  async (candidate) => {
    const f = await fixture();
    try {
      f.candidate(candidate === "moved" ? "c".repeat(40) : f.commitSHA, candidate === "merged");
      await f.controller().reconcile(f.changeID);
      expect(
        await f.database.client`SELECT id FROM factory.verification WHERE change_id=${f.changeID}`,
      ).toHaveLength(0);
      expect(f.observations()).toBe(0);
      expect(f.registrations()).toBe(0);
      expect(f.starts()).toBe(0);
      expect(f.reviews()).toBe(0);
      expect(f.merges()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
);

test("superseded Verification cleanup retains the current candidate and its registered runner", async () => {
  const f = await fixture();
  try {
    await f.seedVerification();
    await f.database.client`UPDATE factory.verification SET runner_id=99,
      runner_uuid=${crypto.randomUUID()},runner_token='owned-current-runner'
      WHERE id=${f.verificationID}`;
    const previousID = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,runner_id,state,created_by)
      VALUES(${previousID},${f.changeID},${"c".repeat(40)},1,'owned-superseded',42,'running',${f.userID})`;
    const delivery = f.controller();
    await delivery.reconcile(f.changeID);
    const [previous] = await f.database.client`SELECT state,runner_id::text AS runner
      FROM factory.verification WHERE id=${previousID}`;
    const [current] = await f.database
      .client`SELECT state,runner_id::text AS runner,commit_sha AS commit
      FROM factory.verification WHERE id=${f.verificationID}`;
    expect(previous).toEqual({ state: "cancelled", runner: null });
    expect(current).toEqual({
      state: "runner-starting",
      runner: "99",
      commit: f.commitSHA,
    });
    expect(f.revoked).toEqual([42]);
    expect(f.registrations()).toBe(0);
    expect(f.starts()).toBe(1);
    await delivery.reconcile(f.changeID);
    expect(f.revoked).toEqual([42]);
  } finally {
    await f.dispose();
  }
});

test("Trash waits for in-flight Verification registration and revokes its late runner before returning", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let reconciliation: Promise<void> | undefined, stopping: Promise<void> | undefined;
  try {
    const delivery = f.controller();
    f.onRegistration(async () => {
      await f.database.client`UPDATE factory.ticket SET trashed_at=now(),trashed_by=${f.userID}
        WHERE id=${f.ticketID}`;
      await delivery.cancel(f.changeID);
      entered.resolve();
      await release.promise;
    });
    reconciliation = delivery.reconcile(f.changeID);
    await Promise.race([
      entered.promise,
      reconciliation.then(() => {
        throw new Error("Verification did not reach the owned registration boundary");
      }),
    ]);
    let stopped = false;
    stopping = delivery.stopForTrash(f.changeID).then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([reconciliation, stopping]);
    const [verification] = await f.database.client`SELECT state,runner_id::text AS runner
      FROM factory.verification WHERE change_id=${f.changeID}`;
    expect(verification).toEqual({ state: "cancelled", runner: null });
    expect(f.revoked).toEqual([42]);
    expect(f.starts()).toBe(0);
    expect(f.reviews()).toBe(0);
  } finally {
    release.resolve();
    await Promise.all([reconciliation, stopping].map((work) => work?.catch(() => undefined)));
    await f.dispose();
  }
});

test("late runner registration retains a cancelled outcome for failed revocation and later cleanup", async () => {
  const f = await fixture();
  try {
    f.onRegistration(async () => {
      await f.database.client`UPDATE factory.verification SET state='cancelled',completed_at=now()
        WHERE change_id=${f.changeID}`;
    });
    f.rejectRevocation(true);
    const delivery = f.controller();
    await delivery.reconcile(f.changeID);
    const [late] = await f.database
      .client`SELECT runner_id::text AS runner,state FROM factory.verification
      WHERE change_id=${f.changeID}`;
    expect(late).toEqual({ runner: "42", state: "cancelled" });
    expect(f.starts()).toBe(0);
    f.rejectRevocation(false);
    await delivery.cancel(f.changeID);
    expect(f.revoked).toEqual([42, 42]);
    const [cleaned] = await f.database.client<
      { runner_id: string | null }[]
    >`SELECT runner_id FROM factory.verification WHERE change_id=${f.changeID}`;
    expect(cleaned?.runner_id).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("runner CAS leaves a competing registration intact", async () => {
  const f = await fixture();
  try {
    f.onRegistration(async () => {
      await f.database
        .client`UPDATE factory.verification SET runner_id=99,runner_uuid=${crypto.randomUUID()},
        runner_token='owned-newer-token' WHERE change_id=${f.changeID}`;
    });
    await f.controller().reconcile(f.changeID);
    const [current] = await f.database.client`SELECT runner_id::text AS runner,runner_token AS token
      FROM factory.verification WHERE change_id=${f.changeID}`;
    expect(current).toEqual({ runner: "99", token: "owned-newer-token" });
    expect(f.revoked).toEqual([42]);
    expect(f.starts()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("a failed typed runner write never publishes its token in the saved failure", async () => {
  const f = await fixture();
  try {
    const client = new Proxy(f.database.client, {
      get(target, key) {
        if (key !== "unsafe") return Reflect.get(target, key);
        return (...args: Parameters<typeof target.unsafe>) => {
          if (
            args[0].startsWith('update "factory"."verification"') &&
            args[0].includes('"runner_token"')
          )
            throw new Error("Owned driver rejected the runner write");
          return target.unsafe(...args);
        };
      },
    });
    await f.controller({ ...f.database, client }).reconcile(f.changeID);
    const [saved] = await f.database.client<
      { failure: string }[]
    >`SELECT failure FROM factory.change
      WHERE id=${f.changeID}`;
    expect(saved?.failure).toBe("Owned driver rejected the runner write");
    expect(saved?.failure).not.toContain("owned-private-runner-token");
    expect(f.starts()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("repeated cancellation preserves microsecond completion time and revocation CAS", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("cancelled");
    await f.database.client`UPDATE factory.verification SET runner_id=42,
      completed_at='2026-11-20 01:02:03.123456+00' WHERE id=${f.verificationID}`;
    f.onRevocation(async () => {
      await f.database
        .client`UPDATE factory.verification SET runner_id=99 WHERE id=${f.verificationID}`;
    });
    await f.controller().cancel(f.changeID);
    const [current] = await f.database
      .client`SELECT runner_id::text AS runner,completed_at::text AS completed
      FROM factory.verification WHERE id=${f.verificationID}`;
    expect(current).toEqual({ runner: "99", completed: "2026-11-20 01:02:03.123456+00" });
  } finally {
    await f.dispose();
  }
});

test.each([0, 11_800])(
  "successful check receipts retain diagnosis at %s characters and respect the native byte limit",
  async (retainedSize) => {
    const f = await fixture();
    try {
      await f.seedVerification();
      const diagnosis = {
        kind: "execution-failed",
        summary: "Historical execution failure",
        jobs: [],
        retained: "é".repeat(retainedSize),
      };
      await f.database
        .client`UPDATE factory.verification SET diagnosis=${JSON.stringify(diagnosis)}::jsonb
      WHERE id=${f.verificationID}`;
      f.status("success");
      await f.controller().reconcile(f.changeID);
      const [observed] = await f.database.client<{ state: string; diagnosis: unknown }[]>`
      SELECT state,diagnosis FROM factory.verification WHERE id=${f.verificationID}`;
      expect(observed?.state).toBe("succeeded");
      if (retainedSize) expect(observed?.diagnosis).toEqual(diagnosis);
      else
        expect(observed?.diagnosis).toMatchObject({
          ...diagnosis,
          receipt: { commit: f.commitSHA },
        });
      expect(f.reviews()).toBe(1);
    } finally {
      await f.dispose();
    }
  },
);

test.each([
  { reviewDelivery: "human-required", message: "This review requires a human Delivery decision." },
  {
    reviewDelivery: "ordinary",
    message: "Human editing requires human Delivery approval for this Change.",
  },
])(
  "delegation cannot bypass $reviewDelivery review or retained human editing",
  async ({ reviewDelivery, message }) => {
    const f = await fixture();
    try {
      await f.seedVerification("succeeded");
      await f.seedReview(reviewDelivery);
      const delivery = f.controller();
      const settings = await delivery.configure(f.projectID, f.userID, {
        commandId: crypto.randomUUID(),
        expectedPolicyId: null,
        enabled: true,
      });
      const policyID = settings.policyId;
      if (!policyID) throw new Error("Owned explicit delegation was not retained");
      await expect(delivery.approve(f.changeID, f.userID, undefined, policyID)).rejects.toThrow(
        message,
      );
      expect(
        await f.database
          .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
      ).toHaveLength(0);
      expect(f.merges()).toBe(0);
      await delivery.configure(f.projectID, f.userID, {
        commandId: crypto.randomUUID(),
        expectedPolicyId: policyID,
        enabled: false,
      });
      await expect(delivery.approve(f.changeID, f.userID, undefined, policyID)).rejects.toThrow(
        "Automatic Delivery delegation is no longer active.",
      );
    } finally {
      await f.dispose();
    }
  },
);

test("checks-resume command replay preserves its exact native input and refuses a changed Stop", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    await f.seedReview();
    const commandID = crypto.randomUUID(),
      stopID = crypto.randomUUID();
    const input = { changeID: f.changeID, verificationID: f.verificationID, stopID };
    await f.database
      .client`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
      VALUES(${commandID},${`checks-resume:${f.changeID}`},${f.userID},${JSON.stringify(input)}::jsonb,'{}'::jsonb)`;
    const delivery = f.controller();
    await delivery.resumeChecks(f.changeID, f.userID, commandID, f.verificationID, stopID);
    await expect(
      delivery.resumeChecks(f.changeID, f.userID, commandID, f.verificationID, crypto.randomUUID()),
    ).rejects.toThrow("Checks resume changed target");
    const [recorded] = await f.database.client<{ input: typeof input }[]>`SELECT input
      FROM factory.execution_policy_command WHERE command_id=${commandID}`;
    expect(recorded?.input).toEqual(input);
    expect(f.starts()).toBe(0);
    expect(f.reviews()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("typed approval and atomic merge selection share one transaction and roll back together", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    await f.seedReview();
    let visibleApprovals = 0;
    const client = new Proxy(f.database.client, {
      get(target, key) {
        if (key !== "begin") return Reflect.get(target, key);
        return (operation: (sql: DatabaseTransaction) => Promise<unknown>) =>
          target.begin((transaction) =>
            operation(
              new Proxy(transaction, {
                get(sql, key) {
                  if (key !== "unsafe") return Reflect.get(sql, key);
                  return (...args: Parameters<typeof sql.unsafe>) => {
                    if (args[0].startsWith('insert into "factory"."merge_operation"')) {
                      return (async () => {
                        const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count
                          FROM factory.delivery_approval WHERE change_id=${f.changeID}`;
                        visibleApprovals = row?.count ?? 0;
                        throw new Error("Owned failure after typed approval");
                      })();
                    }
                    return sql.unsafe(...args);
                  };
                },
              }),
            ),
          );
      },
    });
    const failure = await f
      .controller({ ...f.database, client })
      .approve(f.changeID, f.userID)
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(failure).toMatchObject({ cause: { message: "Owned failure after typed approval" } });
    expect(visibleApprovals).toBe(1);
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT id FROM factory.merge_operation WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    expect(f.merges()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("approval rejects a newer incomplete review and later admits only the current exact review", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    await f.seedReview();
    const newerID = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.candidate_review(
      id,verification_id,ordinal,change_id,commit_sha,base_sha,created_by,state,completed_at)
      VALUES(${newerID},${f.verificationID},2,${f.changeID},${f.commitSHA},${f.baseSHA},${f.userID},'incomplete',now())`;
    const delivery = f.controller();
    await expect(delivery.approve(f.changeID, f.userID)).rejects.toThrow(
      "Current commit is not eligible for delivery",
    );
    expect(
      await f.database
        .client`SELECT id FROM factory.delivery_approval WHERE change_id=${f.changeID}`,
    ).toHaveLength(0);
    const currentReviewID = await f.seedReview("human-required", 3);
    await delivery.approve(f.changeID, f.userID);
    await delivery.close();
    const [approval] = await f.database.client<
      { review: string }[]
    >`SELECT candidate_review_id AS review FROM factory.delivery_approval
      WHERE change_id=${f.changeID}`;
    expect(approval?.review).toBe(currentReviewID);
    expect(f.merges()).toBe(1);
    const [promotion] = await f.database.client<
      { sha: string }[]
    >`SELECT commit_sha AS sha FROM factory.promotion_operation
      WHERE change_id=${f.changeID}`;
    expect(promotion?.sha).toBe(f.commitSHA);
  } finally {
    await f.dispose();
  }
});

test("failed-correction aggregation counts acknowledged failed checks and reviews together", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    const sourceID = await f.seedReview("ordinary", 1, "changes-requested");
    await f.seedReview("ordinary", 2, "changes-requested", sourceID);
    await f.database
      .client`UPDATE factory.candidate_review SET repair_prompted_at=now() WHERE id=${sourceID}`;
    for (const commit of ["c".repeat(40), "d".repeat(40), "e".repeat(40)])
      await f.database.client`INSERT INTO factory.verification(
        id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,state,
        repair_prompted_at,completed_at,created_by)
        VALUES(${crypto.randomUUID()},${f.changeID},${commit},1,'owned-old-check',1,'failed',
          CASE WHEN ${commit}<>${"e".repeat(40)} THEN now() END,now(),${f.userID})`;
    await f.controller().reconcile(f.changeID);
    const [saved] = await f.database.client<
      { failure: string }[]
    >`SELECT failure FROM factory.change WHERE id=${f.changeID}`;
    expect(saved?.failure).toBe(
      "Automatic correction paused after three failed candidates. Review the findings and resume Build manually.",
    );
    expect(f.reviews()).toBe(0);
    expect(f.starts()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("atomic finding-check admission copies lineage but resets every fresh-review default", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    const sourceID = await f.seedReview("ordinary", 1, "changes-requested");
    const delivery = f.controller();
    await delivery.reconcile(f.changeID);
    const rows = await f.database.client<
      {
        id: string;
        ordinal: number;
        source: string | null;
        supersedes: string | null;
        state: string;
        result: unknown;
        evidence: unknown[];
        required: boolean;
        coverage: number;
        turn: string | null;
        command: string;
        repaired: string | null;
      }[]
    >`SELECT id,ordinal,finding_source_id AS source,supersedes_id AS supersedes,state,result,evidence,
      ui_required AS required,coverage_version AS coverage,turn_id AS turn,repair_command_id AS command,
      repair_prompted_at::text AS repaired FROM factory.candidate_review WHERE change_id=${f.changeID} ORDER BY ordinal`;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      ordinal: 2,
      source: sourceID,
      supersedes: null,
      state: "pending",
      result: null,
      evidence: [],
      required: false,
      coverage: 1,
      turn: null,
      repaired: null,
    });
    expect(rows[1]?.command).not.toBe(rows[0]?.command);
    expect(f.reviews()).toBe(1);
    await Promise.all([delivery.reconcile(f.changeID), delivery.reconcile(f.changeID)]);
    expect(
      await f.database
        .client`SELECT id FROM factory.candidate_review WHERE change_id=${f.changeID}`,
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("atomic incomplete-review retry retains exact source/focus identities and command replay", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    const sourceID = await f.seedReview("ordinary", 1, "changes-requested");
    const previousID = await f.seedReview("ordinary", 2, "incomplete", sourceID, sourceID);
    const commandID = crypto.randomUUID();
    const delivery = f.controller();
    await delivery.retryReview(f.changeID, f.userID, commandID, previousID);
    const reserved = await f.database.client.reserve();
    try {
      const rows = await drizzleTransaction(reserved)
        .select({
          id: candidateReview.id,
          source: candidateReview.findingSourceId,
          focus: candidateReview.focusReviewId,
          supersedes: candidateReview.supersedesId,
          state: candidateReview.state,
          result: candidateReview.result,
          turn: candidateReview.turnId,
          created: query<string>`${candidateReview.createdAt}::text`,
        })
        .from(candidateReview)
        .where(eq(candidateReview.id, commandID));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: commandID,
        source: sourceID,
        focus: sourceID,
        supersedes: previousID,
        state: "pending",
        result: null,
        turn: null,
      });
    } finally {
      reserved.release();
    }
    await delivery.retryReview(f.changeID, f.userID, commandID, previousID);
    expect(
      await f.database.client`SELECT id FROM factory.candidate_review WHERE id=${commandID}`,
    ).toHaveLength(1);
    await expect(delivery.retryReview(f.changeID, f.userID, commandID, sourceID)).rejects.toThrow(
      "Review retry changed target",
    );
  } finally {
    await f.dispose();
  }
});

test("atomic merge admission reuses the exact approval and preserves an existing Staging selection", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    const reviewID = await f.seedReview();
    const approvalID = crypto.randomUUID(),
      retainedRevision = "c".repeat(40);
    await f.database.client`INSERT INTO factory.delivery_approval(
      id,change_id,verification_id,commit_sha,approved_by,candidate_review_id,approved_at)
      VALUES(${approvalID},${f.changeID},${f.verificationID},${f.commitSHA},${f.userID},${reviewID},
        '2026-11-20 01:02:03.123456+00')`;
    await f.database
      .client`INSERT INTO factory.staging_preview(project_id,revision,created_at,updated_at)
      VALUES(${f.projectID},${retainedRevision},'2026-11-20 01:02:03.654321+00','2026-11-20 01:02:03.654321+00')`;
    const delivery = f.controller();
    await delivery.approve(f.changeID, f.userID);
    await delivery.close();
    const [merge] = await f.database.client<{ approval: string; key: string; state: string }[]>`
      SELECT delivery_approval_id AS approval,idempotency_key AS key,state FROM factory.merge_operation
      WHERE change_id=${f.changeID}`;
    expect(merge).toEqual({
      approval: approvalID,
      key: `change:${f.changeID}:merge:${approvalID}`,
      state: "succeeded",
    });
    const [staging] = await f.database.client<
      { revision: string; created: string; updated: string }[]
    >`
      SELECT revision,created_at::text AS created,updated_at::text AS updated FROM factory.staging_preview WHERE project_id=${f.projectID}`;
    expect(staging).toEqual({
      revision: retainedRevision,
      created: "2026-11-20 01:02:03.654321+00",
      updated: "2026-11-20 01:02:03.654321+00",
    });
    expect((await delivery.get(f.changeID))?.["approvedAt"]).toBe("2026-11-20 01:02:03.123456+00");
    expect(
      await f.database
        .client`SELECT id FROM factory.promotion_operation WHERE change_id=${f.changeID}`,
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("sweep keeps the native current-promotion view and cleans a cancelled candidate only while needed", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("cancelled");
    await f.database
      .client`UPDATE factory.verification SET runner_id=42 WHERE id=${f.verificationID}`;
    await f.database
      .client`UPDATE factory.change SET state='cancelled',cancelled_at=now() WHERE id=${f.changeID}`;
    const delivery = f.controller();
    await delivery.sweep();
    expect(f.revoked).toEqual([42]);
    await delivery.sweep();
    expect(f.revoked).toEqual([42]);
    expect(f.reviews()).toBe(0);
    expect(f.starts()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("latest focus-review selection uses PostgreSQL microseconds before ordinal tie-breaking", async () => {
  const f = await fixture();
  try {
    await f.seedVerification("succeeded");
    const historicalVerificationID = crypto.randomUUID(),
      previousCommit = "c".repeat(40);
    await f.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,state,completed_at,created_by)
      VALUES(${historicalVerificationID},${f.changeID},${previousCommit},1,'owned-previous',1,'succeeded',now(),${f.userID})`;
    const newerID = crypto.randomUUID();
    for (const [ordinal, id, created] of [
      [1, newerID, "2026-11-20 01:02:03.123456+00"],
      [2, crypto.randomUUID(), "2026-11-20 01:02:03.123455+00"],
    ] as const) {
      const turnID = crypto.randomUUID();
      await f.database.client`INSERT INTO factory.agent_turn(
        id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state)
        VALUES(${turnID},${turnID},${f.projectID},${f.ticketID},${f.changeID},${f.userID},
          '{"kind":"change-review"}',${"a".repeat(64)},
          ${JSON.stringify({ mode: "build", review: {}, requirementRevisionId: f.revisionID })}::jsonb,'completed')`;
      await f.database.client`INSERT INTO factory.candidate_review(
        id,verification_id,ordinal,change_id,commit_sha,base_sha,created_by,turn_id,state,result,created_at,completed_at)
        VALUES(${id},${historicalVerificationID},${ordinal},${f.changeID},${previousCommit},${f.baseSHA},
          ${f.userID},${turnID},'passed',${JSON.stringify({
            verdict: "passed",
            delivery: "ordinary",
            summary: "Owned prior exact review",
            criteria: [
              { criterion: 1, status: "passed", evidence: "Owned prior candidate checked" },
            ],
            findings: [],
            ui: "not-applicable",
          })}::jsonb,${created}::timestamptz,now())`;
    }
    await f.controller().reconcile(f.changeID);
    const [review] = await f.database.client<
      { focus: string }[]
    >`SELECT focus_review_id AS focus FROM factory.candidate_review
      WHERE verification_id=${f.verificationID}`;
    expect(review?.focus).toBe(newerID);
    const [retained] = await f.database.client<
      { created: string }[]
    >`SELECT created_at::text AS created
      FROM factory.candidate_review WHERE id=${newerID}`;
    expect(retained?.created).toBe("2026-11-20 01:02:03.123456+00");
  } finally {
    await f.dispose();
  }
});
