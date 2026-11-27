import { expect, test } from "bun:test";
import type postgres from "postgres";
import { emergencyAdministratorID } from "#auth/policy";
import { type createDatabase, drizzleTransaction } from "#db/client";
import type { ProjectRole } from "#project-domain/access";
import { createAccountCommands } from "./accounts";
import {
  projectAuthorityIn,
  projectDevelopmentAuthorityIn,
  requireActiveAccountIn,
  requireSystemManagerIn,
} from "./authority";
import { createAccessController } from "./controller";
import { createMembershipCommands } from "./membership";

const actorID = "01994a7d-0000-7000-8000-000000000010";
const targetID = "01994a7d-0000-7000-8000-000000000011";
const projectID = "01994a7d-0000-7000-8000-000000000012";
type Rows = unknown[][];
type Statement = { text: string; parameters: unknown[]; transaction: boolean; raw: boolean };

// Use the actual Drizzle builder and result mapping, replacing only PostgreSQL I/O.
// Like Postgres 4's real TransactionSql, this transaction has no pool options.
function accessDatabase(responses: Rows[]) {
  const remaining = [...responses];
  const statements: Statement[] = [];
  let transactions = 0;
  function connection(transaction: boolean) {
    return Object.assign(
      (strings: TemplateStringsArray, ...parameters: unknown[]) => {
        const text = strings.join("?");
        expect(text).toContain("pg_advisory_xact_lock");
        statements.push({ text, parameters, transaction, raw: true });
        return Promise.resolve([]);
      },
      {
        unsafe(text: string, parameters: unknown[]) {
          statements.push({ text, parameters, transaction, raw: false });
          const rows = remaining.shift();
          if (!rows) throw new Error(`Unexpected query: ${text}`);
          return Object.assign(Promise.resolve(rows), { values: () => Promise.resolve(rows) });
        },
      },
    );
  }
  const transaction = connection(true) as unknown as postgres.TransactionSql;
  const client = Object.assign(connection(false), {
    options: { parsers: {}, serializers: {} },
    async begin<T>(callback: (sql: postgres.TransactionSql) => Promise<T>) {
      transactions += 1;
      return callback(transaction);
    },
  }) as unknown as postgres.Sql;
  const database = {
    client,
    db: drizzleTransaction(client),
    coordination: () => {
      throw new Error("Unexpected coordination connection");
    },
  } as ReturnType<typeof createDatabase>;
  return {
    database,
    transaction,
    statements,
    assertComplete(expectedTransactions = 0) {
      expect(remaining).toHaveLength(0);
      expect(transactions).toBe(expectedTransactions);
    },
  };
}

function projectRows(
  role: ProjectRole | null = "developer",
  manageProject = false,
  systemManager = false,
  exists = true,
): Rows[] {
  return [
    [[actorID]],
    [[null, null]],
    role ? [[role, manageProject]] : [],
    systemManager ? [[actorID]] : [],
    exists ? [[projectID]] : [],
  ];
}

test("active account authority rejects missing, manually disabled and directory-disabled accounts", async () => {
  for (const [user, access] of [
    [[], [[null, null]]],
    [[[actorID]], []],
    [[[actorID]], [["2026-11-20T00:00:00Z", null]]],
    [[[actorID]], [[null, "2026-11-20T00:00:00Z"]]],
  ] satisfies Array<[Rows, Rows]>) {
    const fixture = accessDatabase([user, access]);
    await expect(requireActiveAccountIn(fixture.transaction, actorID)).rejects.toMatchObject({
      code: "forbidden",
      message: "Account access is disabled",
    });
    fixture.assertComplete();
    expect(fixture.statements).toHaveLength(2);
    for (const statement of fixture.statements) {
      expect(statement.transaction).toBe(true);
      expect(statement.raw).toBe(false);
      expect(statement.text).toEndWith("for share");
      expect(statement.parameters).toEqual([actorID]);
    }
  }
});

