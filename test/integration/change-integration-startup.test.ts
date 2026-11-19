import { afterAll, expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDeliveryCoordination } from "../../apps/factory/src/delivery/coordination";
import { createChangeIntegration } from "../../apps/factory/src/delivery/integration";
import { substrateWorkspaceGrantIn } from "../../apps/factory/src/runtime/substrate-grant";
import { createDatabase } from "../../packages/db/src/client";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";

const main = "e".repeat(40);
const dispatched = "Integration dispatched; exact outcome pending";
const refusal = () =>
  new CommandError("forbidden", "Ticket execution requires its current admitted turn");
type Operation = {
  id: string;
  changeID: string;
  attemptID: string;
  parent: string;
  base: string;
  branch: string;
  message: string;
  state: string;
  sha: string | null;
  error: string | null;
  userID: string;
  repository: string;
};

// Minimize the real reconcile call site. DB tests below check the actual UPDATE guards.
function controllerFixture(cause: unknown, retained: Partial<Operation> = {}, matched = true) {
  const op: Operation = {
    id: crypto.randomUUID(),
    changeID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    parent: "d".repeat(40),
    base: main,
    branch: "factory/owned-integration",
    message: "Integrate current main",
    state: "commit-intended",
    sha: null,
    error: null,
    userID: crypto.randomUUID(),
    repository: "https://forge.invalid/owned/integration.git",
    ...retained,
  };
  const writes: { text: string; values: unknown[] }[] = [];
  let starts = 0;
  let frames = 0;
  const client = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      if (text.includes("SELECT operation.id")) return [{ ...op }];
      if (text.includes("SELECT change.project_id"))
        return [{ projectID: "owned-project", available: true }];
      if (text.includes("SELECT state,epoch::text")) return [{ state: "agent", epoch: "4" }];
      if (/UPDATE\s+factory\./.test(text)) {
        writes.push({ text, values });
        return text.includes("UPDATE factory.change_commit_operation") && matched
          ? [{ id: op.id }]
          : [];
      }
      throw new Error(`Unexpected integration startup query: ${text}`);
    },
    {
      async begin<T>(run: (sql: typeof client) => Promise<T>): Promise<T> {
        return run(client);
      },
    },
  );
  const controller = createChangeIntegration(
    { client } as unknown as Parameters<typeof createChangeIntegration>[0],
    {
      parentOperation: async () => {
        frames++;
        throw new Error("Startup refusal must not dispatch Git");
      },
    } as unknown as Parameters<typeof createChangeIntegration>[1],
    {
      prompt: async () => {
        throw new Error("Startup refusal must not start Coding");
      },
    },
    {
      startPersisted: async () => {
        starts++;
        throw cause;
      },
    },
  );
  return { op, controller, writes, starts: () => starts, frames: () => frames };
}

test.each([
  new CommandError("unavailable", "Capacity is temporarily unavailable"),
  new CommandError("conflict", "Source preparation is still pending"),
  new CommandError("not-found", "Runtime observation unavailable"),
  new Error("Connection reset"),
  new Error("Ticket execution requires its current admitted turn"),
])("controller: transient/untyped startup failure stays undispatched: %s", async (cause) => {
  const f = controllerFixture(cause);
  expect(await f.controller.reconcile(f.op.changeID, main)).toBe(false);
  expect(f.starts()).toBe(1);
  expect(f.frames()).toBe(0);
  expect(f.writes).toEqual([]);
});

test("controller: forbidden startup retires an undispatched intent with an actionable failure", async () => {
  const f = controllerFixture(refusal());
  expect(await f.controller.reconcile(f.op.changeID, main)).toBe(false);
  expect(f.starts()).toBe(1);
  expect(f.frames()).toBe(0);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]?.text).toContain("UPDATE factory.change_commit_operation");
  expect(f.writes[0]?.text).toContain("'failed'");
  expect(f.writes[0]?.values).toContain(f.op.id);
  expect(f.writes[1]?.text).toContain("UPDATE factory.change");
  expect(f.writes[1]?.values).toContain(f.op.changeID);
  expect(f.writes[1]?.values.some((value) => String(value).includes("Take over editing"))).toBe(
    true,
  );
});

