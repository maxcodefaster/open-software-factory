import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createModelSettingsController } from "../../apps/factory/src/models/controller";
import { createMonitoringWorker } from "../../apps/factory/src/monitoring/worker";
import { createSkillController } from "../../apps/factory/src/skills/controller";
import { monitoringFixture } from "../fixtures/monitoring";
import type { diagnoseMonitoringIncident } from "../../apps/factory/src/monitoring/diagnosis";
import type { clarifyProjectInput } from "../../apps/factory/src/project-agent/input";
import { fixtureValue } from "../fixtures/value";

const codeCommit = "a".repeat(40);
const diagnosis = {
  outcome: "fix" as const,
  explanation: "The source dereferences an absent invoice.",
  title: "Handle an absent invoice",
  requirements: {
    summary: "Return the existing not-found result for absent invoices.",
    acceptanceCriteria: ["An absent invoice no longer throws.", "Existing invoices still work."],
    nonGoals: ["No infrastructure, dependency or access-policy changes."],
  },
  code: [{ path: "src/invoice.ts", commitSha: codeCommit }],
};
const environment = {
  FACTORY_PROJECT_AGENT_MODEL: "owned-shared-model",
  FACTORY_AGENT_MODEL_ID: "owned-shared-model",
  FACTORY_MODEL_IDS: "owned-personal-model",
  FACTORY_PLANNING_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
  FACTORY_PLANNING_MODEL_API_KEY: "owned-unused-model-key",
};
function configureModels() {
  const old = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  return () => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("Inputs prepare one unapproved Ticket automatically without development authority or personal sources", async () => {
  const restore = configureModels();
  const f = await monitoringFixture();
  let calls = 0;
  let worker: ReturnType<typeof createMonitoringWorker> | undefined;
  try {
    await f.addSource("personal");
    // Project management and source execution are independent permissions.
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${f.projectId},${f.userId},'product-contributor',true,${f.userId})`;
    await f.database.client`DELETE FROM factory.administrator WHERE user_id=${f.userId}`;
    const hookId = crypto.randomUUID();
    const task = "Prepare actionable product feedback. Never start implementation.";
    const saved = await f.controller.save(f.projectId, f.userId, {
      id: hookId,
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Product feedback",
      instructions: task,
      enabled: true,
    });
    const prepare: typeof clarifyProjectInput = async (input) => {
      calls++;
      expect(input.instructions).toBe(task);
      expect(input.modelId).toBe("owned-shared-model");
      expect(input.assignments).toEqual([]);
      expect(input.skillAssignment.codeAccess).toBe(false);
      await input.authorize();
      await input.usage.begin();
      await input.usage.settle("completed");
      return { ...diagnosis, outcome: "ticket", code: [] };
    };
    worker = createMonitoringWorker(f.database, {
      mcp: f.mcp,
      code: {
        codePaths: async () => {
          throw new Error("No development authority");
        },
        code: async () => {
          throw new Error("No development authority");
        },
      },
      changes: {
        start: async () => {
          throw new Error("Input must not implement");
        },
      },
      agent: {
        admitStartIn: async () => {
          throw new Error("Input must not admit Build");
        },
      },
      delivery: {
        get: async () => null,
        approve: async () => {
          throw new Error("Input must not deliver");
        },
      },
      signingKey: "owned-worker-key",
      prepare,
    });
    const receive = () =>
      f.routes.intake(
        new Request(fixtureValue(saved.url, "saved.url"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "feedback-42",
            title: "Invoice feedback",
            body: "Make exports easier",
          }),
        }),
      );
    expect((await receive())?.status).toBe(202);
    await worker.project(f.projectId);
    expect((await receive())?.status).toBe(202);
    await worker.project(f.projectId);
    expect(calls).toBe(1);
    const view = await f.controller.view(f.projectId, f.userId);
    expect(view).toMatchObject({ canManage: true, canDelegate: false });
    expect(view.incidents[0]).toMatchObject({ state: "prepared", occurrences: 2 });
    const ticketId = fixtureValue(
      fixtureValue(view.incidents[0], "view.incidents[0]").ticketId,
      "view.incidents[0]!.ticketId",
    );
    expect(
      await f.database
        .client`SELECT id FROM factory.requirement_revision WHERE ticket_id=${ticketId}`,
    ).toHaveLength(1);
    expect(
      await f.database
        .client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketId}`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT id FROM factory.change WHERE ticket_id=${ticketId}`,
    ).toHaveLength(0);
    expect(
      await f.database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketId}`,
    ).toHaveLength(0);
    const [conversation] = await f.database
      .client`SELECT mode FROM factory.ticket_conversation WHERE ticket_id=${ticketId}`;
    expect(conversation?.["mode"]).toBe("plan");
    await expect(
      f.controller.save(f.projectId, f.userId, {
        id: crypto.randomUUID(),
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        name: "Disallowed Autofix",
        enabled: true,
        delegation: "application-fix-and-delivery",
        connectionIds: [f.source.id],
      }),
    ).rejects.toThrow("Developer");
  } finally {
    await worker?.close();
    await f.dispose();
    restore();
  }
});

