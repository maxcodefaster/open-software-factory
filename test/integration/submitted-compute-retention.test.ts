import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createIdleCompute } from "../../apps/factory/src/runtime/idle";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

async function setup() {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const f = await candidateReviewFixture(undefined, database);
    const paused: string[] = [];
    const stopped: string[] = [];
    const claims: string[] = [];
    let releases = 0;
    let rejectStop = false;
    let activeUse = false;
    const idle = createIdleCompute(
      database,
      {
        claimIdle(id) {
          claims.push(id);
          return !activeUse;
        },
        releaseIdle() {
          releases++;
        },
      },
      {
        async pause(id) {
          paused.push(id);
        },
        async stop(id) {
          const [intent] = await database.client<{ state: string; stopping: boolean }[]>`
            SELECT state,stop_intended_at IS NOT NULL AS stopping FROM factory.runtime_attempt WHERE id=${id}`;
          expect(intent).toEqual({ state: "stop-intended", stopping: true });
          stopped.push(id);
          if (rejectStop) throw new Error("Owned Stop dispatch response unavailable");
        },
      },
      1,
    );
    async function retained() {
      const [row] = await database.client`
        SELECT change.state,session.state AS session,session.active_turn_id AS turn,
          session.opencode_session_id AS native,workspace.id AS workspace,
          workspace.source_revision AS revision,
          (SELECT commit_sha FROM factory.change_commit_operation
            WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1) AS commit,
          (SELECT count(*) FROM factory.requirement_approval WHERE ticket_id=change.ticket_id) AS approvals
        FROM factory.change change JOIN factory.change_agent_session session ON session.change_id=change.id
        JOIN factory.development_workspace workspace ON workspace.change_id=change.id WHERE change.id=${f.changeID}`;
      return row;
    }
    return {
      ...f,
      idle,
      paused,
      stopped,
      claims,
      retained,
      setActiveUse(value: boolean) {
        activeUse = value;
      },
      releases: () => releases,
      setRejectStop(value: boolean) {
        rejectStop = value;
      },
      async close() {
        await idle.close();
        await database.client.end({ timeout: 0 });
        await host.dispose();
      },
    };
  } catch (cause) {
    await database.client.end({ timeout: 0 });
    await host.dispose();
    throw cause;
  }
}

