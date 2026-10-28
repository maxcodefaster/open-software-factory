import { expect, test } from "bun:test";
import { createLearningService } from "../../apps/factory/src/learning/service";
import { createLearningWorker } from "../../apps/factory/src/learning/worker";
import { collectLearningCases } from "../../apps/factory/src/learning/sources";
import { calibratedResult } from "../fixtures/learning";
import { calibrationCases } from "../../apps/factory/src/learning/calibration";
import type { LearningCase, LearningResult } from "../../packages/conversation-domain/src/learning";
import { sampleLearningCase, learningCase } from "../../packages/conversation-domain/src/learning";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { retainLearningArtifactsIn } from "../../apps/factory/src/learning/artifacts";
import { fixtureValue } from "../fixtures/value";
import { verificationReceipt } from "../fixtures/verification";

test("Input learning uses published outcomes and saved instructions, never raw webhook or private admission context", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const hook = crypto.randomUUID(),
      policy = crypto.randomUUID();
    let incident = crypto.randomUUID();
    while (!sampleLearningCase(`monitoring:${incident}`, "completed"))
      incident = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.monitoring_hook(id,project_id,name,version,enabled,secret_digest,policy_id)
        VALUES(${hook},${owned.projectID},'Owned Input privacy',1,false,${"a".repeat(64)},${policy})`;
      await sql`INSERT INTO factory.monitoring_policy(id,hook_id,delegated_by,delegation,instructions)
        VALUES(${policy},${hook},${owned.userID},'prepare-ticket','Inspect the connected source and prepare requirements.')`;
      await sql`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,fingerprint,payload_digest,
        title,context,state,reason,diagnosis,skill_assignment,settled_at)
        VALUES(${incident},${hook},${owned.projectID},${policy},1,${"b".repeat(64)},${"c".repeat(64)},
        'Owned request without Project context','RAW-WEBHOOK-CREDENTIAL-DO-NOT-SHARE','insufficient-context','Missing Project context.',
        ${JSON.stringify({ outcome: "insufficient-context", explanation: "Missing Project context.", title: "Owned request", requirements: null, code: [] })}::jsonb,
        ${JSON.stringify({ revisionIds: [], requiredRevisionIds: [], codeAccess: false, projectContext: { private: "PRIVATE-ADMISSION-CONTEXT-DO-NOT-SHARE" } })}::jsonb,now())`;
      await sql`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
        VALUES(${`monitoring:${incident}`},${owned.projectID},${owned.userID},'research','mastra','owned','owned',now(),'completed')`;
    });
    await collectLearningCases(database);
    const [saved] = await database.client<{ snapshot: LearningCase; selected: boolean }[]>`
      SELECT snapshot,selected FROM factory.learning_case WHERE id=${`monitoring:${incident}`}`;
    expect(saved?.selected).toBe(true);
    expect(saved?.snapshot.ownerId).toBeNull();
    const packet = JSON.stringify(saved?.snapshot);
    expect(packet).toContain("Inspect the connected source");
    expect(packet).toContain("Missing Project context");
    expect(packet).not.toContain("RAW-WEBHOOK-CREDENTIAL");
    expect(packet).not.toContain("PRIVATE-ADMISSION-CONTEXT");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("setup evidence requires current management, independently of Developer status", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.project_membership SET role='product-contributor',manage_project=true
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const review = crypto.randomUUID(),
      proposal = crypto.randomUUID();
    const source: LearningCase = {
      ...fixtureValue(calibrationCases[0], "calibrationCases[0]"),
      id: "owned:setup-review",
      projectId: owned.projectID,
      ownerId: owned.userID,
      activity: "setup",
      settledAt: new Date().toISOString(),
    };
    const content = {
      title: "Owned setup improvement",
      target: "instructions",
      caseIds: [source.id],
      evidenceIds: ["healthy:answer"],
      change: "Use the inspected configuration.",
      expectedEffect: "Avoid a repeated setup check.",
      validation: "Compare against the exact inspected source.",
    };
    const result = {
      cases: [
        {
          caseId: source.id,
          fulfillment: "unknown",
          rework: "unknown",
          verification: "unknown",
          explanation: "Owned setup evidence.",
          evidenceIds: [],
        },
      ],
      findings: [],
      proposals: [content],
    };
    await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,judge_key,state,
      input,input_digest,result,owner_token,owner_expires_at,completed_at)
      VALUES(${review},${owned.projectID},${owned.userID},false,${owned.userID},'work','work-review/v1','owned','owned-setup','completed',
        ${JSON.stringify([source])}::jsonb,${"a".repeat(64)},${JSON.stringify(result)}::jsonb,${crypto.randomUUID()},now(),now())`;
    await database.client`INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected,batch_id)
      VALUES(${source.id},${owned.projectID},${owned.userID},${owned.userID},false,'setup','completed',${source.settledAt},${JSON.stringify(source)}::jsonb,true,${review})`;
    await database.client`INSERT INTO factory.learning_proposal(id,review_id,ordinal,content) VALUES(${proposal},${review},0,${JSON.stringify(content)}::jsonb)`;
    const service = createLearningService(database);
    expect((await service.get(owned.userID, owned.projectID, true)).reviews).toHaveLength(1);
    await database.client`UPDATE factory.project_membership SET manage_project=false WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const revoked = await service.get(owned.userID, owned.projectID, true);
    expect(revoked.reviews).toHaveLength(0);
    expect(revoked.proposals).toHaveLength(0);
    expect(revoked.days.reduce((sum, day) => sum + day.observed, 0)).toBe(0);
    await expect(
      service.decide(owned.userID, {
        commandId: crypto.randomUUID(),
        proposalId: proposal,
        decision: "dismiss",
      }),
    ).rejects.toThrow("Project Manager");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("Build learning binds exact Verification and keeps loaded personal guidance private", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const library = crypto.randomUUID(),
      skill = crypto.randomUUID();
    const content = {
      key: "private-guidance",
      name: "Private guidance",
      description: "Owned privacy fixture",
      roles: ["build"],
      instructions: "Private synthetic implementation preference",
      references: [],
    };
    await database.client`INSERT INTO factory.skill_library(id,storage_key,scope,owner_id)
      VALUES(${library},'owned-private-guidance','personal',${owned.userID})`;
    await database.client`INSERT INTO factory.skill_revision(id,skill_key,revision,content,content_digest,created_by)
      VALUES(${skill},'owned-private-guidance',1,${JSON.stringify(content)}::jsonb,${"a".repeat(64)},${owned.userID})`;
    await database.client`INSERT INTO factory.skill_library_revision(library_id,revision_id) VALUES(${library},${skill})`;
    const turns: string[] = [];
    for (const scope of ["shared-risk", "personal", "clean"] as const) {
      const personal = scope === "personal";
      let id = crypto.randomUUID();
      while (sampleLearningCase(`turn:${id}`, "completed") !== personal) id = crypto.randomUUID();
      turns.push(id);
      const command = crypto.randomUUID();
      const input = {
        kind: "change-start",
        commandId: command,
        projectId: owned.projectID,
        ticketId: owned.ticketID,
        changeId: owned.changeID,
        conversationId: null,
        createdBy: owned.userID,
      };
      const authority = {
        mode: "build",
        requirementRevisionId: owned.revisionID,
        modelId: "owned",
        skillRevisionIds: personal ? [skill] : [],
      };
      await database.client`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state,owner_token,owner_expires_at)
        VALUES(${id},${command},${owned.projectID},${owned.ticketID},${owned.changeID},${owned.userID},
          ${JSON.stringify(input)}::jsonb,${"b".repeat(64)},${JSON.stringify(authority)}::jsonb,'running',${crypto.randomUUID()},now()+interval '1 minute')`;
      if (personal)
        await database.client`INSERT INTO factory.agent_turn_skill(turn_id,revision_id) VALUES(${id},${skill})`;
      await database.client`UPDATE factory.agent_turn SET state='completed',owner_token=NULL,owner_expires_at=NULL,
        outcome_summary=${personal ? null : "Owned completed Build summary"},updated_at=now() WHERE id=${id}`;
      await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
        VALUES(${`turn:${id}`},${owned.projectID},${owned.userID},'coding','opencode','owned','owned',now(),'completed')`;
    }
    const publicTurn = fixtureValue(turns[0], "turns[0]"),
      privateTurn = fixtureValue(turns[1], "turns[1]"),
      cleanTurn = fixtureValue(turns[2], "turns[2]"),
      verification = crypto.randomUUID();
    const branch = `factory/change-${owned.projectID.replaceAll("-", "").slice(0, 12)}`;
    await database.client`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,
      expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
      VALUES(${publicTurn},${owned.changeID},${owned.attemptID},1,${branch},${"a".repeat(40)},${"b".repeat(40)},${"b".repeat(40)},
      'Owned source-evidence check',${`owned:${publicTurn}`},'succeeded',${owned.userID},now())`;
    const receipt = verificationReceipt("b".repeat(40));
    fixtureValue(receipt.jobs[0], "receipt.jobs[0]").attempt = 2;
    fixtureValue(receipt.jobs[0]?.steps[0], "receipt.jobs[0]?.steps[0]").status = "skipped";
    fixtureValue(receipt.changes, "receipt.changes").tests = true;
    await database.client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,runner_name,state,
      summary,diagnosis,created_by,completed_at) VALUES(${verification},${owned.changeID},${"b".repeat(40)},1,1,'owned-learning-runner','succeeded',
      'Owned exact-commit workflow passed',${JSON.stringify({ receipt })}::jsonb,${owned.userID},now())`;
    await database.client`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,
      expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
      VALUES(${cleanTurn},${owned.changeID},${owned.attemptID},2,${branch},${"a".repeat(40)},${"c".repeat(40)},${"c".repeat(40)},
      'Owned clean check',${`owned:${cleanTurn}`},'succeeded',${owned.userID},now())`;
    await database.client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,runner_name,state,
      diagnosis,created_by,completed_at) VALUES(${crypto.randomUUID()},${owned.changeID},${"c".repeat(40)},1,2,'owned-clean-learning-runner','succeeded',
      ${JSON.stringify({ receipt: verificationReceipt("c".repeat(40), { runId: 2 }) })}::jsonb,${owned.userID},now())`;
    await collectLearningCases(database);
    const rows = await database.client<
      { id: string; owner: string | null; snapshot: LearningCase; selected: boolean }[]
    >`
      SELECT id,owner_id AS owner,snapshot,selected FROM factory.learning_case ORDER BY id`;
    const shared = fixtureValue(
      rows.find((row) => row.id === `turn:${publicTurn}`),
      `rows.find((row) => row.id === \`turn:\${publicTurn}\`)`,
    );
    expect(shared.owner).toBeNull();
    expect(shared.snapshot.developerOnly).toBe(true);
    expect(shared.selected).toBe(true);
    expect(shared.snapshot.reviewReasons).toEqual([
      "skipped-checks",
      "retried-checks",
      "test-changes",
    ]);
    expect(
      shared.snapshot.evidence.some(
        (item) => item.id === `verification:${verification}` && item.body.includes("b".repeat(40)),
      ),
    ).toBe(true);
    const personal = fixtureValue(
      rows.find((row) => row.id === `turn:${privateTurn}`),
      `rows.find((row) => row.id === \`turn:\${privateTurn}\`)`,
    );
    expect(personal.owner).toBe(owned.userID);
    expect(personal.selected).toBe(true);
    expect(personal.snapshot.reviewReasons).toEqual(["missing-verification-evidence"]);
    expect(JSON.stringify(personal.snapshot)).toContain(content.instructions);
    const clean = fixtureValue(
      rows.find((row) => row.id === `turn:${cleanTurn}`),
      "clean case",
    );
    expect(clean.selected).toBe(false);
    expect(clean.snapshot.evidence).toEqual([]);
    expect(clean.snapshot.reviewReasons).toBeUndefined();
    await database.client`UPDATE factory.project_membership SET role='product-contributor',manage_project=true
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const restricted = await createLearningService(database).get(owned.userID, owned.projectID);
    expect(restricted.days.reduce((count, day) => count + day.observed, 0)).toBe(0);
    expect(JSON.stringify(restricted)).not.toContain(content.instructions);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("retrospective review is calibrated, batched, private, immutable and never inferred by Settings reads", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const previous = {
    url: process.env["FACTORY_MODEL_BASE_URL"],
    key: process.env["FACTORY_MODEL_API_KEY"],
  };
  const workers: ReturnType<typeof createLearningWorker>[] = [];
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const other = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${other},'Other manager',${`${other}@test.invalid`},true)`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${owned.projectID},${other},'developer',true,${owned.userID})`;
    const source: LearningCase = {
      ...fixtureValue(calibrationCases[0], "calibrationCases[0]"),
      id: "owned:case",
      projectId: owned.projectID,
      ownerId: null,
      settledAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    };
    await database.client`INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected)
      VALUES(${source.id},${owned.projectID},NULL,${owned.userID},false,'research','completed',${source.settledAt},${JSON.stringify(source)}::jsonb,true)`;
    const service = createLearningService(database);
    expect((await service.get(owned.userID, owned.projectID)).days).toHaveLength(28);
    expect((await service.get(owned.userID, owned.projectID)).reviews).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.usage_operation WHERE purpose='learning'`,
    ).toHaveLength(0);
    process.env["FACTORY_MODEL_BASE_URL"] = "https://owned.invalid/v1";
    process.env["FACTORY_MODEL_API_KEY"] = "owned-not-a-real-key";
    let calls = 0;
    const worker = createLearningWorker(database, {
      signingKey: "owned-signing-key",
      review: async (input) => {
        calls++;
        const [intent] =
          await database.client`SELECT id FROM factory.learning_review WHERE state='running'`;
        expect(intent).toBeDefined();
        await input.authorize();
        await input.usage.begin();
        await input.usage.settle("completed");
        if (fixtureValue(input.cases[0], "input.cases[0]").id.startsWith("calibration:"))
          return calibratedResult();
        return {
          cases: input.cases.map((item) => ({
            caseId: item.id,
            fulfillment: "supported",
            rework: "necessary",
            verification: "unknown",
            explanation: "The answer agrees with the exact source.",
            evidenceIds: item.evidence.map((value) => value.id),
          })),
          findings: [],
          proposals: [
            {
              title: "Keep the exact retry limit in Project knowledge",
              target: "knowledge",
              caseIds: [source.id],
              evidenceIds: ["healthy:source"],
              change: "Record the exact retry limit and its source commit.",
              expectedEffect: "Avoid repeatedly searching for the same settled fact.",
              validation:
                "Check against the exact source; a conflicting revision must not retain a stale limit.",
            },
          ],
        } satisfies LearningResult;
      },
    });
    workers.push(worker);
    await Promise.all([worker.sweep(), worker.sweep()]);
    expect(calls).toBe(1);
    expect((await service.get(owned.userID, owned.projectID)).reviews[0]?.calibrated).toBe(true);
    await worker.sweep();
    expect(calls).toBe(2);
    await worker.sweep();
    expect(calls).toBe(2);
    const view = await service.get(owned.userID, owned.projectID);
    expect(view.proposals).toHaveLength(1);
    const proposal = fixtureValue(view.proposals[0], "view.proposals[0]");
    const command = {
      commandId: crypto.randomUUID(),
      proposalId: proposal.id,
      decision: "create-ticket" as const,
    };
    const created = (await service.decide(owned.userID, command)) as { ticketId: string };
    expect(await service.decide(owned.userID, command)).toEqual(created);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${created.ticketId}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${created.ticketId}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.learning_command WHERE id=${command.commandId}`,
    ).toHaveLength(1);
    const [document] =
      await database.client`SELECT author_kind FROM factory.ticket_document_revision WHERE ticket_id=${created.ticketId}`;
    expect(document?.["author_kind"]).toBe("ai");
    for (let index = 0; index < 13; index++)
      await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,
        judge_key,state,input,input_digest,owner_token,owner_expires_at,completed_at)
        VALUES(${crypto.randomUUID()},${owned.projectID},NULL,false,${owned.userID},'calibration','work-review/v1','owned',
          ${`owned:recent:${index}`},'failed','[]'::jsonb,${"c".repeat(64)},${crypto.randomUUID()},now(),now())`;
    expect(
      (await service.get(owned.userID, owned.projectID)).reviews.some(
        (review) => review.id === proposal.reviewId,
      ),
    ).toBe(true);
    await expect(
      (async () => {
        await database.client`UPDATE factory.learning_review SET result='{}'::jsonb WHERE id=${fixtureValue(view.reviews[0], "view.reviews[0]").id}`;
      })(),
    ).rejects.toThrow("immutable");
    const pause = {
      commandId: crypto.randomUUID(),
      projectId: owned.projectID,
      scope: "project",
      expectedVersion: 0,
      enabled: false,
    };
    await service.set(owned.userID, pause);
    await service.set(owned.userID, pause);
    expect((await service.get(owned.userID, owned.projectID, true)).enabled).toBe(false);
    await expect(service.set(owned.userID, { ...pause, enabled: true })).rejects.toThrow(
      "identity",
    );
    // A private proposal cannot leak even to another Project manager.
    const privateSource = { ...source, id: "owned:private", ownerId: owned.userID };
    await database.client`INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected)
      VALUES(${privateSource.id},${owned.projectID},${owned.userID},${owned.userID},false,'research','completed',${source.settledAt},${JSON.stringify(privateSource)}::jsonb,true)`;
    const privateView = await service.get(other, owned.projectID, true);
    expect(privateView.days.reduce((sum, day) => sum + day.observed, 0)).toBe(0);
    expect(JSON.stringify(await service.get(other, owned.projectID))).not.toContain(
      "owned:private",
    );
  } finally {
    for (const worker of workers) worker.close();
    if (previous.url === undefined) delete process.env["FACTORY_MODEL_BASE_URL"];
    else process.env["FACTORY_MODEL_BASE_URL"] = previous.url;
    if (previous.key === undefined) delete process.env["FACTORY_MODEL_API_KEY"];
    else process.env["FACTORY_MODEL_API_KEY"] = previous.key;
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("source collection retains real personal scope and never treats an unsupported activity as observed success", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const conversation = crypto.randomUUID(),
      command = crypto.randomUUID();
    let turn = crypto.randomUUID();
    while (!sampleLearningCase(`turn:${turn}`, "completed")) turn = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
      VALUES(${conversation},${owned.projectID},NULL,'investigate',${owned.userID})`;
    const input = {
      kind: "project-message",
      commandId: command,
      projectId: owned.projectID,
      createdBy: owned.userID,
      conversationId: conversation,
      ticketId: null,
      text: "Private customer research",
    };
    await database.client`INSERT INTO factory.agent_turn(id,command_id,project_id,conversation_id,created_by,input,input_digest,authority,state,outcome_summary)
      VALUES(${turn},${command},${owned.projectID},${conversation},${owned.userID},${JSON.stringify(input)}::jsonb,${"a".repeat(64)},
      ${JSON.stringify({ mode: "investigate", conversationVersion: 1, modelId: "owned" })}::jsonb,'completed','Private observation')`;
    await database.client.begin((sql) =>
      retainLearningArtifactsIn(sql, { id: turn, command: input }, [
        {
          reference: "knowledge:owned:v1",
          body: "Actual source read. MAX_RETRIES = 3.",
          truncated: false,
        },
        { reference: "knowledge:bounded:v1", body: "x".repeat(2_100), truncated: false },
      ]),
    );
    const policy = createLearningService(database);
    await policy.set(owned.userID, {
      commandId: crypto.randomUUID(),
      projectId: owned.projectID,
      scope: "personal",
      expectedVersion: 0,
      enabled: false,
    });
    // Pausing fences new retention even if called from an already admitted Turn.
    await database.client.begin((sql) =>
      retainLearningArtifactsIn(sql, { id: turn, command: input }, [
        { reference: "knowledge:paused:v1", body: "Must not be retained.", truncated: false },
      ]),
    );
    expect(
      await database.client`SELECT ordinal FROM factory.learning_source_artifact WHERE turn_id=${turn}`,
    ).toHaveLength(2);
    await policy.set(owned.userID, {
      commandId: crypto.randomUUID(),
      projectId: owned.projectID,
      scope: "personal",
      expectedVersion: 1,
      enabled: true,
    });
    await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
      VALUES(${`turn:${turn}`},${owned.projectID},${owned.userID},'research','mastra','owned','owned',now(),'completed'),
      ('unsupported:owned',${owned.projectID},${owned.userID},'research','mastra','owned','owned',now(),'completed')`;
    await collectLearningCases(database);
    await collectLearningCases(database);
    const rows =
      await database.client`SELECT id,owner_id,snapshot FROM factory.learning_case ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row["id"] === `turn:${turn}`)?.["owner_id"]).toBe(owned.userID);
    const saved = learningCase.parse(
      rows.find((row) => row["id"] === `turn:${turn}`)?.["snapshot"],
    );
    expect(saved.activity).toBe("research");
    expect(saved.evidence.find((item) => item.id.endsWith(":source:0"))).toMatchObject({
      body: "knowledge:owned:v1\nActual source read. MAX_RETRIES = 3.",
      truncated: false,
    });
    expect(saved.evidence.find((item) => item.id.endsWith(":source:1"))?.truncated).toBe(true);
    expect(JSON.stringify(rows.find((row) => row["id"] === "unsupported:owned"))).not.toContain(
      '"kind":"outcome"',
    );
    const view = await createLearningService(database).get(owned.userID, owned.projectID);
    expect(view.days.reduce((sum, day) => sum + day.observed, 0)).toBe(0);
    expect(JSON.stringify(view)).not.toContain("Private observation");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("a full page of deferred source records does not starve later settled work", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,created_at,settled_at,outcome)
      SELECT 'turn:00000000-0000-4000-8000-'||lpad(n::text,12,'0'),${owned.projectID}::uuid,${owned.userID}::uuid,
        'research','mastra','owned','owned',now()-interval '2 days',now()-interval '1 day','completed'
      FROM generate_series(1,100) AS n`;
    await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
      VALUES('owned:later-settlement',${owned.projectID},${owned.userID},'research','mastra','owned','owned',now(),'completed')`;
    const cursor = await collectLearningCases(database);
    expect(cursor).not.toBeNull();
    expect(await database.client`SELECT id FROM factory.learning_case`).toHaveLength(0);
    await collectLearningCases(database, cursor);
    expect(
      await database.client`SELECT id FROM factory.learning_case WHERE id='owned:later-settlement'`,
    ).toHaveLength(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("pausing private learning fences new retained evidence without changing shared Project authority", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const service = createLearningService(database);
    await service.set(owned.userID, {
      commandId: crypto.randomUUID(),
      projectId: owned.projectID,
      scope: "personal",
      expectedVersion: 0,
      enabled: false,
    });
    await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
      VALUES('owned:paused-private',${owned.projectID},${owned.userID},'research','mastra','owned','owned',now(),'completed')`;
    await collectLearningCases(database);
    expect(await database.client`SELECT id FROM factory.learning_case`).toHaveLength(0);
    await service.set(owned.userID, {
      commandId: crypto.randomUUID(),
      projectId: owned.projectID,
      scope: "personal",
      expectedVersion: 1,
      enabled: true,
    });
    await collectLearningCases(database);
    expect(await database.client`SELECT id FROM factory.learning_case`).toHaveLength(1);
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
      VALUES('owned:revoked-private',${owned.projectID},${owned.userID},'research','mastra','owned','owned',now(),'completed')`;
    await collectLearningCases(database);
    expect(await database.client`SELECT id FROM factory.learning_case`).toHaveLength(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("an uncertain paid review is never replayed, and private proposals require release of the displayed content", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const previous = {
    url: process.env["FACTORY_MODEL_BASE_URL"],
    key: process.env["FACTORY_MODEL_API_KEY"],
  };
  let worker: ReturnType<typeof createLearningWorker> | undefined;
  try {
    const owned = await fixture(undefined, undefined, database);
    process.env["FACTORY_MODEL_BASE_URL"] = "https://owned.invalid/v1";
    process.env["FACTORY_MODEL_API_KEY"] = "owned-not-a-real-key";
    const source: LearningCase = {
      ...fixtureValue(calibrationCases[0], "calibrationCases[0]"),
      id: "owned:uncertain",
      projectId: owned.projectID,
      ownerId: owned.userID,
      settledAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    };
    await database.client`INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected)
      VALUES(${source.id},${owned.projectID},${owned.userID},${owned.userID},false,'research','completed',${source.settledAt},${JSON.stringify(source)}::jsonb,true)`;
    let calls = 0;
    worker = createLearningWorker(database, {
      signingKey: "owned",
      review: async (input) => {
        calls++;
        await input.usage.begin();
        if (calls === 1) {
          await input.usage.settle("completed");
          return calibratedResult();
        }
        throw new Error("Response lost after paid acceptance");
      },
    });
    await worker.sweep();
    await worker.sweep();
    await worker.sweep();
    await worker.sweep();
    expect(calls).toBe(2);
    const [uncertain] = await database.client<
      { id: string; state: string }[]
    >`SELECT id,state FROM factory.learning_review WHERE kind='work'`;
    expect(uncertain?.state).toBe("uncertain");
    expect(await database.client`SELECT id FROM factory.learning_proposal`).toHaveLength(0);
    const [usage] =
      await database.client`SELECT outcome FROM factory.usage_operation WHERE id=${`learning:${fixtureValue(uncertain, "uncertain").id}`}`;
    expect(usage?.["outcome"]).toBe("unknown");
    // An exact, retained private proposal is deliberately separate from source evidence.
    const review = crypto.randomUUID(),
      proposal = crypto.randomUUID();
    const content = {
      title: "Private improvement to share",
      target: "skill",
      caseIds: [source.id],
      evidenceIds: ["healthy:answer"],
      change: "Use the exact source before answering.",
      expectedEffect: "Avoid a repeated lookup.",
      validation: "Compare an answer against the cited source.",
    };
    await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,judge_key,state,input,input_digest,result,owner_token,owner_expires_at,completed_at)
      VALUES(${review},${owned.projectID},${owned.userID},false,${owned.userID},'work','work-review/v1','owned','owned-private','completed',
        ${JSON.stringify([source])}::jsonb,${"a".repeat(64)},${JSON.stringify({
          cases: [
            {
              caseId: source.id,
              fulfillment: "unknown",
              verification: "unknown",
              rework: "unknown",
              explanation: "Original task needs checking.",
              evidenceIds: ["healthy:answer"],
            },
          ],
          findings: [],
          proposals: [content],
        })}::jsonb,${crypto.randomUUID()},now(),now())`;
    await database.client`INSERT INTO factory.learning_proposal(id,review_id,ordinal,content) VALUES(${proposal},${review},0,${JSON.stringify(content)}::jsonb)`;
    const service = createLearningService(database);
    expect((await service.get(owned.userID, owned.projectID)).proposals).toHaveLength(0);
    expect((await service.get(owned.userID, owned.projectID, true)).proposals).toHaveLength(1);
    const command = {
      commandId: crypto.randomUUID(),
      proposalId: proposal,
      decision: "create-ticket",
    };
    await expect(service.decide(owned.userID, command)).rejects.toThrow("Explicitly share");
    const released = (await service.decide(owned.userID, { ...command, releasePrivate: true })) as {
      ticketId: string;
    };
    const [ticket] =
      await database.client`SELECT description FROM factory.ticket WHERE id=${released.ticketId}`;
    expect(ticket?.["description"]).toContain(content.change);
    expect(ticket?.["description"]).not.toContain(source.id);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${released.ticketId}`,
    ).toHaveLength(0);
  } finally {
    worker?.close();
    if (previous.url === undefined) delete process.env["FACTORY_MODEL_BASE_URL"];
    else process.env["FACTORY_MODEL_BASE_URL"] = previous.url;
    if (previous.key === undefined) delete process.env["FACTORY_MODEL_API_KEY"];
    else process.env["FACTORY_MODEL_API_KEY"] = previous.key;
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);