test("project development and management share one locked authority read without conflating roles", async () => {
  for (const [role, manageProject, systemManager, develop, manage] of [
    ["product-contributor", false, false, false, false],
    ["product-contributor", true, false, false, true],
    ["developer", false, false, true, false],
    ["developer", true, false, true, true],
    [null, false, true, true, true],
  ] satisfies Array<[ProjectRole | null, boolean, boolean, boolean, boolean]>) {
    const fixture = accessDatabase(projectRows(role, manageProject, systemManager));
    const controller = createAccessController(fixture.database);
    expect(await controller.canDevelop(actorID, projectID)).toBe(develop);
    fixture.assertComplete(1);
    expect(fixture.statements).toHaveLength(5);
    for (const statement of fixture.statements) expect(statement.transaction).toBe(true);
    expect(fixture.statements[2]?.text).toEndWith("for share");
    expect(fixture.statements[2]?.parameters).toEqual([projectID, actorID]);
    expect(fixture.statements[3]?.text).toEndWith("for share");

    const managed = accessDatabase(projectRows(role, manageProject, systemManager));
    expect(await projectAuthorityIn(managed.transaction, actorID, projectID)).toBe(manage);
    managed.assertComplete();
    const development = accessDatabase(projectRows(role, manageProject, systemManager));
    const required = projectDevelopmentAuthorityIn(development.transaction, actorID, projectID);
    if (develop) await required;
    else await expect(required).rejects.toThrow("Developer access required");
    development.assertComplete();
    expect(development.statements).toHaveLength(5);
  }
});

test("project authority preserves missing-project masking and explicit management requirements", async () => {
  for (const rows of [projectRows(null), projectRows("developer", false, true, false)]) {
    const fixture = accessDatabase(rows);
    await expect(projectAuthorityIn(fixture.transaction, actorID, projectID)).rejects.toMatchObject(
      {
        code: "not-found",
        message: "Project not found",
      },
    );
    fixture.assertComplete();
  }
  const fixture = accessDatabase(projectRows());
  await expect(projectAuthorityIn(fixture.transaction, actorID, projectID, true)).rejects.toThrow(
    "Project Manager access required",
  );
  fixture.assertComplete();
});

test("System Manager checks keep account and administrator locks in one transaction", async () => {
  for (const administrator of [true, false]) {
    const fixture = accessDatabase([[[actorID]], [[null, null]], administrator ? [[actorID]] : []]);
    expect(await createAccessController(fixture.database).isSystemManager(actorID)).toBe(
      administrator,
    );
    fixture.assertComplete(1);
    expect(fixture.statements.every((statement) => statement.transaction)).toBe(true);
    expect(fixture.statements[2]?.text).toEndWith("for share");
  }
  const denied = accessDatabase([[[actorID]], [[null, null]], []]);
  await expect(
    requireSystemManagerIn(denied.transaction, actorID, "Rates require a System Manager"),
  ).rejects.toThrow("Rates require a System Manager");
  denied.assertComplete();
  const disabled = accessDatabase([[[actorID]], [[null, "2026-11-20T00:00:00Z"]]]);
  await expect(createAccessController(disabled.database).isSystemManager(actorID)).rejects.toThrow(
    "Account access is disabled",
  );
  disabled.assertComplete(1);
});

test("entity access uses typed entity reads followed by current Project authority", async () => {
  for (const entity of ["ticket", "change", "runtime"] as const) {
    const fixture = accessDatabase([
      entity === "runtime" ? [[projectID, "ticket", null, targetID]] : [[projectID]],
      ...projectRows(),
    ]);
    const controller = createAccessController(fixture.database);
    if (entity === "ticket") await controller.requireTicket(actorID, targetID);
    else if (entity === "change")
      expect(await controller.requireChange(actorID, targetID)).toBe(projectID);
    else await controller.requireRuntime(actorID, targetID, "ide");
    fixture.assertComplete(1);
    expect(fixture.statements[0]?.transaction).toBe(false);
    expect(fixture.statements[0]?.text).toContain(
      `"factory"."${entity === "runtime" ? "runtime_attempt" : entity}"`,
    );
    expect(fixture.statements[0]?.parameters).toEqual([targetID]);
    expect(fixture.statements.slice(1).every((statement) => statement.transaction)).toBe(true);
  }
  const fixture = accessDatabase([]);
  await createAccessController(fixture.database).authorizeAPI(
    new Request("https://factory.invalid/api/health"),
    actorID,
  );
  fixture.assertComplete();
});

test("missing entities retain not-found errors without starting unrelated authority checks", async () => {
  for (const [entity, message] of [
    ["ticket", "Ticket not found"],
    ["change", "Change not found"],
    ["runtime", "Runtime not found"],
  ] as const) {
    const fixture = accessDatabase([[]]);
    const controller = createAccessController(fixture.database);
    const required =
      entity === "ticket"
        ? controller.requireTicket(actorID, targetID)
        : entity === "change"
          ? controller.requireChange(actorID, targetID)
          : controller.requireRuntime(actorID, targetID);
    await expect(required).rejects.toMatchObject({ code: "not-found", message });
    fixture.assertComplete();
    expect(fixture.statements).toHaveLength(1);
  }
});