test.each(["Coding", "completed Review"])(
  "idle submitted %s records Stop instead of another RAM/filesystem snapshot",
  async (phase) => {
    const f = await setup();
    try {
      if (phase === "completed Review") {
        const turn = await f.activeReview();
        await f.turns.settle(
          turn.id,
          turn.ownerToken,
          "completed",
          "Owned read-only review completed",
          async (sql) => {
            await sql`UPDATE factory.candidate_review SET state='passed',completed_at=now(),
          result=${JSON.stringify({
            verdict: "passed",
            summary: "Owned read-only review completed",
            criteria: [
              { criterion: 1, status: "passed", evidence: "Owned exact candidate inspection" },
            ],
            findings: [],
            ui: "not-applicable",
          })}::jsonb WHERE id=${f.reviewID}`;
            await sql`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
          },
        );
      }
      const before = await f.retained();
      await Promise.all([f.idle.sweep(), f.idle.sweep()]);
      expect(f.stopped).toEqual([f.attemptID]);
      expect(f.paused).toEqual([]);
      expect(await f.retained()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test("failed submitted-compute Stop intent rolls back without dispatching cleanup", async () => {
  const f = await setup();
  try {
    await f.database.client.unsafe(
      "CREATE FUNCTION factory.owned_stop_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned Stop intent failure'; END $$; CREATE TRIGGER owned_stop_failure BEFORE UPDATE OF state ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.owned_stop_failure()",
    );
    const before = await f.retained();
    await expect(f.idle.sweep()).rejects.toThrow("Owned Stop intent failure");
    expect(f.stopped).toEqual([]);
    expect(f.paused).toEqual([]);
    expect(f.releases()).toBe(1);
    expect(await f.retained()).toEqual(before);
    const [runtime] = await f.database.client<{ state: string; stopping: boolean }[]>`
      SELECT state,stop_intended_at IS NOT NULL AS stopping FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(runtime).toEqual({ state: "ready", stopping: false });
  } finally {
    await f.close();
  }
});

test("a lost idle Stop response retains intent without repeating dispatch or resetting cleanup", async () => {
  const f = await setup();
  try {
    const before = await f.retained();
    f.setRejectStop(true);
    await expect(f.idle.sweep()).rejects.toThrow("Owned Stop dispatch response unavailable");
    const [intent] = await f.database.client<{ state: string; stopping: boolean }[]>`
      SELECT state,stop_intended_at IS NOT NULL AS stopping FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(intent).toEqual({ state: "stop-intended", stopping: true });
    await f.idle.sweep();
    expect(f.stopped).toEqual([f.attemptID]);
    expect(f.releases()).toBe(0);
    expect(await f.retained()).toEqual(before);
  } finally {
    await f.close();
  }
});

test.each([
  "settled",
  "human",
  "unknown-session",
  "active-use",
  "pending",
  "uncertain",
  "unfinished",
] as const)(
  "known failed Coding releases only exact settled idle execution: %s",
  async (condition) => {
    const f = await setup();
    try {
      const admitted = await createChangeAdmission(f.database, buildModelID).admit(
        f.changeID,
        f.userID,
        { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned failed work" },
      );
      const turn = await f.turns.claimPending(admitted.turn.id);
      if (!turn?.ownerToken) throw new Error("Owned failed turn was not claimed");
      await f.writers.prepareAgent(f.changeID, turn.id);
      await f.database.client`UPDATE factory.change_agent_turn_intent
      SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${turn.id}`;
      await f.database.client`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},
      state='working' WHERE change_id=${f.changeID}`;
      await f.turns.beginDispatch(turn.id, turn.ownerToken);
      await f.turns.settle(
        turn.id,
        turn.ownerToken,
        condition === "uncertain" ? "uncertain" : "failed",
        "Owned request outcome",
      );
      await f.database.client`UPDATE factory.change_agent_session SET state='failed'
      WHERE change_id=${f.changeID}`;
      if (condition === "human")
        await f.database.client`UPDATE factory.change_writer SET state='human',turn_id=NULL,
        user_id=${f.userID},fence_required=false,fence_attempt_id=NULL WHERE change_id=${f.changeID}`;
      if (condition === "unknown-session")
        await f.database.client`UPDATE factory.change_agent_session SET active_turn_id=NULL
        WHERE change_id=${f.changeID}`;
      if (condition === "active-use") f.setActiveUse(true);
      if (condition === "pending")
        await createChangeAdmission(f.database, buildModelID).admit(f.changeID, f.userID, {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Owned next commission",
        });
      if (condition === "unfinished")
        await f.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
        commit_message,idempotency_key,state,created_by)
        SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,2,branch_name,commit_sha,
          'Owned unfinished submission',${crypto.randomUUID()},'commit-intended',created_by
        FROM factory.change_commit_operation WHERE id=${f.initial.id}`;
      const before = await f.retained();
      await f.idle.sweep();
      expect(f.paused).toEqual(
        ["human", "unknown-session"].includes(condition) ? [f.attemptID] : [],
      );
      expect(f.stopped).toEqual(condition === "settled" ? [f.attemptID] : []);
      expect(await f.retained()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test.each([
  "human-writer",
  "unsubmitted",
  "unknown-source-runtime",
  "unfinished-commit",
  "waiting",
  "active-use",
  "new-work",
  "uncertain",
] as const)("idle submission retirement preserves %s", async (condition) => {
  const f = await setup();
  try {
    let expectedAttemptID = f.attemptID;
    if (condition === "human-writer")
      await f.database.client`UPDATE factory.change_writer SET state='human',turn_id=NULL,
          user_id=${f.userID},fence_required=false,fence_attempt_id=NULL WHERE change_id=${f.changeID}`;
    if (condition === "unsubmitted")
      await f.database
        .client`UPDATE factory.change_agent_session SET active_turn_id=NULL WHERE change_id=${f.changeID}`;
    if (condition === "unknown-source-runtime") {
      expectedAttemptID = crypto.randomUUID();
      await f.database.client`UPDATE factory.runtime_attempt SET state='stopped',
          stop_intended_at=now(),stopped_at=now() WHERE id=${f.attemptID}`;
      await f.database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,change_id,workspace_id,generation,revision,state,
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          SELECT ${expectedAttemptID},project_id,change_id,workspace_id,generation+1,${f.commit},'ready',
            parent_connector_token_hash,child_connector_token_hash,now(),created_by
          FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      await f.database
        .client`UPDATE factory.change SET runtime_attempt_id=${expectedAttemptID} WHERE id=${f.changeID}`;
      const [association] = await f.database.client<
        { revision: string; sessionRuntime: string }[]
      >`SELECT attempt.revision,session.runtime_attempt_id AS "sessionRuntime"
        FROM factory.runtime_attempt attempt JOIN factory.change_agent_session session
          ON session.change_id=attempt.change_id WHERE attempt.id=${expectedAttemptID}`;
      expect(association).toEqual({ revision: f.commit, sessionRuntime: f.attemptID });
    }
    if (condition === "unfinished-commit")
      await f.database.client`INSERT INTO factory.change_commit_operation(
          id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
          commit_message,idempotency_key,state,created_by)
          SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,2,branch_name,commit_sha,
            'Owned unfinished commit',${crypto.randomUUID()},'commit-intended',created_by
          FROM factory.change_commit_operation WHERE id=${f.initial.id}`;
    if (condition === "waiting")
      await f.database
        .client`UPDATE factory.change_agent_session SET state='waiting' WHERE change_id=${f.changeID}`;
    if (condition === "active-use") f.setActiveUse(true);
    if (condition === "new-work" || condition === "uncertain") {
      const admitted = await createChangeAdmission(f.database, buildModelID).admit(
        f.changeID,
        f.userID,
        { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Owned unfinished work" },
      );
      if (condition === "uncertain") {
        const turn = await f.turns.claimPending(admitted.turn.id);
        if (!turn?.ownerToken) throw new Error("Owned work was not claimed");
        await f.writers.prepareAgent(f.changeID, turn.id);
        await f.turns.beginDispatch(turn.id, turn.ownerToken);
        await f.turns.settle(turn.id, turn.ownerToken, "uncertain", "Owned lost outcome");
      }
    }
    const before = await f.retained();
    await f.idle.sweep();
    expect(f.stopped).toEqual([]);
    expect(await f.retained()).toEqual(before);
    expect(f.paused).toEqual(
      ["human-writer", "unsubmitted", "unknown-source-runtime", "waiting"].includes(condition)
        ? [expectedAttemptID]
        : [],
    );
  } finally {
    await f.close();
  }
});