test.each([
  { error: dispatched },
  { error: "Connection lost after Git dispatch" },
  { state: "push-intended", sha: "f".repeat(40), error: dispatched },
  { state: "push-intended", sha: "f".repeat(40) },
  { sha: "f".repeat(40) },
])("controller: startup refusal preserves previously dispatched/unknown work: %j", async (op) => {
  const f = controllerFixture(refusal(), op);
  expect(await f.controller.reconcile(f.op.changeID, main)).toBe(false);
  expect(f.frames()).toBe(0);
  expect(f.writes).toEqual([]);
});

test("controller: a concurrently changed intent cannot publish a Change failure", async () => {
  const f = controllerFixture(refusal(), {}, false);
  expect(await f.controller.reconcile(f.op.changeID, main)).toBe(false);
  expect(f.frames()).toBe(0);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.text).toContain("UPDATE factory.change_commit_operation");
});

// Reuse a lane-owned server when supplied; standalone runs own exactly one server.
// No application process, native runtime or model is started.
let server: ReturnType<typeof ownedPostgresServer> | undefined;
afterAll(async () => {
  const owned = await server?.catch(() => undefined);
  await owned?.dispose();
}, 60_000);

async function databaseFixture() {
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  let identity: PostgresIdentity;
  if (supplied) identity = JSON.parse(supplied) as PostgresIdentity;
  else {
    server ??= ownedPostgresServer();
    identity = (await server).identity;
  }
  const target = await ownedTestDatabase(identity, crypto.randomUUID());
  const previous = process.env["DATABASE_URL"];
  let database: ReturnType<typeof createDatabase>;
  try {
    process.env["DATABASE_URL"] = target.url;
    database = createDatabase(3);
  } finally {
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
  }
  let f: Awaited<ReturnType<typeof candidateReviewFixture>> | undefined;
  try {
    f = await candidateReviewFixture(undefined, database);
    const review = await f.activeReview();
    const changeID = f.changeID;
    const reviewID = f.reviewID;
    await f.turns.settle(
      review.id,
      review.ownerToken,
      "completed",
      "Owned completed review",
      async (sql) => {
        await sql`UPDATE factory.candidate_review SET state='passed',result=${JSON.stringify({
          verdict: "passed",
          delivery: "ordinary",
          summary: "Owned exact-candidate review",
          criteria: [{ criterion: 1, status: "passed", evidence: "Controlled controller fixture" }],
          findings: [],
          ui: "not-applicable",
        })}::jsonb,completed_at=now() WHERE id=${reviewID}`;
        await sql`UPDATE factory.change_agent_session SET state='committed'
          WHERE change_id=${changeID}`;
      },
    );
    // Controlled stopped/deleted native facts only, never live resource ownership.
    await database.client`UPDATE factory.runtime_attempt SET state='stopped',
      stop_intended_at=now(),stopped_at=now() WHERE id=${f.attemptID}`;
    await database.client`UPDATE factory.substrate_binding SET actor_uid=${crypto.randomUUID()},
      create_attempted_at=now(),delete_intended_at=now(),deleted_at=now()
      WHERE runtime_attempt_id=${f.attemptID}`;
    expect(await createDeliveryCoordination(database).claim(f.projectID, f.changeID)).toBe(true);
    let frames = 0;
    f.hub.parentOperation = async () => {
      frames++;
      throw new Error("No Git dispatch is permitted in a stopped startup test");
    };
    const owned = f;
    async function dispose() {
      try {
        await owned.shutdown();
      } finally {
        owned.restoreEnvironment();
        await database.client.end();
        await target.dispose();
      }
    }
    return {
      ...f,
      frames: () => frames,
      integration(startPersisted: () => Promise<unknown>) {
        return createChangeIntegration(
          database,
          owned.hub,
          {
            prompt: async () => {
              throw new Error("Integration startup cannot start inference");
            },
          },
          { startPersisted },
        );
      },
      dispose,
    };
  } catch (cause) {
    try {
      await f?.shutdown();
    } finally {
      f?.restoreEnvironment();
      await database.client.end();
      await target.dispose();
    }
    throw cause;
  }
}
type DatabaseFixture = Awaited<ReturnType<typeof databaseFixture>>;
async function observation(f: DatabaseFixture) {
  return (
    await f.database.client<
      {
        id: string;
        state: string;
        error: string | null;
        sha: string | null;
        completed: boolean;
        failure: string | null;
      }[]
    >`SELECT operation.id,operation.state,operation.last_error AS error,
      operation.commit_sha AS sha,operation.completed_at IS NOT NULL AS completed,change.failure
      FROM factory.change_commit_operation operation JOIN factory.change change ON change.id=operation.change_id
      WHERE change.id=${f.changeID} AND operation.source='integration' ORDER BY sequence DESC LIMIT 1`
  )[0];
}

