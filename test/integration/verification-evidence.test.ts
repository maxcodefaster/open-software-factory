import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createVerificationTools } from "../../apps/factory/src/agent/verification-tools";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import type { VerificationDiagnosis } from "../../packages/conversation-domain/src/verification";
import { verificationReceipt } from "../fixtures/verification";

test("competing reconcilers use one saved diagnosis and one admitted correction", async () => {
  const f = await candidateReviewFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const packets: string[] = [];
  let secondRun: Promise<void> | undefined;
  const first: VerificationDiagnosis = {
    kind: "check-failed",
    summary: "First observed validation failure",
    jobs: [
      { id: 8, attempt: 1, name: "Checks", step: 1, stepName: "test", output: "Expected 200" },
    ],
  };
  const later = { ...first, summary: "Later native attempt must not change the admitted packet" };
  const make = (diagnose: () => Promise<VerificationDiagnosis>) =>
    createDeliveryController(
      f.database,
      {
        startVerification: async () => null,
        startStagingReplacement: async () => null,
        stop: async () => null,
      },
      {
        prompt: async (changeID, text, userID, commandId) => {
          await createChangeAdmission(f.database, buildModelID).admit(changeID, userID, {
            kind: "change-repair",
            commandId,
            text,
          });
          packets.push(text);
        },
      },
      async () => {},
      {
        owner: "owned",
        client: {
          getPullRequest: async () => ({ number: 1, headSha: f.commit, merged: false }),
          listActionRuns: async () => [
            {
              id: 1,
              workflowID: "factory-verification.yml",
              event: "pull_request",
              status: "failure",
              url: "https://forge.invalid/owned/review/actions/runs/1",
            },
          ],
          diagnoseVerification: diagnose,
        } as unknown as ReturnType<typeof createForgejoClient>,
      },
    );
  try {
    await f.database
      .client`UPDATE factory.verification SET state='running',completed_at=NULL WHERE id=${f.verificationID}`;
    await f.database.client`INSERT INTO factory.pull_request_operation(
      id,change_id,repository_owner,repository_name,base_branch,head_branch,first_head_sha,
      title,body,idempotency_key,state,pull_request_number,pull_request_url,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','review','main',branch_name,${f.commit},
        'Owned concurrent diagnostics','','owned-concurrent-'||id,'succeeded',1,'https://forge.invalid/owned/review/pulls/1',now()
      FROM factory.change WHERE id=${f.changeID}`;
    secondRun = make(async () => {
      entered.resolve();
      await release.promise;
      return later;
    }).reconcile(f.changeID);
    await entered.promise;
    await make(async () => first).reconcile(f.changeID);
    release.resolve();
    await secondRun;
    expect(packets).toHaveLength(2);
    expect(packets[1]).toBe(packets[0]);
    expect(packets[0]).toContain(first.summary);
    expect(packets[0]).not.toContain(later.summary);
    const turns = await f.database
      .client`SELECT id FROM factory.agent_turn WHERE command_id=${f.verificationID}`;
    expect(turns).toHaveLength(1);
  } finally {
    release.resolve();
    await secondRun;
    await f.dispose();
  }
});

