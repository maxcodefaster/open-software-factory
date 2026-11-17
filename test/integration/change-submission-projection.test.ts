import { afterAll, beforeAll, expect, test } from "bun:test";
import { createChangeController } from "../../apps/factory/src/change/controller";
import type { ChangeView } from "../../apps/factory/src/change/types";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import { createWorkspaceSubmission } from "../../apps/factory/src/workspace/submission";
import { createDatabase } from "../../packages/db/src/client";
import { ticketBoardStatus } from "../../packages/interface-domain/src/ticket-board";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

type Owned = Awaited<ReturnType<typeof fixture>>;
type TurnState =
  | "pending"
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "uncertain";
const commitSHA = "cc9cf449a96e69a977de782f2a01e098e6ab5ee0";
let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

async function withSubmission(
  run: (context: {
    owned: Owned;
    turnID: string;
    submissionID: string;
    submissionAttemptID: string;
    stopID: string;
    changes: ReturnType<typeof createChangeController>;
  }) => Promise<void>,
  historicalState: "stopped" | "failed" | "completed" = "stopped",
  sourceGeneration: 1 | 2 = 2,
) {
  if (!server) throw Error("Owned PostgreSQL server is required");
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = target.url;
  const database = createDatabase(2);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  const configuration = {
    FACTORY_FORGEJO_TOKEN: "owned-no-external-forge-token",
    FACTORY_FORGEJO_OWNER: "owned",
  };
  const previous = new Map(Object.keys(configuration).map((key) => [key, process.env[key]]));
  let owned: Owned | undefined;
  let submission: ReturnType<typeof createWorkspaceSubmission> | undefined;
  try {
    const f = await fixture(undefined, undefined, database);
    owned = f;
    Object.assign(process.env, configuration);
    const turnID = crypto.randomUUID();
    const submissionID = crypto.randomUUID();
    const stopID = crypto.randomUUID();
    const submissionAttemptID = runtimeIdentity(f.workspaceID, sourceGeneration).attemptID;
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.branch_create_operation(
        id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,
        state,observed_head_sha,completed_at)
        SELECT ${crypto.randomUUID()},id,'owned','fixture',branch_name,base_sha,
          ${crypto.randomUUID()},'succeeded',base_sha,now()
        FROM factory.change WHERE id=${f.changeID}`;
      await sql`INSERT INTO factory.agent_turn(
        id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,
        state,outcome_summary,created_at,updated_at)
        VALUES(${turnID},${crypto.randomUUID()},${f.projectID},${f.ticketID},
          ${f.changeID},${f.userID},'{"kind":"change-start"}',${"a".repeat(64)},
          ${JSON.stringify({ mode: "build", requirementRevisionId: f.revisionID })}::jsonb,
          ${historicalState}::factory.agent_turn_state,'Historical implementation outcome',
          now()-interval '2 minutes',now()-interval '1 minute')`;
      await sql`INSERT INTO factory.change_agent_turn_intent(
        turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
        VALUES(${turnID},${f.changeID},${f.sessionID},${`msg_${turnID.replaceAll("-", "")}`},
          'Original implementation input',false,'Retained implementation',${f.attemptID})`;
      await sql`UPDATE factory.change_agent_session SET state='stopped',active_turn_id=${turnID},
        stop_id=${stopID},stop_turn_id=${turnID},
        implementation_session_id=opencode_session_id,implementation_session_confirmed_at=native_session_confirmed_at,
        updated_at=now()-interval '1 minute' WHERE change_id=${f.changeID}`;
      if (sourceGeneration === 2) {
        // The original Coding owner stays G1. Only canonical Source and the
        // human submission use G2, as in the retained native observation.
        await sql`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${f.attemptID}`;
        await sql`INSERT INTO factory.runtime_attempt(
          id,project_id,change_id,workspace_id,generation,revision,state,parent_connector_token_hash,
          child_connector_token_hash,create_intended_at,created_by)
          SELECT ${submissionAttemptID},project_id,change_id,workspace_id,2,revision,'create-intended',
            parent_connector_token_hash,child_connector_token_hash,now(),created_by
          FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
        await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
          SELECT ${submissionAttemptID},${`fa-${submissionAttemptID.replaceAll("-", "")}`},
            ${`runtime-${submissionAttemptID.replaceAll("-", "")}`},intent
          FROM factory.substrate_binding WHERE runtime_attempt_id=${f.attemptID}`;
        await freezeRuntimeEnvironment(sql, submissionAttemptID);
        await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${submissionAttemptID}`;
        await sql`UPDATE factory.change SET runtime_attempt_id=${submissionAttemptID} WHERE id=${f.changeID}`;
      }
      await sql`UPDATE factory.change_writer SET state='human',user_id=${f.userID},
        epoch=epoch+1 WHERE change_id=${f.changeID}`;
    });
    let remote = "a".repeat(40);
    submission = createWorkspaceSubmission(
      database,
      {
        connected: () => true,
        parentOperation: async (attemptID, input, beforeSend) => {
          expect(attemptID).toBe(submissionAttemptID);
          await beforeSend?.(() => {});
          if (input.action === "git-push") remote = commitSHA;
          return { commitSHA, remoteSHA: remote };
        },
      },
      { assertSaved: async () => {} },
      { getBranch: async () => ({ name: "branch", headSha: remote }) },
      { username: "owned-control", password: "owned-test-only" },
      { fenceSource: async () => {}, protect: async () => {} },
    );
    expect(
      (
        await submission.submit(owned.userID, {
          requestID: submissionID,
          workspaceID: owned.workspaceID,
          expectedHead: remote,
          expectedRemoteHead: remote,
          message: "Submit saved human corrections",
        })
      ).state,
    ).toBe("succeeded");
    // Delivery has published the confirmed Workspace candidate. No Coding turn
    // is resumed or rewritten, and no native API or model is called by this proof.
    await database.client`UPDATE factory.change_agent_session SET state='committed',
      updated_at=now() WHERE change_id=${owned.changeID}`;
    await database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,action_run_id,runner_name,state,created_by)
      VALUES(${crypto.randomUUID()},${owned.changeID},${commitSHA},1,1,'owned-projection','running',${owned.userID})`;
    const changes = createChangeController(database, {
      stop: async () => {
        throw Error("Read projection must not stop compute");
      },
    });
    await run({ owned, turnID, submissionID, submissionAttemptID, stopID, changes });
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    try {
      await submission?.close();
      await owned?.shutdown();
    } finally {
      owned?.restoreEnvironment();
      for (const [key, value] of previous)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await database.client.end();
      await target.dispose();
    }
  }
}

async function readBoth(
  changes: ReturnType<typeof createChangeController>,
  owned: Owned,
): Promise<ChangeView[]> {
  const one = await changes.get(owned.changeID);
  const listed = (await changes.list(owned.projectID, owned.userID)).find(
    (change) => change.id === owned.changeID,
  );
  expect(one).not.toBeNull();
  if (!one || !listed) throw Error("Owned Change missing from get/list");
  expect(listed).toEqual(one);
  return [one, listed];
}

test.each(["stopped", "failed", "completed"] as const)(
  "get/list show submitted Verification instead of an older %s Coding turn without rewriting history",
  async (historicalState) => {
    await withSubmission(
      async ({ owned, changes, turnID, submissionID }) => {
        const history = () => owned.database.client`SELECT
      (SELECT jsonb_agg(turn ORDER BY id) FROM factory.agent_turn turn WHERE change_id=${owned.changeID}) AS turns,
      (SELECT jsonb_agg(intent ORDER BY turn_id) FROM factory.change_agent_turn_intent intent WHERE change_id=${owned.changeID}) AS intents,
      (SELECT to_jsonb(session) FROM factory.change_agent_session session WHERE change_id=${owned.changeID}) AS session,
      (SELECT to_jsonb(binding) FROM factory.substrate_binding binding WHERE runtime_attempt_id=${owned.attemptID}) AS native,
      (SELECT to_jsonb(attempt) FROM factory.runtime_attempt attempt WHERE id=${owned.attemptID}) AS runtime,
      (SELECT to_jsonb(writer) FROM factory.change_writer writer WHERE change_id=${owned.changeID}) AS writer,
      (SELECT to_jsonb(submission) FROM factory.workspace_submission submission WHERE id=${submissionID}) AS source,
      (SELECT to_jsonb(operation) FROM factory.change_commit_operation operation WHERE id=${submissionID}) AS submission`;
        const before = await history();
        for (const view of await readBoth(changes, owned)) {
          expect(view).toMatchObject({
            buildTurnState: null,
            buildTurnPurpose: null,
            implementationState: "committed",
            verificationState: "running",
            runtimeAttemptId: owned.attemptID,
          });
          expect(
            ticketBoardStatus({
              ticketState: "in-progress",
              changeState: view.state,
              verificationState: view.verificationState ?? undefined,
              buildTurnState: view.buildTurnState ?? undefined,
              buildTurnPurpose: view.buildTurnPurpose ?? undefined,
              implementationState: view.implementationState ?? undefined,
            }),
          ).toBe("Verification running");
        }
        expect(await history()).toEqual(before);
        expect([
          ...(await owned.database
            .client`SELECT id,state FROM factory.agent_turn WHERE id=${turnID}`),
        ]).toEqual([expect.objectContaining({ id: turnID, state: historicalState })]);
        expect((await changes.list(undefined, owned.userID)).map((change) => change.id)).toEqual([
          owned.changeID,
        ]);
        expect(await changes.list(owned.projectID, crypto.randomUUID())).toHaveLength(0);
      },
      historicalState,
      1,
    );
  },
  60_000,
);

test("get/list show G2 Workspace Verification while retaining the stopped G1 Coding Session and immutable identities", async () => {
  await withSubmission(
    async ({ owned, changes, turnID, submissionID, submissionAttemptID, stopID }) => {
      const { database, changeID } = owned;
      expect(submissionAttemptID).not.toBe(owned.attemptID);
      await database.client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${submissionAttemptID}`;
      await database.client`UPDATE factory.verification SET state='runner-starting' WHERE change_id=${changeID}`;
      const retained = () => database.client`SELECT
      (SELECT jsonb_agg(turn ORDER BY id) FROM factory.agent_turn turn WHERE change_id=${changeID}) AS turns,
      (SELECT jsonb_agg(intent ORDER BY turn_id) FROM factory.change_agent_turn_intent intent WHERE change_id=${changeID}) AS intents,
      (SELECT to_jsonb(session) FROM factory.change_agent_session session WHERE change_id=${changeID}) AS session,
      (SELECT jsonb_agg(attempt ORDER BY generation) FROM factory.runtime_attempt attempt WHERE change_id=${changeID}) AS runtimes,
      (SELECT jsonb_agg(binding ORDER BY runtime_attempt_id) FROM factory.substrate_binding binding
        JOIN factory.runtime_attempt attempt ON attempt.id=binding.runtime_attempt_id WHERE attempt.change_id=${changeID}) AS native,
      (SELECT to_jsonb(operation) FROM factory.change_commit_operation operation WHERE id=${submissionID}) AS submission`;
      const before = await retained();
      expect(before[0]?.["session"]).toMatchObject({
        runtime_attempt_id: owned.attemptID,
        opencode_session_id: owned.sessionID,
        implementation_session_id: owned.sessionID,
        active_turn_id: turnID,
        state: "committed",
        stop_id: stopID,
        stop_turn_id: turnID,
        stop_pending: false,
      });
      expect(before[0]?.["submission"]).toMatchObject({
        runtime_attempt_id: submissionAttemptID,
        source: "workspace",
        state: "succeeded",
        commit_sha: commitSHA,
        observed_remote_sha: commitSHA,
      });
      expect(before[0]?.["runtimes"]).toMatchObject([
        { id: owned.attemptID, generation: 1, workspace_id: owned.workspaceID, state: "stopped" },
        {
          id: submissionAttemptID,
          generation: 2,
          workspace_id: owned.workspaceID,
          state: "paused",
        },
      ]);
      expect(before[0]?.["intents"]).toMatchObject([
        { turn_id: turnID, runtime_attempt_id: owned.attemptID, session_id: owned.sessionID },
      ]);
      for (const view of await readBoth(changes, owned))
        expect(view).toMatchObject({
          buildTurnState: null,
          buildTurnPurpose: null,
          implementationState: "committed",
          verificationState: "runner-starting",
          runtimeAttemptId: submissionAttemptID,
          runtimeState: "paused",
        });
      expect(await retained()).toEqual(before);
      expect(before[0]?.["turns"]).toMatchObject([{ id: turnID, state: "stopped" }]);
    },
  );
}, 60_000);

