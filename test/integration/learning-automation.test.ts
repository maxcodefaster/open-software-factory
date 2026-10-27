import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createLearningAutomation } from "../../apps/factory/src/learning/automation";
import { createLearningService } from "../../apps/factory/src/learning/service";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { calibratedResult } from "../fixtures/learning";
import {
  comparisonExample,
  comparisonBefore,
  comparisonAfter,
} from "../fixtures/learning-comparison";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import type { createDatabase } from "../../packages/db/src/client";
import type { LearningEdit } from "../../packages/conversation-domain/src/learning";
import type { ReplayInput } from "../../apps/factory/src/learning/replay";
import type { WorkReviewInput } from "../../apps/factory/src/learning/judge";
import { calibrationCases } from "../../apps/factory/src/learning/calibration";
import { fixtureValue } from "../fixtures/value";

type Database = ReturnType<typeof createDatabase>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const connection = {
  provider: "openai" as const,
  apiKey: "owned-not-used",
  baseURL: "https://example.invalid",
};
async function setup(
  database: Database,
  options: {
    private?: boolean;
    sharedTarget?: boolean;
    roles?: ("planning" | "build")[];
    incomplete?: boolean;
  } = {},
) {
  const owned = await fixture(undefined, undefined, database);
  await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
  const service = createLearningService(database);
  await service.set(owned.userID, {
    commandId: crypto.randomUUID(),
    projectId: owned.projectID,
    scope: options.private ? "personal" : "project",
    expectedVersion: 0,
    enabled: true,
    automaticSkills: true,
  });
  const skills = createSkillController(database);
  const libraryId = crypto.randomUUID(),
    revisionId = crypto.randomUUID();
  const scope =
    options.private && !options.sharedTarget ? ("personal" as const) : ("project" as const);
  const content = {
    key: "owned-compared-method",
    name: "Compared method",
    description: "Use for source-backed research.",
    roles: options.roles ?? ["planning" as const],
    instructions: comparisonBefore,
    references: [],
  };
  await skills.library.save(
    {
      libraryId,
      revisionId,
      scope,
      ...(scope === "project" ? { projectId: owned.projectID } : {}),
      expectedRevision: 0,
      content,
    },
    owned.userID,
  );
  await skills.chooseLibrary(
    {
      libraryId,
      scope,
      projectId: owned.projectID,
      role: "planning",
      state: "enable",
      revisionId,
      expectedVersion: 0,
    },
    owned.userID,
    owned.projectID,
  );
  const edit: LearningEdit = {
    target: { kind: "skill", id: libraryId, revisionId, version: 1, field: "instructions" },
    before: comparisonBefore,
    after: comparisonAfter,
  };
  const example = comparisonExample(owned.projectID, edit, options.private ? owned.userID : null);
  if (options.incomplete) {
    example.cases = example.cases.map((source) => ({
      ...source,
      evidence: source.evidence.filter((item) => item.kind !== "artifact"),
    }));
    example.result.cases = example.result.cases.map((item) => ({
      ...item,
      fulfillment: "unknown",
      rework: "unknown",
      verification: "unknown",
      evidenceIds: [],
    }));
    example.result.findings = [];
  }
  const proposalId = crypto.randomUUID();
  async function saveReview(next = example, proposal = false) {
    const id = crypto.randomUUID();
    await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,judge_key,
      state,input,input_digest,result,owner_token,owner_expires_at,completed_at)
      VALUES(${id},${owned.projectID},${options.private ? owned.userID : null},false,${owned.userID},'work','work-review/v1','owned','owned-judge',
        'completed',${JSON.stringify(next.cases)}::jsonb,${hash(next.cases)},${JSON.stringify(next.result)}::jsonb,${crypto.randomUUID()},now(),now())`;
    for (const source of next.cases)
      await database.client`INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected,batch_id)
        VALUES(${source.id},${owned.projectID},${source.ownerId},${owned.userID},false,'research','completed',now(),${JSON.stringify(source)}::jsonb,true,${id})`;
    if (proposal)
      await database.client`INSERT INTO factory.learning_proposal(id,review_id,ordinal,content)
        VALUES(${proposalId},${id},0,${JSON.stringify(next.content)}::jsonb)`;
    return id;
  }
  await saveReview(
    {
      ...example,
      cases: example.cases.slice(0, 2),
      result: { ...example.result, cases: example.result.cases.slice(0, 2) },
    },
    true,
  );
  await saveReview({
    ...example,
    cases: example.cases.slice(2),
    result: { cases: example.result.cases.slice(2), findings: [], proposals: [] },
  });
  await database.client`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,model_id,judge_key,
    state,input,input_digest,result,calibrated,owner_token,owner_expires_at,completed_at)
    VALUES(${crypto.randomUUID()},${owned.projectID},NULL,false,${owned.userID},'calibration','work-review/v1','owned','owned-judge','completed',
      ${JSON.stringify(calibrationCases)}::jsonb,${hash(calibrationCases)},${JSON.stringify(calibratedResult())}::jsonb,true,${crypto.randomUUID()},now(),now())`;
  let recovery = false,
    calls = 0;
  const replay = async (input: ReplayInput) => {
    calls++;
    await input.authorize();
    return {
      answers: input.cases.map((item, index) => {
        const expected = fixtureValue(
          fixtureValue(
            fixtureValue(
              item.evidence.find((source) => source.kind === "artifact"),
              'item.evidence .find((source) => source.kind === "artifact")',
            ).body.match(/MAX_RETRIES = (\d+)/),
            'item.evidence .find((source) => source.kind === "artifact")! .body.match(/MAX_RETRIES = (\\d+)/)',
          )[1],
          'item.evidence .find((source) => source.kind === "artifact")! .body.match(/MAX_RETRIES = (\\d+)/)![1]',
        );
        const correct = recovery
          ? input.instructions === comparisonBefore
          : input.instructions === comparisonAfter;
        return {
          caseId: item.id,
          body: `${correct || index === 2 ? expected : Number(expected) + 2} [artifact:${index}]`,
        };
      }),
    };
  };
  const review = async (input: WorkReviewInput) => {
    calls++;
    await input.authorize();
    return {
      cases: input.cases.map((item) => {
        const artifact = fixtureValue(
          item.evidence.find((source) => source.kind === "artifact"),
          'item.evidence.find((source) => source.kind === "artifact")',
        );
        const response = fixtureValue(item.evidence.at(-1), "item.evidence.at(-1)");
        const expected = fixtureValue(
          fixtureValue(
            artifact.body.match(/MAX_RETRIES = (\d+)/),
            "artifact.body.match(/MAX_RETRIES = (\\d+)/)",
          )[1],
          "artifact.body.match(/MAX_RETRIES = (\\d+)/)![1]",
        );
        return {
          caseId: item.id,
          fulfillment: response.body.startsWith(`${expected} `)
            ? ("supported" as const)
            : ("problem" as const),
          verification: "supported" as const,
          rework: "unknown" as const,
          explanation: "The actual response is compared to the exact source value.",
          evidenceIds: [artifact.id, response.id],
        };
      }),
      findings: [],
      proposals: [],
    };
  };
  const dependencies = {
    modelIn: async () => ({
      modelId: "owned",
      judgeKey: "owned-judge",
      reference: null,
      fallback: connection,
    }),
    connect: async () => connection,
    replay,
    review,
  };
  return {
    ...owned,
    service,
    skills,
    libraryId,
    revisionId,
    content,
    edit,
    example,
    proposalId,
    saveReview,
    dependencies,
    calls: () => calls,
    async laterUse(appliedRevisionId: string) {
      recovery = true;
      const next = comparisonExample(
        owned.projectID,
        {
          ...edit,
          target: { ...edit.target, revisionId: appliedRevisionId, version: 2 },
        },
        options.private ? owned.userID : null,
      );
      next.cases = next.cases.map((source) => ({
        ...source,
        targets: source.targets.map((target) => ({ ...target, text: comparisonAfter })),
      }));
      next.result.proposals = [];
      await saveReview(next);
    },
  };
}

test("saved scoped permission adopts a demonstrated text fix, records real subsequent use and performs compared protected recovery", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  const automation: ReturnType<typeof createLearningAutomation>[] = [];
  try {
    const value = await setup(database);
    const first = createLearningAutomation(database, value.dependencies);
    automation.push(first);
    expect(await first.sweep()).toBe(true);
    expect(value.calls()).toBe(3);
    const [application] = await database.client<{ id: string; revisionId: string }[]>`
      SELECT id,applied_revision_id AS "revisionId" FROM factory.learning_application WHERE proposal_id=${value.proposalId}`;
    expect(application).toBeDefined();
    const [saved] = await database.client<
      { content: { instructions: string } }[]
    >`SELECT content FROM factory.skill_revision WHERE id=${fixtureValue(application, "application").revisionId}`;
    expect(fixtureValue(saved, "saved").content.instructions).toBe(comparisonAfter);
    expect(await first.sweep()).toBe(false);
    expect(value.calls()).toBe(3);
    const before = await value.service.get(value.userID, value.projectID);
    expect(before.applications[0]).toMatchObject({
      automatic: true,
      subsequent: { sampled: 0, reviewed: 0, problems: 0 },
    });
    expect(before.comparisons[0]?.result?.decision).toBe("applied");
    expect(before.comparisons[0]?.responses).toHaveLength(2);
    await value.laterUse(fixtureValue(application, "application").revisionId);
    const observed = await value.service.get(value.userID, value.projectID);
    expect(observed.applications[0]?.subsequent).toMatchObject({
      sampled: 3,
      reviewed: 3,
      problems: 2,
    });
    expect(observed.applications[0]?.subsequent.cases).toHaveLength(3);
    expect(
      observed.applications[0]?.subsequent.cases.every((use) =>
        use.source.targets.some(
          (target) =>
            target.target.revisionId === fixtureValue(application, "application").revisionId,
        ),
      ),
    ).toBe(true);
    const second = createLearningAutomation(database, value.dependencies);
    automation.push(second);
    expect(await second.sweep()).toBe(true);
    expect(value.calls()).toBe(6);
    const reverted = await value.service.get(value.userID, value.projectID);
    expect(reverted.applications[0]).toMatchObject({ state: "reverted", automaticRecovery: true });
    expect(reverted.comparisons.find((item) => item.phase === "recover")?.result?.decision).toBe(
      "reverted",
    );
    const [latest] = await database.client<{ content: { instructions: string } }[]>`
      SELECT revision.content FROM factory.skill_library_revision link JOIN factory.skill_revision revision ON revision.id=link.revision_id
      WHERE link.library_id=${value.libraryId} ORDER BY revision.revision DESC LIMIT 1`;
    expect(fixtureValue(latest, "latest").content.instructions).toBe(comparisonBefore);
    await expect(
      (async () => {
        await database.client`UPDATE factory.learning_trial SET input='{}'::jsonb WHERE proposal_id=${value.proposalId}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await database.client`UPDATE factory.learning_trial_step SET result='{}'::jsonb WHERE trial_id=${fixtureValue(before.comparisons[0], "before.comparisons[0]").id}`;
      })(),
    ).rejects.toThrow("immutable");
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
  } finally {
    for (const worker of automation) worker.close();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

for (const fence of [
  "pause",
  "newer-revision",
  "newer-choice",
  "authority-loss",
  "lease-loss",
  "unknown",
] as const) {
  test(`automatic comparison fences ${fence} without a write or paid replay`, async () => {
    const host = await factoryProcess(),
      database = host.connect();
    let worker: ReturnType<typeof createLearningAutomation> | undefined;
    try {
      const value = await setup(database);
      let calls = 0;
      worker = createLearningAutomation(database, {
        ...value.dependencies,
        replay: async (input) => {
          calls++;
          if (fence === "newer-choice")
            await value.skills.chooseLibrary(
              {
                libraryId: value.libraryId,
                scope: "project",
                projectId: value.projectID,
                role: "planning",
                state: "enable",
                revisionId: value.revisionId,
                expectedVersion: 1,
              },
              value.userID,
              value.projectID,
            );
          if (fence === "lease-loss")
            await database.client`UPDATE factory.learning_trial SET owner_expires_at=now()-interval '1 second' WHERE proposal_id=${value.proposalId}`;
          if (fence === "pause")
            await value.service.set(value.userID, {
              commandId: crypto.randomUUID(),
              projectId: value.projectID,
              scope: "project",
              expectedVersion: 1,
              enabled: false,
              automaticSkills: true,
            });
          if (fence === "authority-loss")
            await database.client`UPDATE factory.project_membership SET manage_project=false WHERE project_id=${value.projectID} AND user_id=${value.userID}`;
          if (fence === "newer-revision")
            await value.skills.library.save(
              {
                libraryId: value.libraryId,
                revisionId: crypto.randomUUID(),
                scope: "project",
                projectId: value.projectID,
                expectedRevision: 1,
                content: { ...value.content, instructions: "Newer human guidance must win." },
              },
              value.userID,
            );
          if (fence === "unknown") throw new Error("Lost provider response");
          return value.dependencies.replay(input);
        },
      });
      expect(await worker.sweep()).toBe(true);
      expect(calls).toBe(1);
      expect(await worker.sweep()).toBe(false);
      expect(calls).toBe(1);
      expect(await database.client`SELECT id FROM factory.learning_application`).toHaveLength(0);
      const [trial] = await database.client`SELECT state FROM factory.learning_trial`;
      expect(trial?.["state"]).toBe(fence === "unknown" ? "uncertain" : "failed");
    } finally {
      worker?.close();
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  }, 60_000);
}
test("concurrent workers cannot duplicate a comparison, and a healthy baseline never earns adoption", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  const workers: ReturnType<typeof createLearningAutomation>[] = [];
  try {
    const value = await setup(database);
    let replayCalls = 0;
    const dependencies = {
      ...value.dependencies,
      replay: async (input: ReplayInput) => {
        replayCalls++;
        return value.dependencies.replay({ ...input, instructions: comparisonAfter });
      },
    };
    workers.push(
      createLearningAutomation(database, dependencies),
      createLearningAutomation(database, dependencies),
    );
    expect(
      (await Promise.all(workers.map((worker) => worker.sweep()))).filter(Boolean),
    ).toHaveLength(1);
    expect(replayCalls).toBe(2);
    const view = await value.service.get(value.userID, value.projectID);
    expect(view.comparisons[0]?.result).toMatchObject({ passed: false, decision: "kept" });
    expect(view.proposals[0]?.state).toBe("proposed");
    expect(view.applications).toHaveLength(0);
    await Promise.all(workers.map((worker) => worker.sweep()));
    expect(replayCalls).toBe(2);
  } finally {
    for (const worker of workers) worker.close();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);
test("private-to-shared edits, Build guidance and incomplete tasks stay manual without inference", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  const workers: ReturnType<typeof createLearningAutomation>[] = [];
  try {
    for (const options of [
      { private: true, sharedTarget: true },
      { roles: ["planning", "build"] as ("planning" | "build")[] },
      { incomplete: true },
    ]) {
      const value = await setup(database, options);
      const worker = createLearningAutomation(database, value.dependencies);
      workers.push(worker);
      expect(await worker.sweep()).toBe(false);
      expect(value.calls()).toBe(0);
    }
    expect(await database.client`SELECT id FROM factory.learning_application`).toHaveLength(0);
  } finally {
    for (const worker of workers) worker.close();
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);