test("runtime App access permits Contributors while IDE access requires development", async () => {
  for (const channel of ["app", "ide"] as const) {
    const fixture = accessDatabase([
      [[projectID, "ticket", null, targetID]],
      ...projectRows("product-contributor", true),
    ]);
    const required = createAccessController(fixture.database).requireRuntime(
      actorID,
      targetID,
      channel,
    );
    if (channel === "app") await required;
    else await expect(required).rejects.toThrow("Developer access required");
    fixture.assertComplete(1);
  }
});

test("account disablement uses typed writes while retaining policy and target locks", async () => {
  const fixture = accessDatabase([
    [[actorID]],
    [[null, null]],
    [[actorID]],
    [[targetID]],
    [],
    [],
    [],
  ]);
  await createAccountCommands(fixture.database).disable(actorID, targetID, true);
  fixture.assertComplete(1);
  expect(fixture.statements.every((statement) => statement.transaction)).toBe(true);
  expect(fixture.statements[0]?.raw).toBe(true);
  expect(fixture.statements[4]?.text).toEndWith("for update");
  const safeguards = fixture.statements[5];
  expect(safeguards?.text).toContain(
    'not exists (select "other"."user_id" from "factory"."project_membership" "other"',
  );
  expect(safeguards?.text).toContain(
    '"other"."project_id" = "factory"."project_membership"."project_id"',
  );
  expect(safeguards?.parameters).toEqual([targetID, true, targetID, true, 1]);
  expect(safeguards?.text).toContain('"disabled_at" is null');
  expect(safeguards?.text).toContain('"directory_disabled_at" is null');
  expect(fixture.statements[6]?.text).toContain(
    'update "factory"."account_access" set "disabled_at" = now()',
  );
  expect(fixture.statements[6]?.parameters).toEqual([actorID, targetID]);
  expect(fixture.statements[7]?.text).toContain('delete from "auth"."session"');
  expect(fixture.statements[7]?.parameters).toEqual([targetID]);
});

test("account reenablement retains directory state and does not delete sessions", async () => {
  const fixture = accessDatabase([[[actorID]], [[null, null]], [[actorID]], [[targetID]], []]);
  await createAccountCommands(fixture.database).disable(actorID, targetID, false);
  fixture.assertComplete(1);
  expect(fixture.statements.at(-1)?.text).toStartWith('update "factory"."account_access"');
  expect(fixture.statements.at(-1)?.parameters).toEqual([null, actorID, targetID]);
  expect(fixture.statements.at(-1)?.text).not.toContain("directory_disabled_at");
  expect(fixture.statements.some((statement) => statement.text.startsWith("delete"))).toBe(false);
});

test("account safeguards reject self, emergency, missing and stranded accounts before any write", async () => {
  for (const [userID, account, stranded, message] of [
    [
      actorID,
      [[actorID]],
      false,
      "The emergency administrator and your own account must remain available",
    ],
    [
      emergencyAdministratorID,
      [[emergencyAdministratorID]],
      false,
      "The emergency administrator and your own account must remain available",
    ],
    [targetID, [], false, "Account not found"],
    [targetID, [[targetID]], true, "Assign another Project Manager before disabling this account"],
  ] satisfies Array<[string, Rows, boolean, string]>) {
    const fixture = accessDatabase([
      [[actorID]],
      [[null, null]],
      [[actorID]],
      account,
      ...(stranded ? [[[projectID]]] : []),
    ]);
    await expect(
      createAccountCommands(fixture.database).disable(actorID, userID, true),
    ).rejects.toThrow(message);
    fixture.assertComplete(1);
    expect(fixture.statements.every((statement) => !/^(update|delete)/.test(statement.text))).toBe(
      true,
    );
  }
});

test("account changes reject disabled actors and ordinary members before locking the target", async () => {
  for (const [responses, message] of [
    [[[[actorID]], [[null, "2026-11-20T00:00:00Z"]]], "Account access is disabled"],
    [[[[actorID]], [[null, null]], []], "System Manager access required"],
  ] satisfies Array<[Rows[], string]>) {
    const fixture = accessDatabase(responses);
    await expect(
      createAccountCommands(fixture.database).disable(actorID, targetID, true),
    ).rejects.toThrow(message);
    fixture.assertComplete(1);
    expect(fixture.statements.some((statement) => statement.text.endsWith("for update"))).toBe(
      false,
    );
  }
});

