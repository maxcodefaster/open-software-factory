import { test, expect } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";
import { createUsagePolicy, codingBudgetIn } from "../../apps/factory/src/usage/policy";
import { createUsageJournal } from "../../apps/factory/src/usage/journal";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import { createUsageService } from "../../apps/factory/src/usage/service";
import { createContractRates } from "../../apps/factory/src/usage/contract-rates";
import { fixture } from "../fixtures/change-agent-turns";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { fixtureValue } from "../fixtures/value";

test("calendar reset excludes expired unknowns and concurrent threshold requests admit no new Coding", async () => {
  const isolated = await factoryProcess();
  const database = isolated.connect();
  try {
    const first = await fixture(undefined, undefined, database);
    const second = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
      VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), codingUSD: 1 })}::jsonb,'Europe/Berlin',${first.userID})`;
    await database.client`INSERT INTO factory.usage_operation(id,project_id,user_id,purpose,engine,provider,model,created_at,settled_at,outcome)
      VALUES('owned:expired',${first.projectID},${first.userID},'coding','opencode','owned','exact',
        date_trunc('month',now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'-interval '1 second',now(),'unknown')`;
    const read = () => database.client.begin((sql) => codingBudgetIn(sql, first.projectID, false));
    const reset = await read();
    expect(reset.allowed).toBe(true);
    expect(reset.scopes.every((scope) => scope.knownNanoUSD === "0" && !scope.incomplete)).toBe(
      true,
    );
    const [period] = await database.client<
      { reset: Date }[]
    >`SELECT (date_trunc('month',now() AT TIME ZONE 'Europe/Berlin')+interval '1 month') AT TIME ZONE 'Europe/Berlin' AS reset`;
    expect(reset.scopes[0]?.reset).toBe(period && new Date(period.reset).toISOString());
    const journal = createUsageJournal(database);
    await journal.begin({
      id: "owned:current",
      projectID: first.projectID,
      userID: first.userID,
      purpose: "coding",
      engine: "opencode",
      provider: "owned",
      model: "exact",
      rate: {
        provider: "owned",
        model: "exact",
        source: "contract",
        fetchedAt: new Date().toISOString(),
        tiers: [{ above: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
      },
    });
    await journal.record("owned:current", {
      eventID: "step:1",
      source: "step",
      outcome: "completed",
      counters: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      occurredAt: new Date().toISOString(),
    });
    const requests = await Promise.allSettled(
      [first, second].map((work) =>
        createChangeAdmission(database, "owned-model").admit(work.changeID, work.userID, {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Must not start at the shared threshold",
        }),
      ),
    );
    expect(
      requests.every(
        (result) => result.status === "rejected" && result.reason?.code === "conflict",
      ),
    ).toBe(true);
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(
      (await database.client.begin((sql) => codingBudgetIn(sql, second.projectID, true))).allowed,
    ).toBe(true);
    await journal.begin({
      id: "owned:unknown",
      projectID: first.projectID,
      userID: first.userID,
      purpose: "coding",
      engine: "opencode",
      provider: "owned",
      model: "missing",
      rate: null,
    });
    await journal.settle("owned:unknown", "unknown");
    expect((await read()).reason).toBe("accounting-incomplete");
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify(defaultExecutionPolicy())}::jsonb WHERE scope='factory'`;
    expect((await read()).allowed).toBe(true);
    expect((await read()).scopes[0]?.incomplete).toBe(true);
  } finally {
    await database.client.end();
    await isolated.dispose();
  }
}, 60000);

test("policy commands serialize versions, replay exact intent and enforce Project tightening and budgets", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  const manager = crypto.randomUUID(),
    member = crypto.randomUUID(),
    outsider = crypto.randomUUID(),
    project = crypto.randomUUID();
  const policy = createUsagePolicy(database),
    journal = createUsageJournal(database);
  try {
    await database.client.begin(async (sql) => {
      for (const user of [manager, member, outsider])
        await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${user},'Owned usage',${`${user}@factory.local`},true)`;
      await sql`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
      await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${project},${`owned-usage-${project.slice(0, 8)}`},'Owned usage','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
      await sql`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${project},${member},'product-contributor',false,${manager})`;
    });
    expect((await policy.get(member, project)).effective.codingUSD).toBeNull();
    await expect(policy.get(member, null)).rejects.toMatchObject({ code: "forbidden" });
    await expect(policy.get(outsider, project)).rejects.toMatchObject({ code: "not-found" });
    const command = {
      commandID: crypto.randomUUID(),
      version: 0,
      policy: { ...defaultExecutionPolicy(), codingUSD: 1 },
      timezone: "Europe/Berlin",
    };
    const saved = await policy.set(manager, null, command);
    expect(await policy.set(manager, null, command)).toEqual(saved);
    await expect(
      policy.set(manager, null, { ...command, policy: { ...command.policy, codingUSD: 2 } }),
    ).rejects.toMatchObject({ code: "conflict" });
    const concurrent = await Promise.allSettled(
      [1, 2].map(() =>
        policy.set(manager, null, { ...command, commandID: crypto.randomUUID(), version: 1 }),
      ),
    );
    expect(concurrent.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    await expect(
      policy.set(member, project, {
        ...command,
        commandID: crypto.randomUUID(),
        timezone: undefined,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      policy.set(manager, project, {
        commandID: crypto.randomUUID(),
        version: 0,
        policy: { ...command.policy, codingUSD: 2 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await policy.set(manager, project, {
      commandID: crypto.randomUUID(),
      version: 0,
      policy: { ...command.policy, codingUSD: 0.5 },
    });
    const read = (continuation = false) =>
      database.client.begin((sql) => codingBudgetIn(sql, project, continuation));
    expect((await read()).allowed).toBe(true);
    await journal.begin({
      id: "owned:coding",
      projectID: project,
      userID: member,
      purpose: "coding",
      engine: "opencode",
      provider: "owned",
      model: "exact",
      rate: {
        provider: "owned",
        model: "exact",
        source: "contract",
        fetchedAt: new Date().toISOString(),
        tiers: [{ above: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
      },
    });
    await journal.record("owned:coding", {
      eventID: "step:1",
      source: "step",
      outcome: "completed",
      counters: { input: 500000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      occurredAt: new Date().toISOString(),
    });
    expect((await read()).reason).toBe("coding-budget-used");
    expect((await read(true)).allowed).toBe(true);
    await journal.record("owned:coding", {
      eventID: "step:2",
      source: "step",
      outcome: "completed",
      counters: { input: 50000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      occurredAt: new Date().toISOString(),
    });
    expect((await read(true)).reason).toBe("finish-reserve-used");
    // Exempt work is still recorded but cannot consume the Coding allowance.
    await journal.begin({
      id: "owned:research",
      projectID: project,
      userID: member,
      purpose: "research",
      engine: "mastra",
      provider: "owned",
      model: "exact",
      rate: null,
    });
    await journal.record("owned:research", {
      eventID: "unknown",
      source: "unobserved",
      outcome: "unknown",
      counters: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
      occurredAt: new Date().toISOString(),
    });
    expect((await read(true)).reason).toBe("finish-reserve-used");
    expect((await read()).timezone).toBe("Europe/Berlin");
    const memberView = await policy.get(member, project);
    expect(memberView.scopes.map((scope) => scope.scope)).toEqual([project]);
    expect((await policy.get(manager, null)).scopes.map((scope) => scope.scope)).toEqual([null]);
    const service = createUsageService(database);
    expect((await service.get(member, project)).scopes.map((scope) => scope.scope)).toEqual([
      project,
    ]);
    const rates = createContractRates(database);
    const rateCommand = {
      commandID: crypto.randomUUID(),
      version: 0,
      provider: "owned",
      model: "exact",
      tiers: [{ above: 0, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }],
    };
    await expect(rates.set(member, rateCommand)).rejects.toMatchObject({ code: "forbidden" });
    const savedRate = await rates.set(manager, rateCommand);
    expect(await rates.set(manager, rateCommand)).toEqual(savedRate);
    expect((await rates.get("owned", "exact"))?.tiers[0]?.input).toBe(3);
    await rates.set(manager, {
      ...rateCommand,
      commandID: crypto.randomUUID(),
      version: 1,
      tiers: [{ ...fixtureValue(rateCommand.tiers[0], "rateCommand.tiers[0]"), input: 9 }],
    });
    expect((await rates.get("owned", "exact"))?.tiers[0]?.input).toBe(9);
    const [historical] = await database.client<
      Array<{ rate: { tiers: Array<{ input: number }> } }>
    >`SELECT rate FROM factory.usage_operation WHERE id='owned:coding'`;
    expect(historical?.rate.tiers[0]?.input).toBe(1);
    const otherProject = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${otherProject},${`owned-private-${otherProject.slice(0, 8)}`},'Other Project','https://example.invalid/private.git','main','.devcontainer/devcontainer.json',${manager})`;
    for (const [id, projectID, userID, model] of [
      ["owned:manager-detail", project, manager, "other-member-model"],
      ["owned:private-detail", otherProject, manager, "other-project-model"],
    ] as const) {
      await journal.begin({
        id,
        projectID,
        userID,
        purpose: "research",
        engine: "mastra",
        provider: "owned",
        model,
        rate: null,
      });
      await journal.record(id, {
        eventID: "step",
        source: "step",
        outcome: "completed",
        counters: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        occurredAt: new Date().toISOString(),
      });
    }
    const ownView = await policy.get(member, project);
    expect(ownView.detailScope).toBe("own");
    expect(ownView.summary.map((row) => row.model)).not.toContain("other-member-model");
    expect(ownView.summary.map((row) => row.model)).not.toContain("other-project-model");
    await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${project} AND user_id=${member}`;
    const projectView = await policy.get(member, project);
    expect(projectView.summary.map((row) => row.model)).toContain("other-member-model");
    expect(projectView.summary.map((row) => row.model)).not.toContain("other-project-model");
    expect(projectView.detailScope).toBe("project");
    expect((await policy.get(manager, null)).summary.map((row) => row.model)).toContain(
      "other-project-model",
    );
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${project} AND user_id=${member}`;
    await expect(policy.get(member, project)).rejects.toMatchObject({ code: "not-found" });
  } finally {
    await database.client.end();
    await owned.dispose();
  }
}, 60000);