async function insertTurn(
  owned: Owned,
  state: TurnState,
  kind: "change-prompt" | "change-review" = "change-prompt",
  createdSecondsAgo = 0,
  updatedSecondsAgo = 0,
) {
  const id = crypto.randomUUID();
  const owner = state === "running" || state === "dispatching" ? crypto.randomUUID() : null;
  await owned.database.client`INSERT INTO factory.agent_turn(
    id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,
    state,owner_token,owner_expires_at,created_at,updated_at)
    VALUES(${id},${crypto.randomUUID()},${owned.projectID},${owned.ticketID},${owned.changeID},
      ${owned.userID},${JSON.stringify({ kind })}::jsonb,${"b".repeat(64)},
      ${JSON.stringify({ mode: "build", requirementRevisionId: owned.revisionID, ...(kind === "change-review" ? { review: {} } : {}) })}::jsonb,
      ${state}::factory.agent_turn_state,${owner},
      ${owner ? new Date(Date.now() + 60_000).toISOString() : null}::timestamptz,
      now()-(${createdSecondsAgo} * interval '1 second'),
      now()-(${updatedSecondsAgo} * interval '1 second'))`;
  return id;
}

for (const kind of ["change-prompt", "change-review"] as const)
  test.each([
    "pending",
    "dispatching",
    "running",
    "completed",
    "failed",
    "stopped",
    "uncertain",
  ] as const)(
    `get/list retain a newer %s ${kind} after confirmed human submission`,
    async (state) => {
      await withSubmission(async ({ owned, changes }) => {
        await insertTurn(owned, state, kind);
        for (const view of await readBoth(changes, owned))
          expect(view).toMatchObject({
            buildTurnState: state,
            buildTurnPurpose: kind === "change-review" ? "review" : "implementation",
            verificationState: "running",
          });
      });
    },
    60_000,
  );

