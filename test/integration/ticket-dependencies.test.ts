import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { changeIdentity } from "../../packages/change-domain/src/change";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { eventually, factoryProcess } from "../fixtures/factory-process";

const administrator = "01994a7d-0000-7000-8000-000000000001";

function changeController(
  database: Parameters<typeof createChangeController>[0],
  apiURL = "http://127.0.0.1:9/api/v1/",
) {
  const configuration = {
    FACTORY_FORGEJO_API_URL: apiURL,
    FACTORY_FORGEJO_TOKEN: "owned-unused-dependency-token",
    FACTORY_FORGEJO_OWNER: "owned-process-fixture",
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, configuration);
    return createChangeController(database, {
      startPersisted: async () => null,
      stop: async () => null,
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fixture() {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await process.start();
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userId}, 'Owned Dependency Developer', ${`dependency-${userId}@factory.local`}, true)`;
    for (const id of [projectId, otherProjectId]) {
      await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${id}, ${`dependency-${id}`}, 'Owned Dependency Project', 'https://example.invalid/dependencies.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
    }
    await database.client`INSERT INTO factory.project_membership(project_id, user_id, role, updated_by)
      VALUES (${projectId}, ${userId}, 'developer', ${administrator})`;
    const zero = zeroDrizzle(zeroSchema, database.db);
    const ctx = { userId, systemManager: false };
    return {
      database,
      zero,
      ctx,
      projectId,
      otherProjectId,
      async ticket(title: string, project = projectId) {
        const id = crypto.randomUUID();
        await database.client`INSERT INTO factory.ticket(id, project_id, title, created_by)
          VALUES (${id}, ${project}, ${title}, ${userId})`;
        return id;
      },
      async edge(
        kind: "add" | "remove",
        ticketId: string,
        prerequisiteId: string,
        expectedVersion = 1,
      ) {
        return zero.transaction((tx) =>
          zeroServerMutators.dependencies[kind].fn({
            tx,
            ctx,
            args: { projectId, ticketId, prerequisiteId, expectedVersion },
          }),
        );
      },
      async edges() {
        return zero.run(zeroQueries.dependencies.list.fn({ args: { projectId }, ctx }));
      },
      async approved(ticketId: string) {
        const revisionId = crypto.randomUUID();
        const approvalId = crypto.randomUUID();
        const content = JSON.stringify({
          summary: "Exact dependent intent",
          acceptanceCriteria: ["Deliver it"],
          nonGoals: [],
        });
        await database.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
          VALUES (${revisionId}, ${ticketId}, 1, ${content}, ${createHash("sha256").update(content).digest("hex")}, ${userId})`;
        await database.client`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by)
          VALUES (${approvalId}, ${ticketId}, ${revisionId}, ${userId})`;
        return { ticketId, approvalId, ...changeIdentity(ticketId, approvalId) };
      },
      async change(approved: {
        ticketId: string;
        approvalId: string;
        changeID: string;
        branchName: string;
      }) {
        await database.client`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
          VALUES (${approved.changeID}, ${projectId}, ${approved.ticketId}, ${approved.approvalId}, ${approved.branchName}, ${"a".repeat(40)}, 'active', ${userId})`;
        return approved.changeID;
      },
      async green(changeId: string) {
        const id = crypto.randomUUID();
        await database.client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number, action_run_id, runner_name, state, completed_at, created_by)
          VALUES (${id}, ${changeId}, ${"d".repeat(40)}, 1, 1, 'owned-dependency', 'succeeded', now(), ${userId})`;
        return id;
      },
      async delivered(ticketId: string, changeId: string, verificationId: string) {
        const approvalId = crypto.randomUUID();
        await database.client.begin(async (sql) => {
          await sql`INSERT INTO factory.delivery_approval(id, change_id, verification_id, commit_sha, approved_by)
            VALUES (${approvalId}, ${changeId}, ${verificationId}, ${"d".repeat(40)}, ${userId})`;
          await sql`INSERT INTO factory.merge_operation(id, change_id, delivery_approval_id, pull_request_number, base_sha, commit_sha, idempotency_key, state, observed_default_sha, completed_at)
            VALUES (${crypto.randomUUID()}, ${changeId}, ${approvalId}, 1, ${"a".repeat(40)}, ${"d".repeat(40)}, ${`owned-dependency-merge:${changeId}`}, 'succeeded', ${"d".repeat(40)}, now())`;
          await sql`INSERT INTO factory.promotion_operation(id, change_id, project_id, commit_sha, state, completed_at)
            VALUES (${crypto.randomUUID()}, ${changeId}, ${projectId}, ${"d".repeat(40)}, 'succeeded', now())`;
          await sql`UPDATE factory.change SET state = 'delivered' WHERE id = ${changeId}`;
          await sql`UPDATE factory.ticket SET state = 'done' WHERE id = ${ticketId}`;
        });
      },
      async dispose() {
        await database.client.end();
        await process.dispose();
      },
    };
  } catch (cause) {
    await database.client.end();
    await process.dispose();
    throw cause;
  }
}

test("dependency planning enforces directed edges, Project scope, membership and Ticket versions", async () => {
  const owned = await fixture();
  const { database, ctx, projectId, otherProjectId, zero } = owned;
  try {
    const first = await owned.ticket("First delivery");
    const second = await owned.ticket("Dependent implementation");
    const third = await owned.ticket("Shared prerequisite");
    const foreign = await owned.ticket("Private prerequisite", otherProjectId);
    await owned.edge("add", second, first);
    expect((await owned.edges()).map((edge) => [edge.ticketId, edge.prerequisiteId])).toEqual([
      [second, first],
    ]);
    await expect(owned.edge("add", second, third)).rejects.toThrow("version conflict");
    await expect(owned.edge("add", second, first, 2)).rejects.toThrow("already linked");
    await expect(owned.edge("add", first, first)).rejects.toThrow();
    await expect(owned.edge("add", first, second)).rejects.toThrow("cycle");
    await expect(owned.edge("add", second, foreign, 2)).rejects.toThrow("not found");
    await owned.edge("add", second, third, 2);
    expect(await owned.edges()).toHaveLength(2);
    await expect(owned.edge("remove", second, first, 2)).rejects.toThrow("version conflict");
    await owned.edge("remove", second, first, 3);
    expect((await owned.edges()).map((edge) => edge.prerequisiteId)).toEqual([third]);
    await expect(owned.edge("remove", second, first, 4)).rejects.toThrow("not found");
    const [unchanged] = await database.client<Array<{ version: number; state: string }>>`
      SELECT version::float8 AS version, state FROM factory.ticket WHERE id = ${second}`;
    expect(unchanged).toEqual({ version: 4, state: "inbox" });

    await database.client`UPDATE factory.ticket SET state = 'cancelled' WHERE id = ${third}`;
    expect(await owned.edges()).toHaveLength(1);
    expect(
      await zero.run(
        zeroQueries.dependencies.list.fn({ args: { projectId: otherProjectId }, ctx }),
      ),
    ).toEqual([]);
    expect(
      await zero.run(
        zeroQueries.dependencies.list.fn({
          args: { projectId },
          ctx: { userId: administrator, systemManager: true },
        }),
      ),
    ).toHaveLength(1);
    await database.client`DELETE FROM factory.project_membership WHERE project_id = ${projectId} AND user_id = ${ctx.userId}`;
    expect(await owned.edges()).toEqual([]);
    await expect(owned.edge("add", first, third)).rejects.toThrow("Project not found");
    await expect(owned.edge("remove", second, third, 4)).rejects.toThrow("Project not found");
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("Change and Build commands require exact delivered prerequisites, not cancelled, Done or green work", async () => {
  const owned = await fixture();
  const { database, projectId, ctx } = owned;
  try {
    const controller = changeController(database);
    const first = await owned.ticket("First delivery");
    const second = await owned.ticket("Dependent implementation");
    const approvedFirst = await owned.approved(first);
    const approvedSecond = await owned.approved(second);
    await owned.edge("add", second, first);
    await expect(controller.start(second, ctx.userId)).rejects.toThrow("First delivery");
    await expect(controller.start(second, crypto.randomUUID())).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(owned.change(approvedSecond)).rejects.toThrow("Prerequisites must be delivered");
    await database.client`UPDATE factory.ticket SET state = 'cancelled' WHERE id = ${first}`;
    await expect(controller.start(second, ctx.userId)).rejects.toThrow(
      "Prerequisites must be delivered",
    );
    expect(await owned.edges()).toHaveLength(1);
    await database.client`UPDATE factory.ticket SET state = 'done' WHERE id = ${first}`;
    await expect(controller.start(second, ctx.userId)).rejects.toThrow(
      "Prerequisites must be delivered",
    );
    const changeId = await owned.change(approvedFirst);
    const verificationId = await owned.green(changeId);
    await expect(controller.start(second, ctx.userId)).rejects.toThrow(
      "Prerequisites must be delivered",
    );
    await expect(owned.change(approvedSecond)).rejects.toThrow("Prerequisites must be delivered");
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id = ${second}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.branch_create_operation WHERE change_id = ${approvedSecond.changeID}`,
    ).toHaveLength(0);

    await owned.delivered(first, changeId, verificationId);
    await owned.change(approvedSecond);
    const admission = createChangeAdmission(database, "factory-coding-model");
    const admitted = await admission.admit(approvedSecond.changeID, ctx.userId, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    expect(admitted.turn.command).toMatchObject({
      ticketId: second,
      changeId: approvedSecond.changeID,
    });
    const third = await owned.ticket("New prerequisite");
    await expect(owned.edge("add", second, third, 2)).rejects.toThrow("already been admitted");
    await expect(
      database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by)
      VALUES (${projectId}, ${second}, ${third}, ${ctx.userId})`.execute(),
    ).rejects.toThrow("already been admitted");
    await database.client`UPDATE factory.ticket SET state = 'cancelled' WHERE id = ${first}`;
    await expect(
      admission.admit(approvedSecond.changeID, ctx.userId, {
        kind: "change-start",
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("First delivery");
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE change_id = ${approvedSecond.changeID}`,
    ).toHaveLength(1);
    await owned.edge("remove", second, first, 2);
    expect(await owned.edges()).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("dependency admission rereads after a planning write and late edges lose to an admitted Change", async () => {
  const owned = await fixture();
  const { database, projectId, ctx } = owned;
  const held = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  let writer: Promise<unknown> | undefined;
  let starting: Promise<unknown> | undefined;
  let directStarting: Promise<unknown> | undefined;
  try {
    const controller = changeController(database);
    const first = await owned.ticket("Waiting delivery");
    const second = await owned.ticket("Race-dependent");
    const approved = await owned.approved(second);
    writer = database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by)
        VALUES (${projectId}, ${second}, ${first}, ${ctx.userId})`;
      const [row] = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      held.resolve(row?.pid ?? 0);
      await release.promise;
    });
    await held.promise;
    starting = controller.start(second, ctx.userId);
    void starting.catch(() => {});
    directStarting =
      database.client`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
      VALUES (${approved.changeID}, ${projectId}, ${second}, ${approved.approvalId}, ${approved.branchName}, ${"a".repeat(40)}, 'active', ${ctx.userId})`.execute();
    void directStarting.catch(() => {});
    await eventually(
      async () =>
        database.client`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0`,
      (rows) => rows.length >= 2,
      "Change start did not wait for dependency edit",
    );
    release.resolve();
    await writer;
    await expect(starting).rejects.toThrow("Waiting delivery");
    await expect(directStarting).rejects.toThrow("Waiting delivery");
    await expect(owned.change(approved)).rejects.toThrow("Waiting delivery");
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id = ${second}`,
    ).toHaveLength(0);

    const third = await owned.ticket("Admission wins");
    const admitted = await owned.approved(third);
    const holdAdmission = Promise.withResolvers<number>();
    const releaseAdmission = Promise.withResolvers<void>();
    const admitting = database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.change(id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha, state, created_by)
        VALUES (${admitted.changeID}, ${projectId}, ${third}, ${admitted.approvalId}, ${admitted.branchName}, ${"a".repeat(40)}, 'active', ${ctx.userId})`;
      const [row] = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      holdAdmission.resolve(row?.pid ?? 0);
      await releaseAdmission.promise;
    });
    let editing: Promise<unknown> | undefined;
    let directEditing: Promise<unknown> | undefined;
    try {
      const admissionPID = await holdAdmission.promise;
      editing = owned.edge("add", third, first);
      void editing.catch(() => {});
      directEditing =
        database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by)
          VALUES (${projectId}, ${third}, ${first}, ${ctx.userId})`.execute();
      void directEditing.catch(() => {});
      await eventually(
        async () =>
          database.client`SELECT pid FROM pg_stat_activity WHERE ${admissionPID} = ANY(pg_blocking_pids(pid))`,
        (rows) => rows.length > 0,
        "Dependency edit did not wait for Change admission",
      );
      releaseAdmission.resolve();
      await admitting;
      await expect(editing).rejects.toThrow("already been admitted");
      await expect(directEditing).rejects.toThrow("already been admitted");
      expect(
        await database.client`SELECT ticket_id FROM factory.ticket_dependency WHERE ticket_id = ${third}`,
      ).toHaveLength(0);
    } finally {
      releaseAdmission.resolve();
      await admitting.catch(() => {});
      await editing?.catch(() => {});
      await directEditing?.catch(() => {});
    }
  } finally {
    release.resolve();
    await writer?.catch(() => {});
    await starting?.catch(() => {});
    await directStarting?.catch(() => {});
    await owned.dispose();
  }
}, 30_000);