test("Input policies freeze explicit shared sources and inherited defaults, excluding personal sources", async () => {
  const f = await monitoringFixture();
  try {
    const second = await f.addSource("project");
    const personal = await f.addSource("personal");
    for (const source of [f.source, personal])
      await f.mcp.library.choose(
        {
          libraryId: source.id,
          revisionId: source.revisionId,
          scope: source === personal ? "personal" : "project",
          projectId: f.projectId,
          role: "planning",
          state: "enable",
          expectedVersion: 0,
        },
        f.userId,
      );
    const inherited = await f.controller.save(f.projectId, f.userId, {
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Inherited sources",
      enabled: true,
    });
    const explicit = await f.controller.save(f.projectId, f.userId, {
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      name: "Two sources",
      enabled: true,
      connectionIds: [f.source.id, second.id],
    });
    const deliver = async (url: string) => {
      const response = await f.routes.intake(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Feedback", id: crypto.randomUUID() }),
        }),
      );
      expect(response?.status).toBe(202);
    };
    await deliver(fixtureValue(inherited.url, "inherited.url"));
    await deliver(fixtureValue(explicit.url, "explicit.url"));
    const events = (await f.controller.view(f.projectId, f.userId)).incidents;
    const authorities = await Promise.all(events.map((event) => f.controller.authorize(event.id)));
    expect(
      authorities
        .find((authority) => !authority.sourceIds.length)
        ?.assignments.map((a) => a.connectionId),
    ).toEqual([f.source.id]);
    expect(
      authorities.find((authority) => !authority.sourceIds.length)?.assignments[0]?.required,
    ).toBe(false);
    expect(
      authorities
        .find((authority) => authority.sourceIds.length)
        ?.assignments.map((a) => a.connectionId),
    ).toEqual([f.source.id, second.id]);
    await expect(
      f.controller.save(f.projectId, f.userId, {
        id: crypto.randomUUID(),
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        name: "Private leak",
        enabled: true,
        connectionIds: [personal.id],
      }),
    ).rejects.toThrow("never personal");
    await f.database
      .client`UPDATE factory.mcp_connection SET state='revoked' WHERE id=${second.id}`;
    await expect(
      f.controller.authorize(
        fixtureValue(
          authorities.find((authority) => authority.sourceIds.length),
          "authorities.find((authority) => authority.sourceIds.length)",
        ).id,
      ),
    ).rejects.toThrow("Reconnect");
  } finally {
    await f.dispose();
  }
});