test.each(["stopped", "failed"] as const)(
  "get/list retain a %s outcome settled after submission on a turn admitted earlier",
  async (state) => {
    await withSubmission(async ({ owned, changes }) => {
      await insertTurn(owned, state, "change-prompt", 60);
      for (const view of await readBoth(changes, owned)) expect(view.buildTurnState).toBe(state);
    });
  },
  60_000,
);

test.each(["completed", "failed", "stopped"] as const)(
  "get/list preserve the purpose of an older %s independent review",
  async (state) => {
    await withSubmission(async ({ owned, changes }) => {
      const reviewID = await insertTurn(owned, state, "change-review", 60, 30);
      await owned.database.client`UPDATE factory.change_agent_session
        SET active_turn_id=${reviewID},stop_turn_id=NULL WHERE change_id=${owned.changeID}`;
      for (const view of await readBoth(changes, owned))
        expect(view).toMatchObject({ buildTurnState: state, buildTurnPurpose: "review" });
    });
  },
  60_000,
);

test.each(["pending", "dispatching", "running", "uncertain"] as const)(
  "get/list do not hide an unsettled %s turn even when another turn sorts later",
  async (state) => {
    await withSubmission(async ({ owned, changes }) => {
      await insertTurn(owned, state, "change-prompt", 180);
      for (const view of await readBoth(changes, owned))
        expect(view).toMatchObject({
          buildTurnState: "stopped",
          buildTurnPurpose: "implementation",
        });
    });
  },
  60_000,
);

