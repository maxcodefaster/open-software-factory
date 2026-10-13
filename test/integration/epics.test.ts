import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { zeroQueries, zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { factoryProcess } from "../fixtures/factory-process";

const administrator = "01994a7d-0000-7000-8000-000000000001";

async function fixture() {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await process.start();
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userId}, 'Owned Epic Developer', ${`epic-${userId}@factory.local`}, true)`;
    for (const id of [projectId, otherProjectId]) {
      await database.client`INSERT INTO factory.project(id, slug, name, repository_url, default_branch, devcontainer_path, created_by)
        VALUES (${id}, ${`epic-${id}`}, 'Owned Epic Project', 'https://example.invalid/epics.git', 'main', '.devcontainer/devcontainer.json', ${administrator})`;
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
      async create(title: string, parentId: string | null = null) {
        const id = crypto.randomUUID();
        await zero.transaction((tx) =>
          zeroServerMutators.epics.create.fn({
            tx,
            ctx,
            args: { id, projectId, title, description: "", parentId },
          }),
        );
        return id;
      },
      async move(epicId: string, parentId: string | null, expectedVersion = 1) {
        return zero.transaction((tx) =>
          zeroServerMutators.epics.update.fn({
            tx,
            ctx,
            args: { projectId, epicId, expectedVersion, parentId },
          }),
        );
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

test("Epic planning enforces Project scope, immutable approvals, membership and version conflicts", async () => {
  const owned = await fixture();
  const { zero, ctx, database, projectId, otherProjectId } = owned;
  try {
    const root = await owned.create("Release");
    const child = await owned.create("Onboarding", root);
    const otherRoot = await owned.create("Other group");
    const ticketId = crypto.randomUUID();
    await zero.transaction((tx) =>
      zeroServerMutators.tickets.create.fn({
        tx,
        ctx,
        args: { id: ticketId, projectId, title: "Deliver onboarding", description: "" },
      }),
    );
    const content = JSON.stringify({ summary: "Keep the approved onboarding intent" });
    const revisionId = crypto.randomUUID();
    const approvalId = crypto.randomUUID();
    await database.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${revisionId}, ${ticketId}, 1, ${content}, ${createHash("sha256").update(content).digest("hex")}, ${ctx.userId})`;
    await database.client`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, approved_by)
      VALUES (${approvalId}, ${ticketId}, ${revisionId}, ${ctx.userId})`;
    await zero.transaction((tx) =>
      zeroServerMutators.tickets.assignEpic.fn({
        tx,
        ctx,
        args: { projectId, ticketId, epicId: child, expectedVersion: 1 },
      }),
    );
    await owned.move(child, otherRoot);
    const [membership] = await database.client<
      Array<{ epicId: string; state: string; version: number }>
    >`
      SELECT epic_id AS "epicId", state, version::float8 AS version FROM factory.ticket WHERE id = ${ticketId}`;
    expect(membership).toEqual({ epicId: child, state: "inbox", version: 2 });
    const [revision] = await database.client<Array<{ content: string; approvalId: string }>>`
      SELECT canonical_content AS content, approval.id AS "approvalId"
      FROM factory.requirement_revision revision JOIN factory.requirement_approval approval ON approval.requirement_revision_id = revision.id
      WHERE revision.id = ${revisionId}`;
    expect(revision).toEqual({ content, approvalId });
    const query = zeroQueries.epics.list.fn({ args: { projectId }, ctx });
    expect((await zero.run(query)).map((epic) => epic.id).sort()).toEqual(
      [root, child, otherRoot].sort(),
    );
    await expect(owned.move(child, null)).rejects.toThrow("Epic version conflict");
    await owned.move(child, null, 2);
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.tickets.assignEpic.fn({
          tx,
          ctx,
          args: { projectId, ticketId, epicId: null, expectedVersion: 1 },
        }),
      ),
    ).rejects.toThrow("Ticket version conflict");
    await zero.transaction((tx) =>
      zeroServerMutators.tickets.assignEpic.fn({
        tx,
        ctx,
        args: { projectId, ticketId, epicId: null, expectedVersion: 2 },
      }),
    );
    const [unassigned] = await database.client<Array<{ epic_id: string | null; state: string }>>`
      SELECT epic_id, state FROM factory.ticket WHERE id = ${ticketId}`;
    expect(unassigned?.epic_id).toBeNull();
    expect(unassigned?.state).toBe("inbox");

    const foreign = crypto.randomUUID();
    await database.client`INSERT INTO factory.epic(id, project_id, title, created_by)
      VALUES (${foreign}, ${otherProjectId}, 'Private Epic', ${administrator})`;
    expect(
      await zero.run(zeroQueries.epics.list.fn({ args: { projectId: otherProjectId }, ctx })),
    ).toEqual([]);
    await expect(owned.create("Cross-Project", foreign)).rejects.toThrow("Parent Epic not found");
    await expect(owned.move(root, foreign)).rejects.toThrow("Parent Epic not found");
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.tickets.assignEpic.fn({
          tx,
          ctx,
          args: { projectId, ticketId, epicId: foreign, expectedVersion: 3 },
        }),
      ),
    ).rejects.toThrow("Epic not found");
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.epics.create.fn({
          tx,
          ctx,
          args: {
            id: crypto.randomUUID(),
            projectId: otherProjectId,
            title: "Denied",
            description: "",
            parentId: null,
          },
        }),
      ),
    ).rejects.toThrow("Project not found");
    await database.client`DELETE FROM factory.project_membership WHERE project_id = ${projectId} AND user_id = ${ctx.userId}`;
    expect(await zero.run(query)).toEqual([]);
    await expect(owned.create("Revoked")).rejects.toThrow("Project not found");
    await expect(owned.move(root, null)).rejects.toThrow("Project not found");
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.tickets.assignEpic.fn({
          tx,
          ctx,
          args: { projectId, ticketId, epicId: root, expectedVersion: 3 },
        }),
      ),
    ).rejects.toThrow("Project not found");
  } finally {
    await owned.dispose();
  }
}, 30_000);