test("independent review cannot acquire implementation Verification tools", async () => {
  const f = await candidateReviewFixture();
  let reads = 0;
  try {
    const turn = await f.activeReview();
    const tools = createVerificationTools(f.database, {
      readVerificationLog: async () => {
        reads++;
        return { output: "must not be read", nextOffset: null };
      },
    } as unknown as ReturnType<typeof createForgejoClient>);
    expect(await tools.tools(turn.id)).toEqual([]);
    await expect(
      tools.call(turn.id, turn.ownerToken, {
        name: "verification_read",
        arguments: { verificationId: f.verificationID, jobId: 1, attempt: 1, step: 1 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(reads).toBe(0);
  } finally {
    await f.dispose();
  }
});

test.each(["check-failed", "execution-failed", "cancelled", "skipped", "unavailable"] as const)(
  "saved Verification diagnosis %s controls admission and survives lost repair acknowledgement",
  async (kind) => {
    const f = await candidateReviewFixture();
    const corrections: string[] = [];
    let reads = 0;
    let lost = true;
    let observedStatus: string = ["cancelled", "skipped"].includes(kind) ? kind : "failure";
    const diagnosis: VerificationDiagnosis = {
      kind,
      summary: `Owned ${kind} observation`,
      jobs:
        kind === "check-failed"
          ? [
              {
                id: 8,
                attempt: 2,
                name: "Validation",
                step: 1,
                stepName: "test",
                output: "Expected 200, received 500",
              },
            ]
          : [],
    };
    const forge = {
      observeVerification: async () => verificationReceipt(f.commit),
      listFiles: async () => [{ path: "src/app.ts", sha: f.commit }],
      getPullRequest: async () => ({ number: 1, headSha: f.commit, merged: false }),
      listActionRuns: async () => [
        {
          id: 1,
          workflowID: "factory-verification.yml",
          event: "pull_request",
          status: observedStatus,
          url: "https://forge.invalid/owned/review/actions/runs/1",
        },
      ],
      diagnoseVerification: async () => {
        reads++;
        return diagnosis;
      },
    } as unknown as ReturnType<typeof createForgejoClient>;
    const controller = createDeliveryController(
      f.database,
      {
        startVerification: async () => null,
        startStagingReplacement: async () => null,
        stop: async () => null,
      },
      {
        prompt: async (changeID, text, userID, commandId) => {
          const admitted = await createChangeAdmission(f.database, buildModelID).admit(
            changeID,
            userID,
            {
              kind: "change-repair",
              commandId,
              text,
            },
          );
          if (!admitted.replayed) corrections.push(text);
          if (lost) {
            lost = false;
            throw new Error("Owned lost repair acknowledgement");
          }
        },
      },
      async () => {},
      { client: forge, owner: "owned" },
    );
    try {
      await f.database
        .client`UPDATE factory.verification SET state='running',completed_at=NULL WHERE id=${f.verificationID}`;
      await f.database.client`INSERT INTO factory.pull_request_operation(
        id,change_id,repository_owner,repository_name,base_branch,head_branch,first_head_sha,
        title,body,idempotency_key,state,pull_request_number,pull_request_url,completed_at)
        SELECT ${crypto.randomUUID()},id,'owned','review','main',branch_name,${f.commit},
          'Owned diagnostics','','owned-diagnostics-'||id,'succeeded',1,'https://forge.invalid/owned/review/pulls/1',now()
        FROM factory.change WHERE id=${f.changeID}`;
      await controller.reconcile(f.changeID);
      const [saved] = await f.database.client<{ diagnosis: VerificationDiagnosis }[]>`
        SELECT diagnosis FROM factory.verification WHERE id=${f.verificationID}`;
      expect(saved?.diagnosis).toEqual(diagnosis);
      expect(corrections).toHaveLength(kind === "check-failed" ? 1 : 0);
      if (kind === "check-failed") {
        expect(corrections[0]).toContain("Expected 200, received 500");
        expect(corrections[0]).toContain(f.commit);
        expect(corrections[0]).toContain("factory_browser_verification_read");
        // Recovery must use the frozen evidence, even if live diagnostics changed.
        diagnosis.summary = "Later mutable observation must not replace the request";
      }
      await controller.reconcile(f.changeID);
      expect(reads).toBe(1);
      expect(corrections).toHaveLength(kind === "check-failed" ? 1 : 0);
      const view = await controller.get(f.changeID);
      expect(view?.["verificationFailureKind"]).toBe(kind);
      if (kind === "execution-failed") {
        observedStatus = "success";
        await controller.reconcile(f.changeID);
        const recovered = await controller.get(f.changeID);
        expect(recovered?.["verificationState"]).toBe("succeeded");
        expect(recovered?.["verificationFailureKind"]).toBeNull();
        expect(corrections).toEqual([]);
        const [history] = await f.database.client<{ diagnosis: VerificationDiagnosis }[]>`
          SELECT diagnosis FROM factory.verification WHERE id=${f.verificationID}`;
        expect(history?.diagnosis.kind).toBe("execution-failed");
        expect(history?.diagnosis).toHaveProperty("receipt.commit", f.commit);
        expect(history?.diagnosis).toHaveProperty("receipt.jobs.0.attempt", 1);
        await controller.reconcile(f.changeID);
        expect(reads).toBe(1);
      }
    } finally {
      await f.dispose();
    }
  },
);

test("Verification output is bound to the correction, exact failed job/attempt and current authority", async () => {
  const f = await fixture();
  const verificationID = crypto.randomUUID();
  const diagnosis = {
    kind: "check-failed",
    summary: "Validation test failed.",
    jobs: [
      {
        id: 8,
        attempt: 2,
        name: "Project checks",
        step: 1,
        stepName: "test",
        output: "Expected 200, received 500",
      },
    ],
  };
  let reads = 0;
  let duringRead: (() => Promise<void>) | undefined;
  const forge = {
    async readVerificationLog() {
      reads++;
      await duringRead?.();
      return { output: "Expected 200, received 500", nextOffset: null };
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  try {
    await f.database
      .client`UPDATE factory.project SET repository_url='https://forge.invalid/owned/app.git' WHERE id=${f.projectID}`;
    await f.database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,created_by,state,completed_at,diagnosis)
      VALUES(${verificationID},${f.changeID},${"a".repeat(40)},1,'owned-evidence',7,${f.userID},'failed',now(),${JSON.stringify(diagnosis)}::jsonb)`;
    const admitted = await createChangeAdmission(f.database, buildModelID).admit(
      f.changeID,
      f.userID,
      {
        kind: "change-repair",
        commandId: verificationID,
        text: "Fix the observed validation test.",
      },
    );
    const turns = createAgentTurnStore(f.database);
    const turn = await turns.claimPending(admitted.turn.id);
    if (!turn?.ownerToken) throw new Error("Missing owned correction lease");
    await f.writers.prepareAgent(f.changeID, turn.id);
    const tools = createVerificationTools(f.database, forge);
    expect((await tools.tools(turn.id)).map((item) => item.name)).toEqual(["verification_read"]);
    const call = {
      name: "verification_read",
      arguments: {
        verificationId: verificationID,
        jobId: 8,
        attempt: 2,
        step: 1,
        offset: 0,
      },
    };
    expect(JSON.stringify(await tools.call(turn.id, turn.ownerToken, call))).toContain(
      "Expected 200",
    );
    for (const changed of [
      { verificationId: crypto.randomUUID() },
      { jobId: 9 },
      { attempt: 1 },
      { step: 0 },
    ])
      await expect(
        tools.call(turn.id, turn.ownerToken, {
          ...call,
          arguments: { ...call.arguments, ...changed },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    expect(reads).toBe(1);
    duringRead = async () => {
      await f.database
        .client`UPDATE factory.agent_turn SET state='stopped',owner_token=NULL,owner_expires_at=NULL WHERE id=${turn.id}`;
    };
    await expect(tools.call(turn.id, turn.ownerToken, call)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(reads).toBe(2);
    await expect(tools.call(turn.id, turn.ownerToken, call)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(reads).toBe(2);
  } finally {
    await f.dispose();
  }
});