test.each([
  "starting",
  "working",
  "waiting",
  "failed",
  "stopped",
  "pending Stop",
  "active input",
  "Session error",
  "unpublished Session",
  "human writer",
  "agent writer",
  "preparing writer",
  "writer handoff",
  "new writer epoch",
  "unsettled Source fence",
] as const)(
  "get/list do not discard historical turn progress with %s",
  async (boundary) => {
    await withSubmission(async ({ owned, changes, turnID }) => {
      const { database, changeID, userID } = owned;
      switch (boundary) {
        case "starting":
        case "working":
        case "waiting":
        case "failed":
        case "stopped":
          await database.client`UPDATE factory.change_agent_session
            SET state=${boundary}::factory.change_agent_state,updated_at=now() WHERE change_id=${changeID}`;
          break;
        case "pending Stop":
          await database.client`UPDATE factory.change_agent_session SET state='stopped',
            stop_pending=true,stop_dispatched=true,stop_id=${crypto.randomUUID()},
            updated_at=now() WHERE change_id=${changeID}`;
          break;
        case "active input":
          await database.client`UPDATE factory.change_agent_session
            SET active_inbox_id='msg_newer_input' WHERE change_id=${changeID}`;
          break;
        case "Session error":
          await database.client`UPDATE factory.change_agent_session
            SET last_error='Newer failure' WHERE change_id=${changeID}`;
          break;
        case "unpublished Session":
          await database.client`UPDATE factory.change_agent_session
            SET updated_at=now()-interval '1 minute' WHERE change_id=${changeID}`;
          break;
        case "human writer":
          await database.client`UPDATE factory.change_writer
            SET state='human',user_id=${userID} WHERE change_id=${changeID}`;
          break;
        case "agent writer":
        case "preparing writer":
          await database.client`UPDATE factory.change_writer
            SET state=${boundary === "agent writer" ? "agent" : "agent-preparing"},turn_id=${turnID}
            WHERE change_id=${changeID}`;
          break;
        case "writer handoff":
          await database.client`UPDATE factory.change_writer SET state='handoff',
            requested_by=${userID},request_id=${crypto.randomUUID()} WHERE change_id=${changeID}`;
          break;
        case "new writer epoch":
          await database.client`UPDATE factory.change_writer SET epoch=epoch+1 WHERE change_id=${changeID}`;
          break;
        case "unsettled Source fence":
          await database.client`UPDATE factory.change_writer SET fence_required=true WHERE change_id=${changeID}`;
          break;
      }
      for (const view of await readBoth(changes, owned))
        expect(view).toMatchObject({
          buildTurnState: "stopped",
          buildTurnPurpose: "implementation",
          verificationState: "running",
        });
    });
  },
  60_000,
);

for (const source of ["agent", "workspace"] as const)
  test.each(["commit-intended", "push-intended", "failed", "succeeded"] as const)(
    `get/list retain Coding history when a newer ${source} operation without a submission record is %s`,
    async (state) => {
      await withSubmission(async ({ owned, changes, submissionAttemptID }) => {
        await owned.database.client`INSERT INTO factory.change_commit_operation(
        id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,
        observed_remote_sha,commit_message,idempotency_key,state,created_by,source,completed_at)
        SELECT ${crypto.randomUUID()},id,${submissionAttemptID},2,branch_name,${commitSHA},${"e".repeat(40)},
          ${state === "succeeded" ? "e".repeat(40) : null},'Newer candidate',
          ${crypto.randomUUID()},${state}::factory.change_commit_state,${owned.userID},${source}::factory.change_commit_source,
          ${state === "succeeded" || state === "failed" ? new Date().toISOString() : null}::timestamptz
        FROM factory.change WHERE id=${owned.changeID}`;
        for (const view of await readBoth(changes, owned))
          expect(view).toMatchObject({
            buildTurnState: "stopped",
            buildTurnPurpose: "implementation",
            verificationState: state === "succeeded" ? null : "running",
          });
      });
    },
    60_000,
  );