test("concurrent and direct dependency writes cannot create cycles or bypass scope", async () => {
  const owned = await fixture();
  const { database, projectId, ctx } = owned;
  try {
    const first = await owned.ticket("First");
    const second = await owned.ticket("Second");
    const results = await Promise.allSettled([
      owned.edge("add", first, second),
      owned.edge("add", second, first),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await owned.edges()).toHaveLength(1);
    const a = await owned.ticket("Direct A");
    const b = await owned.ticket("Direct B");
    const direct = await Promise.allSettled([
      database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by) VALUES (${projectId}, ${a}, ${b}, ${ctx.userId})`,
      database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by) VALUES (${projectId}, ${b}, ${a}, ${ctx.userId})`,
    ]);
    expect(direct.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const c = await owned.ticket("Multi-row C");
    const d = await owned.ticket("Multi-row D");
    const e = await owned.ticket("Multi-row E");
    await expect(
      database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by)
      VALUES (${projectId}, ${c}, ${d}, ${ctx.userId}), (${projectId}, ${d}, ${e}, ${ctx.userId}), (${projectId}, ${e}, ${c}, ${ctx.userId})`.execute(),
    ).rejects.toThrow("cycle");
    const foreign = await owned.ticket("Foreign", owned.otherProjectId);
    await expect(
      database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by)
      VALUES (${projectId}, ${c}, ${foreign}, ${ctx.userId})`.execute(),
    ).rejects.toThrow();
    await expect(
      database.client`INSERT INTO factory.ticket_dependency(project_id, ticket_id, prerequisite_id, created_by)
      VALUES (${projectId}, ${c}, ${c}, ${ctx.userId})`.execute(),
    ).rejects.toThrow();
    await expect(
      database.client`UPDATE factory.ticket_dependency SET prerequisite_id = ${c} WHERE ticket_id = ${first}`.execute(),
    ).rejects.toThrow("immutable");
    const shared = await owned.ticket("Shared");
    const cas = await Promise.allSettled([
      owned.edge("add", shared, c),
      owned.edge("add", shared, d),
    ]);
    expect(cas.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [count] = await database.client<
      Array<{ count: number }>
    >`SELECT count(*)::integer AS count FROM factory.ticket_dependency WHERE ticket_id = ${shared}`;
    expect(count?.count).toBe(1);
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("a dependent Change resolves the current delivered default after waiting for planning", async () => {
  const owned = await fixture();
  let defaultSHA = "a".repeat(40);
  let forgeReads = 0;
  const branches = new Map<string, string>();
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      forgeReads += 1;
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path === "/api/v1/repos/owned-process-fixture/dependencies")
        return Response.json({
          name: "dependencies",
          default_branch: "main",
          owner: { login: "owned-process-fixture" },
        });
      if (request.method === "POST" && path.endsWith("/branches")) {
        const input = (await request.json()) as { new_branch_name: string; old_ref_name: string };
        branches.set(input.new_branch_name, input.old_ref_name);
        return Response.json(
          { name: input.new_branch_name, commit: { id: input.old_ref_name } },
          { status: 201 },
        );
      }
      const name = path.split("/branches/")[1];
      const sha = name === "main" ? defaultSHA : name ? branches.get(name) : undefined;
      return sha
        ? Response.json({ name, commit: { id: sha } })
        : new Response(null, { status: 404 });
    },
  });
  const held = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  let writer: Promise<unknown> | undefined;
  let starting: ReturnType<ReturnType<typeof changeController>["start"]> | undefined;
  try {
    const first = await owned.ticket("Delivered first");
    const second = await owned.ticket("Build on first");
    const approvedFirst = await owned.approved(first);
    await owned.approved(second);
    await owned.edge("add", second, first);
    const changeId = await owned.change(approvedFirst);
    await owned.delivered(first, changeId, await owned.green(changeId));
    await owned.database
      .client`UPDATE factory.project SET repository_url = ${`http://127.0.0.1:${forge.port}/owned-process-fixture/dependencies.git`} WHERE id = ${owned.projectId}`;
    writer = owned.database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.ticket WHERE id = ${second} FOR UPDATE`;
      const [row] = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      held.resolve(row?.pid ?? 0);
      await release.promise;
    });
    const pid = await held.promise;
    const controller = changeController(owned.database, `http://127.0.0.1:${forge.port}/api/v1/`);
    starting = controller.start(second, owned.ctx.userId);
    void starting.catch(() => {});
    await eventually(
      async () =>
        owned.database
          .client`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
      (rows) => rows.length > 0,
      "Change did not wait for planning",
    );
    expect(forgeReads).toBe(0);
    defaultSHA = "d".repeat(40);
    release.resolve();
    await writer;
    const change = await starting;
    expect(change?.baseSha).toBe(defaultSHA);
    expect(change?.ticketId).toBe(second);
    const current = await eventually(
      async () => controller.get(change?.id ?? ""),
      (view) => view?.state === "active",
      "Controlled branch reconciliation did not complete",
    );
    expect(current?.branchHeadSha).toBe(defaultSHA);
    const [intent] = await owned.database.client<
      Array<{ startSha: string }>
    >`SELECT start_sha AS "startSha" FROM factory.branch_create_operation WHERE change_id = ${change?.id ?? ""}`;
    expect(intent?.startSha).toBe(defaultSHA);
    expect((await controller.start(second, owned.ctx.userId))?.id).toBe(change?.id);
  } finally {
    release.resolve();
    await writer?.catch(() => {});
    await starting?.catch(() => {});
    await forge.stop(true);
    await owned.dispose();
  }
}, 30_000);