test.each(["takeover", "coding"] as const)(
  "database: stopped integration fails visibly and permits ordinary %s without recreating compute",
  async (recovery) => {
    const f = await databaseFixture();
    try {
      const admission = createChangeAdmission(f.database, buildModelID);
      const next = {
        kind: "change-prompt" as const,
        commandId: crypto.randomUUID(),
        text: "Continue the retained work",
      };
      const before = await f.database.client`SELECT attempt.*,binding.*
        FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding
          ON binding.runtime_attempt_id=attempt.id WHERE attempt.id=${f.attemptID}`;
      const integration = f.integration(async () => {
        await expect(admission.admit(f.changeID, f.userID, next)).rejects.toThrow(
          "Wait for the current commit operation",
        );
        return f.database.client.begin((sql) =>
          substrateWorkspaceGrantIn(f.database, sql, f.workspaceID, f.userID, true),
        );
      });
      expect(await integration.reconcile(f.changeID, main)).toBe(false);
      const failed = await observation(f);
      expect(failed).toMatchObject({ state: "failed", sha: null, completed: true });
      expect(failed?.error).toContain("Take over editing");
      expect(failed?.failure).toBe(failed?.error);
      expect(f.frames()).toBe(0);
      expect(
        await f.database.client`SELECT attempt.*,binding.*
        FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding
          ON binding.runtime_attempt_id=attempt.id WHERE attempt.id=${f.attemptID}`,
      ).toEqual(before);
      // Reconciliation does not replay the failed operation or start more compute.
      expect(await integration.reconcile(f.changeID, main)).toBe(false);
      expect(await observation(f)).toEqual(failed);
      if (recovery === "takeover") {
        const view = await f.writers.view(f.changeID, f.userID);
        const taken = await f.writers.takeOver(
          f.changeID,
          f.userID,
          crypto.randomUUID(),
          undefined,
          undefined,
          view.epoch,
        );
        expect(taken).toMatchObject({ state: "human", canWrite: true, yours: true });
      } else {
        const admitted = await admission.admit(f.changeID, f.userID, next);
        expect(admitted.turn.state).toBe("pending");
      }
      expect(f.frames()).toBe(0);
      const attempts = await f.database.client<
        { id: string }[]
      >`SELECT id FROM factory.runtime_attempt
        WHERE workspace_id=${f.workspaceID}`;
      expect(attempts.map(({ id }) => id)).toEqual([f.attemptID]);
    } finally {
      await f.dispose();
    }
  },
  90_000,
);

test.each(["unavailable", "transport"] as const)(
  "database: %s preparation preserves the original undispatched operation",
  async (kind) => {
    const f = await databaseFixture();
    try {
      const integration = f.integration(async () => {
        throw kind === "unavailable"
          ? new CommandError("unavailable", "Owned temporary capacity failure")
          : new Error("Owned connection reset");
      });
      expect(await integration.reconcile(f.changeID, main)).toBe(false);
      const pending = await observation(f);
      expect(pending).toMatchObject({
        state: "commit-intended",
        error: null,
        sha: null,
        completed: false,
        failure: null,
      });
      expect(await integration.reconcile(f.changeID, main)).toBe(false);
      expect(await observation(f)).toEqual(pending);
      expect(f.frames()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  90_000,
);

test.each(["commit-intended", "push-intended"] as const)(
  "database: concurrent %s dispatch evidence survives a forbidden startup response",
  async (state) => {
    const f = await databaseFixture();
    try {
      let unknown: Awaited<ReturnType<typeof observation>>;
      const integration = f.integration(async () => {
        await f.database.client`UPDATE factory.change_commit_operation
          SET state=${state},last_error=${dispatched},
            commit_sha=${state === "push-intended" ? "f".repeat(40) : null}
          WHERE change_id=${f.changeID} AND source='integration'`;
        await f.database
          .client`UPDATE factory.change SET failure='Owned original unknown-write evidence'
          WHERE id=${f.changeID}`;
        unknown = await observation(f);
        throw refusal();
      });
      expect(await integration.reconcile(f.changeID, main)).toBe(false);
      expect(await observation(f)).toEqual(unknown);
      expect(f.frames()).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  90_000,
);
