import { expect, test } from "bun:test";
import { createLearningService } from "../../apps/factory/src/learning/service";
import { learningEditDigest } from "../../apps/factory/src/learning/targets";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { editKnowledgeIn } from "../../apps/factory/src/knowledge/edit";
import type { LearningEdit } from "../../packages/conversation-domain/src/learning";
import { retainedEditProposal } from "../fixtures/learning-edit";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import type { createDatabase } from "../../packages/db/src/client";
import { createLearningWorker } from "../../apps/factory/src/learning/worker";
import { calibrationCases } from "../../apps/factory/src/learning/calibration";
import { calibratedResult } from "../fixtures/learning";
import { fixtureValue } from "../fixtures/value";

const before = "Ask for a hostname before looking at repository sources.";
const after = "Inspect repository sources before asking for a hostname.";
const instructions = `${before}\nNever change approvals or execution permissions.`;

test("personal guidance adoption changes only its Project activation and stays private", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const first = await fixture(undefined, undefined, database),
      second = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${second.projectID},${first.userID},'developer',${second.userID})`;
    const skills = createSkillController(database),
      libraryId = crypto.randomUUID(),
      revisionId = crypto.randomUUID();
    await skills.library.save(
      {
        libraryId,
        revisionId,
        scope: "personal",
        expectedRevision: 0,
        content: {
          key: "owned-private-method",
          name: "Private method",
          description: "Use for source-backed work.",
          roles: ["planning"],
          instructions,
          references: [],
        },
      },
      first.userID,
    );
    for (const projectId of [first.projectID, second.projectID])
      await skills.chooseLibrary(
        {
          libraryId,
          scope: "personal",
          projectId,
          role: "planning",
          state: "enable",
          revisionId,
          expectedVersion: 0,
        },
        first.userID,
        projectId,
      );
    const edit: LearningEdit = {
      target: { kind: "skill", id: libraryId, revisionId, version: 1, field: "instructions" },
      before,
      after,
    };
    const proposal = await retainedEditProposal(database, {
      projectId: first.projectID,
      userId: first.userID,
      edit,
      text: instructions,
      private: true,
    });
    const service = createLearningService(database),
      view = await service.get(first.userID, first.projectID, true);
    expect(view.proposals[0]?.requiresPrivateRelease).toBe(false);
    const applied = (await service.decide(first.userID, {
      commandId: crypto.randomUUID(),
      proposalId: proposal.id,
      decision: "apply",
      editDigest: learningEditDigest(edit),
    })) as { revisionId: string };
    const [own] =
      await database.client`SELECT revision_id FROM factory.skill_library_choice WHERE library_id=${libraryId} AND scope='personal' AND context_id=${first.projectID}`;
    const [other] =
      await database.client`SELECT revision_id,version FROM factory.skill_library_choice WHERE library_id=${libraryId} AND scope='personal' AND context_id=${second.projectID}`;
    expect(own?.["revision_id"]).toBe(applied.revisionId);
    expect(other).toMatchObject({ revision_id: revisionId, version: "1" });
    expect(
      (await skills.getLibrary(second.userID, second.projectID)).entries.some(
        (item) => item.id === libraryId,
      ),
    ).toBe(false);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("Monitoring refuses a result whose development permission was revoked during its read", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const value = await skillExample(database);
    await retainedEditProposal(database, {
      projectId: value.projectID,
      userId: value.userID,
      edit: value.edit,
      text: instructions,
      developerOnly: true,
      title: "Owned development-only finding",
    });
    let changed = false;
    const client = new Proxy(database.client, {
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args);
        if (
          Array.isArray(args[0]) &&
          args[0].join("?").includes("FROM factory.learning_application application")
        )
          return (async () => {
            const rows = await result;
            if (!changed) {
              changed = true;
              await database.client`UPDATE factory.project_membership SET role='product-contributor'
            WHERE project_id=${value.projectID} AND user_id=${value.userID}`;
            }
            return rows;
          })();
        return result;
      },
    });
    await expect(
      createLearningService({ ...database, client }).get(value.userID, value.projectID),
    ).rejects.toThrow("permissions changed");
    const current = await value.service.get(value.userID, value.projectID);
    expect(JSON.stringify(current)).not.toContain("Owned development-only finding");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("a private owner can release an exact edit request without publishing its case packet or granting implementation", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const value = await skillExample(database);
    const proposal = await retainedEditProposal(database, {
      projectId: value.projectID,
      userId: value.userID,
      edit: value.edit,
      text: instructions,
      private: true,
    });
    await database.client`UPDATE factory.project_membership SET manage_project=false WHERE project_id=${value.projectID} AND user_id=${value.userID}`;
    const request = {
      commandId: crypto.randomUUID(),
      proposalId: proposal.id,
      decision: "create-ticket",
      releasePrivate: true,
    };
    await expect(value.service.decide(value.userID, request)).rejects.toThrow(
      "exact proposed edit",
    );
    const command = { ...request, editDigest: learningEditDigest(value.edit) };
    const result = (await value.service.decide(value.userID, command)) as { ticketId: string };
    expect(await value.service.decide(value.userID, command)).toEqual(result);
    const [ticket] = await database.client<
      { description: string }[]
    >`SELECT description FROM factory.ticket WHERE id=${result.ticketId}`;
    expect(ticket?.description).toContain(before);
    expect(ticket?.description).toContain(after);
    expect(ticket?.description).toContain(value.revisionId);
    expect(ticket?.description).not.toContain(proposal.source.id);
    expect(ticket?.description).not.toContain("Owned fixture observed");
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${result.ticketId}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.learning_application WHERE proposal_id=${proposal.id}`,
    ).toHaveLength(0);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("private setup lessons do not flow into a later non-manager research review", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  const previous = {
    url: process.env["FACTORY_MODEL_BASE_URL"],
    key: process.env["FACTORY_MODEL_API_KEY"],
  };
  let worker: ReturnType<typeof createLearningWorker> | undefined;
  try {
    const value = await skillExample(database);
    await retainedEditProposal(database, {
      projectId: value.projectID,
      userId: value.userID,
      edit: value.edit,
      text: instructions,
      private: true,
      activity: "setup",
      title: "PRIVATE-SETUP-NOTE-CONTENT",
    });
    await database.client`UPDATE factory.project_membership SET manage_project=false WHERE project_id=${value.projectID} AND user_id=${value.userID}`;
    const source = {
      ...fixtureValue(calibrationCases[0], "calibrationCases[0]"),
      id: "owned:later-private-research",
      projectId: value.projectID,
      ownerId: value.userID,
      settledAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    };
    await database.client`INSERT INTO factory.learning_case(id,project_id,owner_id,reviewer_id,developer_only,activity,outcome,settled_at,snapshot,selected)
      VALUES(${source.id},${value.projectID},${value.userID},${value.userID},false,'research','completed',${source.settledAt},${JSON.stringify(source)}::jsonb,true)`;
    process.env["FACTORY_MODEL_BASE_URL"] = "https://owned.invalid/v1";
    process.env["FACTORY_MODEL_API_KEY"] = "owned-not-a-secret";
    const packets: string[] = [];
    worker = createLearningWorker(database, {
      signingKey: "owned",
      review: async (input) => {
        if (fixtureValue(input.cases[0], "input.cases[0]").id.startsWith("calibration:"))
          return calibratedResult();
        packets.push(JSON.stringify(input.cases));
        return {
          cases: input.cases.map((item) => ({
            caseId: item.id,
            fulfillment: "unknown",
            rework: "unknown",
            verification: "unknown",
            explanation: "Owned observation.",
            evidenceIds: [],
          })),
          findings: [],
          proposals: [],
        };
      },
    });
    await worker.sweep();
    await worker.sweep();
    expect(packets).toHaveLength(1);
    expect(packets[0]).not.toContain("PRIVATE-SETUP-NOTE-CONTENT");
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

async function skillExample(database: ReturnType<typeof createDatabase>) {
  const owned = await fixture(undefined, undefined, database);
  await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
  const skills = createSkillController(database);
  const libraryId = crypto.randomUUID(),
    revisionId = crypto.randomUUID();
  const content = {
    key: "owned-research-method",
    name: "Owned research method",
    description: "Use for source-backed investigation.",
    roles: ["planning", "build"] as Array<"planning" | "build">,
    instructions,
    references: [],
  };
  await skills.library.save(
    {
      libraryId,
      revisionId,
      expectedRevision: 0,
      scope: "project",
      projectId: owned.projectID,
      content,
    },
    owned.userID,
  );
  for (const role of content.roles)
    await skills.chooseLibrary(
      {
        libraryId,
        scope: "project",
        projectId: owned.projectID,
        role,
        state: "enable",
        revisionId,
        expectedVersion: 0,
      },
      owned.userID,
      owned.projectID,
    );
  const edit: LearningEdit = {
    target: { kind: "skill", id: libraryId, revisionId, version: 1, field: "instructions" },
    before,
    after,
  };
  const proposal = await retainedEditProposal(database, {
    projectId: owned.projectID,
    userId: owned.userID,
    edit,
    text: instructions,
  });
  const service = createLearningService(database);
  const apply = {
    commandId: crypto.randomUUID(),
    proposalId: proposal.id,
    decision: "apply" as const,
    editDigest: learningEditDigest(edit),
  };
  return { ...owned, skills, libraryId, revisionId, content, edit, proposal, service, apply };
}

test("a confirmed Skill edit atomically publishes, adopts for new work, and rolls back without rewriting admitted intent", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const value = await skillExample(database);
    const turn = crypto.randomUUID(),
      command = crypto.randomUUID();
    const authority = {
      mode: "build",
      requirementRevisionId: value.revisionID,
      modelId: "owned",
      skillRevisionIds: [value.revisionId],
    };
    await database.client`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority,state)
      VALUES(${turn},${command},${value.projectID},${value.ticketID},${value.changeID},${value.userID},
        ${JSON.stringify({ kind: "change-start", commandId: command, projectId: value.projectID, ticketId: value.ticketID, changeId: value.changeID, createdBy: value.userID, conversationId: null })}::jsonb,
        ${"a".repeat(64)},${JSON.stringify(authority)}::jsonb,'completed')`;
    // A manager may maintain defaults without acquiring development authority.
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${value.projectID} AND user_id=${value.userID}`;
    const applied = (await value.service.decide(value.userID, value.apply)) as {
      applicationId: string;
      revisionId: string;
    };
    expect(await value.service.decide(value.userID, value.apply)).toEqual(applied);
    const library = await value.skills.getLibrary(value.userID, value.projectID);
    const current = fixtureValue(
      fixtureValue(
        library.entries.find((item) => item.id === value.libraryId),
        "library.entries.find((item) => item.id === value.libraryId)",
      ).revisions[0],
      "library.entries.find((item) => item.id === value.libraryId)!.revisions[0]",
    );
    expect(current.id).toBe(applied.revisionId);
    expect(current.content.instructions).toBe(instructions.replace(before, after));
    expect(current.content.roles).toEqual(value.content.roles);
    expect(
      library.choices
        .filter((choice) => choice.libraryId === value.libraryId)
        .every((choice) => choice.revisionId === applied.revisionId),
    ).toBe(true);
    const [retained] = await database.client<
      { authority: unknown }[]
    >`SELECT authority FROM factory.agent_turn WHERE id=${turn}`;
    expect(retained?.authority).toEqual(authority);
    const undo = {
      commandId: crypto.randomUUID(),
      applicationId: applied.applicationId,
      expectedRevisionId: applied.revisionId,
    };
    const reverted = (await value.service.rollback(value.userID, undo)) as {
      revisionId: string;
      version: number;
    };
    expect(await value.service.rollback(value.userID, undo)).toEqual(reverted);
    expect(reverted.version).toBe(3);
    const restored = await value.skills.getLibrary(value.userID, value.projectID);
    expect(
      fixtureValue(
        fixtureValue(
          restored.entries.find((item) => item.id === value.libraryId),
          "restored.entries.find((item) => item.id === value.libraryId)",
        ).revisions[0],
        "restored.entries.find((item) => item.id === value.libraryId)!.revisions[0]",
      ).content.instructions,
    ).toBe(instructions);
    expect(
      restored.choices
        .filter((choice) => choice.libraryId === value.libraryId)
        .every((choice) => choice.revisionId === reverted.revisionId),
    ).toBe(true);
    const [application] =
      await database.client`SELECT state,reverted_revision_id FROM factory.learning_application WHERE id=${applied.applicationId}`;
    expect(application?.["state"]).toBe("reverted");
    await expect(
      (async () => {
        await database.client`UPDATE factory.learning_application SET applied_by=${crypto.randomUUID()} WHERE id=${applied.applicationId}`;
      })(),
    ).rejects.toThrow("immutable");
    const repeatEdit = {
      ...value.edit,
      target: { ...value.edit.target, revisionId: reverted.revisionId, version: 3 },
    };
    const repeat = await retainedEditProposal(database, {
      projectId: value.projectID,
      userId: value.userID,
      edit: repeatEdit,
      text: instructions,
    });
    await expect(
      value.service.decide(value.userID, {
        ...value.apply,
        commandId: crypto.randomUUID(),
        proposalId: repeat.id,
        editDigest: learningEditDigest(repeatEdit),
      }),
    ).rejects.toThrow("already rolled back");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("Skill application and rollback preserve newer human revisions, explicit choices and inherited authority", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const value = await skillExample(database);
    await expect(
      value.service.decide(value.userID, { ...value.apply, editDigest: "b".repeat(64) }),
    ).rejects.toThrow("exact proposed edit");
    const applied = (await value.service.decide(value.userID, value.apply)) as {
      applicationId: string;
      revisionId: string;
    };
    await value.skills.chooseLibrary(
      {
        libraryId: value.libraryId,
        scope: "project",
        projectId: value.projectID,
        role: "planning",
        state: "disable",
        revisionId: applied.revisionId,
        expectedVersion: 2,
      },
      value.userID,
      value.projectID,
    );
    await expect(
      value.service.rollback(value.userID, {
        commandId: crypto.randomUUID(),
        applicationId: applied.applicationId,
        expectedRevisionId: applied.revisionId,
      }),
    ).rejects.toThrow("choices changed");
    const human = crypto.randomUUID();
    await value.skills.library.save(
      {
        libraryId: value.libraryId,
        revisionId: human,
        expectedRevision: 2,
        scope: "project",
        projectId: value.projectID,
        content: { ...value.content, instructions: "A newer human method." },
      },
      value.userID,
    );
    await expect(
      value.service.rollback(value.userID, {
        commandId: crypto.randomUUID(),
        applicationId: applied.applicationId,
        expectedRevisionId: applied.revisionId,
      }),
    ).rejects.toThrow("newer or unavailable revision");
    await database.client`UPDATE factory.project_membership SET manage_project=false WHERE project_id=${value.projectID} AND user_id=${value.userID}`;
    await expect(
      value.service.rollback(value.userID, {
        commandId: crypto.randomUUID(),
        applicationId: applied.applicationId,
        expectedRevisionId: applied.revisionId,
      }),
    ).rejects.toThrow("Project Manager");
    expect(
      fixtureValue(
        fixtureValue(
          (await value.skills.getLibrary(value.userID, value.projectID)).entries.find(
            (item) => item.id === value.libraryId,
          ),
          "(await value.skills.getLibrary(value.userID, value.projectID)).entries.find( (item) => item.id === value.libraryId, )",
        ).revisions[0],
        "(await value.skills.getLibrary(value.userID, value.projectID)).entries.find( (item) => item.id === value.libraryId, )!.r",
      ).id,
    ).toBe(human);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("private Knowledge edits require release of the exact edit, preserve human notes, and retain immutable history", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const page = crypto.randomUUID(),
      base = crypto.randomUUID(),
      body = `${before}\n\nHuman note: preserve this paragraph.`;
    await database.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${page},${owned.projectID},'owned-guide','  Owned guide  ',${body},${before},${"a".repeat(40)},${owned.userID})`;
    await database.client`INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,created_by)
      VALUES(${base},${page},1,'human','  Owned guide  ',${body},${before},${"a".repeat(40)},${owned.userID})`;
    await database.client`UPDATE factory.knowledge_page SET current_revision_id=${base} WHERE id=${page}`;
    const edit: LearningEdit = {
      target: { kind: "knowledge", id: page, revisionId: base, version: 1, field: "body" },
      before,
      after,
    };
    const proposal = await retainedEditProposal(database, {
      projectId: owned.projectID,
      userId: owned.userID,
      edit,
      text: body,
      private: true,
    });
    const service = createLearningService(database);
    const command = {
      commandId: crypto.randomUUID(),
      proposalId: proposal.id,
      decision: "apply",
      editDigest: learningEditDigest(edit),
    };
    await expect(service.decide(owned.userID, command)).rejects.toThrow(
      "release this exact private edit",
    );
    const applied = (await service.decide(owned.userID, { ...command, releasePrivate: true })) as {
      applicationId: string;
      revisionId: string;
    };
    const [saved] =
      await database.client`SELECT title,current_body,generated_body,version FROM factory.knowledge_page WHERE id=${page}`;
    expect(saved?.["title"]).toBe("  Owned guide  ");
    expect(saved?.["current_body"]).toBe(body.replace(before, after));
    expect(saved?.["generated_body"]).toBe(before);
    const [count] =
      await database.client`SELECT count(*)::int AS count FROM factory.knowledge_revision WHERE page_id=${page}`;
    expect(count?.["count"]).toBe(2);
    const rollback = (await service.rollback(owned.userID, {
      commandId: crypto.randomUUID(),
      applicationId: applied.applicationId,
      expectedRevisionId: applied.revisionId,
    })) as { revisionId: string };
    expect(rollback.revisionId).not.toBe(base);
    const [restored] =
      await database.client`SELECT current_body,generated_body,version FROM factory.knowledge_page WHERE id=${page}`;
    expect(restored?.["current_body"]).toBe(body);
    expect(restored?.["version"]).toBe("3");
    // A later human edit is an authority fence, never a rollback target.
    const secondEdit = {
      ...edit,
      target: { ...edit.target, revisionId: rollback.revisionId, version: 3 },
      after: "Check sources before asking a human.",
    };
    const second = await retainedEditProposal(database, {
      projectId: owned.projectID,
      userId: owned.userID,
      edit: secondEdit,
      text: body,
      private: true,
    });
    const appliedAgain = (await service.decide(owned.userID, {
      ...command,
      commandId: crypto.randomUUID(),
      proposalId: second.id,
      releasePrivate: true,
      editDigest: learningEditDigest(secondEdit),
    })) as { applicationId: string; revisionId: string };
    await database.client.begin((sql) =>
      editKnowledgeIn(
        sql,
        page,
        { expectedVersion: 4, title: "Owned guide", body: "A newer human document." },
        owned.userID,
      ),
    );
    await expect(
      service.rollback(owned.userID, {
        commandId: crypto.randomUUID(),
        applicationId: appliedAgain.applicationId,
        expectedRevisionId: appliedAgain.revisionId,
      }),
    ).rejects.toThrow("changed");
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);

test("Input edits preserve the delegation, sources, key and enabled state and wait for admitted work", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.project_membership SET role='product-contributor',manage_project=true
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const hook = crypto.randomUUID(),
      policy = crypto.randomUUID(),
      incident = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.monitoring_hook(id,project_id,name,version,enabled,secret_digest,policy_id)
        VALUES(${hook},${owned.projectID},'Owned task',1,true,${"a".repeat(64)},${policy})`;
      await sql`INSERT INTO factory.monitoring_policy(id,hook_id,delegated_by,delegation,instructions,source_assignments)
        VALUES(${policy},${hook},${owned.userID},'prepare-ticket',${instructions},'[]'::jsonb)`;
    });
    await database.client`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,fingerprint,payload_digest,title,context,state)
      VALUES(${incident},${hook},${owned.projectID},${policy},1,${"b".repeat(64)},${"c".repeat(64)},'Owned event','Owned event','queued')`;
    const edit: LearningEdit = {
      target: { kind: "input", id: hook, revisionId: policy, version: 1, field: "instructions" },
      before,
      after,
    };
    const proposal = await retainedEditProposal(database, {
      projectId: owned.projectID,
      userId: owned.userID,
      edit,
      text: instructions,
    });
    const service = createLearningService(database),
      command = {
        commandId: crypto.randomUUID(),
        proposalId: proposal.id,
        decision: "apply",
        editDigest: learningEditDigest(edit),
      };
    await expect(service.decide(owned.userID, command)).rejects.toThrow("must settle");
    await database.client`UPDATE factory.monitoring_incident SET state='insufficient-context',settled_at=now() WHERE id=${incident}`;
    const applied = (await service.decide(owned.userID, command)) as {
      applicationId: string;
      revisionId: string;
    };
    const [same] =
      await database.client`SELECT (to_jsonb(original)-'id'-'instructions')=(to_jsonb(changed)-'id'-'instructions') AS same
      FROM factory.monitoring_policy original,factory.monitoring_policy changed WHERE original.id=${policy} AND changed.id=${applied.revisionId}`;
    expect(same?.["same"]).toBe(true);
    const [saved] =
      await database.client`SELECT enabled,secret_digest,version FROM factory.monitoring_hook WHERE id=${hook}`;
    expect(saved).toMatchObject({ enabled: true, secret_digest: "a".repeat(64), version: "2" });
    await service.rollback(owned.userID, {
      commandId: crypto.randomUUID(),
      applicationId: applied.applicationId,
      expectedRevisionId: applied.revisionId,
    });
    const [restored] =
      await database.client`SELECT policy.instructions,hook.enabled,hook.version FROM factory.monitoring_hook hook
      JOIN factory.monitoring_policy policy ON policy.id=hook.policy_id WHERE hook.id=${hook}`;
    expect(restored).toMatchObject({ instructions, enabled: true, version: "3" });
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id<>${owned.ticketID}`,
    ).toHaveLength(0);
  } finally {
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 60_000);