test("concurrent Epic moves and direct database writes cannot create hierarchy cycles", async () => {
  const owned = await fixture();
  try {
    const root = await owned.create("Root");
    const child = await owned.create("Child", root);
    const leaf = await owned.create("Leaf", child);
    await expect(owned.move(root, leaf)).rejects.toThrow();
    await expect(owned.move(root, root)).rejects.toThrow();
    const [unchanged] = await owned.database.client<Array<{ parent_id: string | null }>>`
      SELECT parent_id FROM factory.epic WHERE id = ${root}`;
    expect(unchanged?.parent_id).toBeNull();

    const first = await owned.create("First");
    const second = await owned.create("Second");
    const simultaneous = await Promise.allSettled([
      owned.move(first, second),
      owned.move(second, first),
    ]);
    expect(simultaneous.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rows = await owned.database.client<Array<{ id: string; parent: string | null }>>`
      SELECT id, parent_id AS parent FROM factory.epic WHERE id IN (${first}, ${second})`;
    expect(rows.filter((row) => row.parent !== null)).toHaveLength(1);

    const directA = await owned.create("Direct A");
    const directB = await owned.create("Direct B");
    const direct = await Promise.allSettled([
      owned.database.client`UPDATE factory.epic SET parent_id = ${directB} WHERE id = ${directA}`,
      owned.database.client`UPDATE factory.epic SET parent_id = ${directA} WHERE id = ${directB}`,
    ]);
    expect(direct.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(
      owned.database
        .client`UPDATE factory.epic SET project_id = ${owned.otherProjectId} WHERE id = ${directA}`.execute(),
    ).rejects.toThrow("immutable");
    const other = crypto.randomUUID();
    await owned.database.client`INSERT INTO factory.epic(id, project_id, title, created_by)
      VALUES (${other}, ${owned.otherProjectId}, 'Other', ${administrator})`;
    await expect(
      owned.database
        .client`UPDATE factory.epic SET parent_id = ${other} WHERE id = ${root}`.execute(),
    ).rejects.toThrow();
    const insertA = crypto.randomUUID();
    const insertB = crypto.randomUUID();
    await expect(
      owned.database.client`INSERT INTO factory.epic(id, project_id, parent_id, title, created_by)
      VALUES (${insertA}, ${owned.projectId}, ${insertB}, 'Insert A', ${administrator}),
        (${insertB}, ${owned.projectId}, ${insertA}, 'Insert B', ${administrator})`.execute(),
    ).rejects.toThrow("cycle");
  } finally {
    await owned.dispose();
  }
}, 30_000);