test("Autofix freezes shared configuration, creates one delegated scope and fences queued Build on disable", async () => {
  const restore = configureModels();
  const f = await monitoringFixture();
  const turns = createAgentTurnStore(f.database);
  const settings = createModelSettingsController(f.database);
  const skills = createSkillController(f.database);
  const admission = createChangeAdmission(f.database, (sql, context) =>
    settings.resolve("build", sql, context),
  );
  let diagnoses = 0;
  let commissioned = 0;
  const workers: ReturnType<typeof createMonitoringWorker>[] = [];
  try {
    await settings.setPersonal(f.projectId, f.userId, {
      version: 0,
      planningModelId: "owned-personal-model",
      buildModelId: "owned-personal-model",
    });
    const privateSource = await f.addSource("personal");
    await f.mcp.library.choose(
      {
        libraryId: privateSource.id,
        revisionId: privateSource.revisionId,
        scope: "personal",
        projectId: f.projectId,
        role: "build",
        state: "enable",
        expectedVersion: 0,
      },
      f.userId,
    );
    const privateSkill = { libraryId: crypto.randomUUID(), revisionId: crypto.randomUUID() };
    await skills.library.save(
      {
        ...privateSkill,
        expectedRevision: 0,
        scope: "personal",
        content: {
          key: "owned-personal-guidance",
          name: "Private guidance",
          description: "Use for the owned fixture",
          instructions: "This private guidance must not reach background Autofix.",
          roles: ["build"],
          references: [],
        },
      },
      f.userId,
    );
    await skills.chooseLibrary(
      {
        ...privateSkill,
        scope: "personal",
        projectId: f.projectId,
        role: "build",
        state: "enable",
        expectedVersion: 0,
      },
      f.userId,
      f.projectId,
    );
    const incidentId = await f.receive();
    const diagnose: typeof diagnoseMonitoringIncident = async (input) => {
      diagnoses++;
      expect(input.modelId).toBe("owned-shared-model");
      expect(input.assignment.connectionId).toBe(f.source.id);
      await input.authorize();
      await input.usage.begin();
      await input.usage.settle("completed");
      return diagnosis;
    };
    const input: Parameters<typeof createMonitoringWorker>[1] = {
      mcp: f.mcp,
      code: {
        codePaths: async () => ({ commitSha: codeCommit, paths: [], truncated: false }),
        code: async () => {
          throw new Error("The controlled diagnosis has no additional reads");
        },
      },
      changes: {
        start: async (ticketId, userId, implementation) => {
          if (!implementation) throw new Error("Missing exact Build admission");
          expect(implementation.expectedBaseSHA).toBe(codeCommit);
          commissioned++;
          await f.database.client.begin(async (sql) => {
            const [approved] = await sql<
              { id: string }[]
            >`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketId}`;
            if (!approved) throw new Error("Missing delegated requirements");
            const changeId = crypto.randomUUID();
            await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
            VALUES(${changeId},${f.projectId},${ticketId},${approved.id},${`factory/change-${changeId.replaceAll("-", "").slice(0, 12)}`},${codeCommit},'active',${userId})`;
            await implementation.admitBuild(sql, changeId);
          });
          return null;
        },
      },
      agent: {
        admitStartIn: (sql, changeId, userId, commandId) =>
          admission.admitIn(sql, changeId, userId, { kind: "change-start", commandId }),
      },
      delivery: {
        get: async () => null,
        approve: async () => {
          throw new Error("Pending Build cannot deliver");
        },
      },
      signingKey: "owned-worker-key",
      diagnose,
    };
    const one = createMonitoringWorker(f.database, input);
    const two = createMonitoringWorker(f.database, input);
    workers.push(one, two);
    await Promise.all([one.project(f.projectId), two.project(f.projectId)]);
    expect(diagnoses).toBe(1);
    let view = await f.controller.view(f.projectId, f.userId);
    expect(view.incidents[0]?.state).toBe("implementing");
    await one.project(f.projectId);
    expect(commissioned).toBe(1);
    const initial = await turns.getByCommand(incidentId);
    if (initial?.authority.mode !== "build") throw new Error("Missing admitted Autofix Build");
    expect(initial.authority.modelId).toBe("owned-shared-model");
    expect(initial.authority.monitoringIncidentId).toBe(incidentId);
    expect(initial.authority.skillRevisionIds).not.toContain(privateSkill.revisionId);
    expect(
      (await f.mcp.library.assignments(initial.id)).map((source) => source.connectionId),
    ).toEqual([f.source.id]);
    const [basis] = await f.database.client<{ incidentId: string; policyId: string }[]>`
      SELECT monitoring_incident_id AS "incidentId",monitoring_policy_id AS "policyId"
      FROM factory.requirement_approval WHERE ticket_id=${view.incidents[0]?.ticketId ?? null}`;
    expect(basis?.incidentId).toBe(incidentId);
    expect(basis?.policyId).toBe(view.hooks[0]?.policyId);
    await f.receive();
    await one.project(f.projectId);
    expect(diagnoses).toBe(1);
    expect(commissioned).toBe(1);
    await f.controller.change(f.projectId, f.hookId, f.userId, "disable", {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
    });
    const claimed = await turns.claimPending(initial.id);
    if (!claimed?.ownerToken) throw new Error("Missing owned pending lease");
    expect(await turns.validateExecution(initial.id, claimed.ownerToken)).toBe(false);
    expect(await turns.beginDispatch(initial.id, claimed.ownerToken)).toBeNull();
    await turns.releasePending(initial.id, claimed.ownerToken);
    await one.project(f.projectId);
    view = await f.controller.view(f.projectId, f.userId);
    expect(view.incidents[0]?.state).toBe("blocked");
    expect(view.incidents[0]?.reason).toContain("disabled");
    expect(view.incidents[0]?.occurrences).toBe(2);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await f.dispose();
    restore();
  }
});

test("Monitoring shutdown aborts and joins an admitted diagnosis before its database is closed", async () => {
  const restore = configureModels();
  const f = await monitoringFixture();
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const worker = createMonitoringWorker(f.database, {
    mcp: f.mcp,
    code: {
      codePaths: async () => {
        throw new Error("Unused owned inventory");
      },
      code: async () => {
        throw new Error("Unused owned source");
      },
    },
    changes: {
      start: async () => {
        throw new Error("Shutdown cannot commission implementation");
      },
    },
    agent: {
      admitStartIn: async () => {
        throw new Error("Shutdown cannot admit Build");
      },
    },
    delivery: {
      get: async () => null,
      approve: async () => {
        throw new Error("Shutdown cannot deliver");
      },
    },
    signingKey: "owned-shutdown-key",
    diagnose: async (input) => {
      calls++;
      if (!input.signal) throw new Error("Owned diagnosis cancellation signal missing");
      entered.resolve(input.signal);
      await finish.promise;
      throw new Error("Owned interrupted diagnosis");
    },
  });
  try {
    await f.receive("owned-shutdown");
    const work = worker.project(f.projectId);
    const signal = await entered.promise;
    let drained = false;
    const closing = worker.close().then(() => {
      drained = true;
    });
    expect(signal.aborted).toBe(true);
    await Bun.sleep(5);
    expect(drained).toBe(false);
    await worker.project(f.projectId);
    expect(calls).toBe(1);
    finish.resolve();
    await Promise.all([work, closing]);
    expect(drained).toBe(true);
    expect(
      await f.database.client`SELECT id FROM factory.change WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  } finally {
    finish.resolve();
    await worker.close();
    await f.dispose();
    restore();
  }
}, 60_000);

test("insufficient and uncertain diagnoses never create Tickets or repeat paid inference after expiry", async () => {
  const restore = configureModels();
  const f = await monitoringFixture();
  let calls = 0;
  let worker: ReturnType<typeof createMonitoringWorker> | undefined;
  try {
    worker = createMonitoringWorker(f.database, {
      mcp: f.mcp,
      code: {
        codePaths: async () => ({ commitSha: codeCommit, paths: [], truncated: false }),
        code: async () => {
          throw new Error("No code in this controlled diagnosis");
        },
      },
      changes: {
        start: async () => {
          throw new Error("Non-fix diagnosis must not commission Build");
        },
      },
      agent: {
        admitStartIn: async () => {
          throw new Error("No Build allowed");
        },
      },
      delivery: { get: async () => null, approve: async () => null },
      signingKey: "owned-worker-key",
      diagnose: async () => {
        calls++;
        return {
          ...diagnosis,
          outcome: "insufficient-context",
          explanation: "No matching incident context was found.",
          requirements: null,
          code: [],
        };
      },
    });
    await f.receive("missing-context");
    await worker.project(f.projectId);
    expect((await f.controller.view(f.projectId, f.userId)).incidents[0]?.state).toBe(
      "insufficient-context",
    );
    await f.receive("missing-context");
    await worker.project(f.projectId);
    expect(calls).toBe(1);
    const interrupted = await f.receive("interrupted-diagnosis");
    await f.database
      .client`UPDATE factory.monitoring_incident SET state='diagnosing',owner_token=${crypto.randomUUID()},
      owner_expires_at=now()-interval '1 second',started_at=now()-interval '3 minutes' WHERE id=${interrupted}`;
    await worker.sweep();
    const [row] = await f.database.client<{ state: string; ticketId: string | null }[]>`
      SELECT state,ticket_id AS "ticketId" FROM factory.monitoring_incident WHERE id=${interrupted}`;
    expect(row?.state).toBe("uncertain");
    expect(row?.ticketId).toBeNull();
    await worker.project(f.projectId);
    expect(calls).toBe(1);
    expect(
      await f.database.client`SELECT id FROM factory.ticket WHERE project_id=${f.projectId}`,
    ).toHaveLength(0);
  } finally {
    await worker?.close();
    await f.dispose();
    restore();
  }
});