test("session termination permits self-service and requires active administrator authority for other accounts", async () => {
  for (const self of [true, false]) {
    const userID = self ? actorID : targetID;
    const fixture = accessDatabase([
      [[actorID]],
      [[null, null]],
      ...(self ? [] : [[[actorID]]]),
      [[userID]],
      [],
    ]);
    await createAccountCommands(fixture.database).endSessions(actorID, userID);
    fixture.assertComplete(1);
    expect(fixture.statements.at(-2)?.text).toEndWith("for update");
    expect(fixture.statements.at(-1)?.text).toContain('delete from "auth"."session"');
    expect(fixture.statements.at(-1)?.parameters).toEqual([userID]);
    expect(fixture.statements.every((statement) => statement.transaction)).toBe(true);
  }
  const fixture = accessDatabase([[[actorID]], [[null, null]], []]);
  await expect(
    createAccountCommands(fixture.database).endSessions(actorID, targetID),
  ).rejects.toThrow("System Manager access required");
  fixture.assertComplete(1);
});

test("membership updates normalize email and use typed conflict updates under existing locks", async () => {
  const fixture = accessDatabase([
    ...projectRows("product-contributor", true),
    [[targetID]],
    [[targetID, "developer", false]],
    [[targetID]],
    [[null, null]],
    [[targetID, "product-contributor", true]],
  ]);
  const saved = await createMembershipCommands(fixture.database).change({
    projectID,
    actorID,
    target: { email: "TARGET@FACTORY.LOCAL", role: "product-contributor", manageProject: true },
  });
  expect(saved).toEqual({ userId: targetID, role: "product-contributor", manageProject: true });
  fixture.assertComplete(1);
  expect(fixture.statements.slice(0, 2).every((statement) => statement.raw)).toBe(true);
  expect(fixture.statements[1]?.parameters).toEqual([`project-membership:${projectID}`]);
  expect(fixture.statements[7]?.parameters).toEqual(["target@factory.local"]);
  expect(fixture.statements[7]?.text).toEndWith("for share");
  expect(fixture.statements[8]?.text).toEndWith("for update");
  expect(fixture.statements.at(-1)?.text).toContain(
    'on conflict ("project_id","user_id") do update',
  );
  expect(fixture.statements.at(-1)?.text).toContain('"updated_at" = now()');
  expect(fixture.statements.every((statement) => statement.transaction)).toBe(true);
});

test("membership self-upgrades and disabled targets are denied before writing", async () => {
  for (const [target, active, message] of [
    [actorID, [[null, null]], "Another Project Manager must grant Developer access"],
    [targetID, [[null, "2026-11-20T00:00:00Z"]], "Account access is disabled"],
  ] satisfies Array<[string, Rows, string]>) {
    const fixture = accessDatabase([
      ...projectRows("product-contributor", true),
      [[target]],
      [[target, "product-contributor", false]],
      [[target]],
      active,
    ]);
    await expect(
      createMembershipCommands(fixture.database).change({
        projectID,
        actorID,
        target: { email: "target@factory.local", role: "developer", manageProject: false },
      }),
    ).rejects.toThrow(message);
    fixture.assertComplete(1);
    expect(fixture.statements.some((statement) => statement.text.startsWith("insert"))).toBe(false);
  }
});

test("membership removal preserves the last-active-manager safeguard and typed deletion", async () => {
  for (const other of [true, false]) {
    const fixture = accessDatabase([
      ...projectRows("developer", true),
      [[targetID]],
      [[targetID, "product-contributor", true]],
      other ? [[actorID]] : [],
      ...(other ? [[]] : []),
    ]);
    const removal = createMembershipCommands(fixture.database).change({
      projectID,
      actorID,
      target: { userID: targetID },
    });
    if (other) expect(await removal).toBeNull();
    else
      await expect(removal).rejects.toThrow(
        "Assign another Project Manager before removing the last one",
      );
    fixture.assertComplete(1);
    const safeguards = fixture.statements[9];
    expect(safeguards?.text).toContain('"disabled_at" is null');
    expect(safeguards?.text).toContain('"directory_disabled_at" is null');
    if (other) {
      expect(fixture.statements.at(-1)?.text).toContain(
        'delete from "factory"."project_membership"',
      );
      expect(fixture.statements.at(-1)?.parameters).toEqual([projectID, targetID]);
    }
  }
});

test("membership changes do not report an unconfirmed upsert as saved", async () => {
  const fixture = accessDatabase([
    ...projectRows("developer", true),
    [[targetID]],
    [],
    [[targetID]],
    [[null, null]],
    [],
  ]);
  await expect(
    createMembershipCommands(fixture.database).change({
      projectID,
      actorID,
      target: { email: "target@factory.local", role: "developer", manageProject: false },
    }),
  ).rejects.toMatchObject({ code: "conflict", message: "Project membership was not saved" });
  fixture.assertComplete(1);
});
