import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test.each([false, true])(
  "a contributor commissions manual Requirements from Ideas=%s without planning AI",
  async (idea) => {
    const host = await factoryProcess();
    const database = host.connect();
    const keys = [
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_FORGEJO_TOKEN",
      "FACTORY_FORGEJO_OWNER",
    ] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    const branches = new Set(["main"]);
    const head = "a".repeat(40);
    let creates = 0;
    const ready: string[] = [];
    const forge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/repos/owned/manual")
          return Response.json({
            owner: { login: "owned" },
            name: "manual",
            default_branch: "main",
          });
        if (path.endsWith("/branches") && request.method === "POST") {
          const body = (await request.json()) as { new_branch_name: string };
          creates++;
          branches.add(body.new_branch_name);
          return Response.json({ name: body.new_branch_name, commit: { id: head } });
        }
        const branch = decodeURIComponent(path.split("/branches/")[1] ?? "");
        return branches.has(branch)
          ? Response.json({ name: branch, commit: { id: head } })
          : new Response(null, { status: 404 });
      },
    });
    try {
      const owned = await fixture(undefined, undefined, database);
      await database.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
      await database.client`UPDATE factory.project SET repository_url=${`http://127.0.0.1:${forge.port}/owned/manual.git`} WHERE id=${owned.projectID}`;
      const planning = createProjectAgentController(database, { start: async () => null });
      const zero = zeroDrizzle(zeroSchema, database.db);
      const ticketID = crypto.randomUUID();
      const args = {
        id: ticketID,
        projectId: owned.projectID,
        title: "A fully specified manual change",
        description: "The requirements are already settled.",
        state: idea ? ("inbox" as const) : ("ready" as const),
      };
      const ctx = { userId: owned.userID, systemManager: false };
      await zero.transaction((tx) => zeroServerMutators.tickets.create.fn({ tx, ctx, args }));
      if (idea)
        await zero.transaction((tx) =>
          zeroServerMutators.tickets.move.fn({
            tx,
            ctx,
            args: {
              projectId: owned.projectID,
              ticketId: ticketID,
              state: "ready",
              expectedVersion: 1,
            },
          }),
        );
      await planning.recover();
      expect(await planning.get(owned.projectID, ticketID, owned.userID)).toBeNull();
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT ticket_id FROM factory.requirements_entry_intent WHERE ticket_id=${ticketID}`,
      ).toHaveLength(0);

      const documentID = crypto.randomUUID();
      const requirement = {
        summary: "A manual change with observable behavior.",
        acceptanceCriteria: [
          "The intended result is visible.",
          "An invalid value has a clear error.",
        ],
        nonGoals: ["No unrelated changes."],
      };
      const documents = createTicketDocumentController(database);
      const input = {
        commandId: documentID,
        expectedVersion: idea ? 2 : 1,
        expectedDocumentId: null,
        requirementRevisionId: null,
        title: args.title,
        description: args.description,
        requirement,
      };
      await documents.save(ticketID, owned.userID, input);
      await documents.save(ticketID, owned.userID, input);
      await planning.recover();
      expect(
        await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
      ).toHaveLength(0);
      expect(
        await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
      ).toHaveLength(0);

      Object.assign(process.env, {
        FACTORY_FORGEJO_API_URL: `http://127.0.0.1:${forge.port}/api/v1/`,
        FACTORY_FORGEJO_TOKEN: "owned-unused-token",
        FACTORY_FORGEJO_OWNER: "owned",
      });
      const coding = createChangeAdmission(database, "owned-coding-model");
      const changes = createChangeController(
        database,
        {
          startPersisted: async () => {
            throw new Error("This admission proof must not start compute");
          },
          stop: async () => null,
        },
        async (id) => {
          ready.push(id);
        },
        async () => {},
      );
      const commandID = crypto.randomUUID();
      const commission = {
        commandID,
        revisionID: documentID,
        admitBuild: (sql: Parameters<typeof coding.admitIn>[0], changeID: string) =>
          coding.admitIn(sql, changeID, owned.userID, {
            kind: "change-start",
            commandId: commandID,
          }),
      };
      const change = await changes.start(ticketID, owned.userID, commission);
      if (!change) throw new Error("Manual implementation was not admitted");
      await changes.start(ticketID, owned.userID, commission);
      await eventually(
        () => changes.get(change.id),
        (value) => value?.state === "active" && ready.includes(change.id),
        "Owned branch did not settle",
      );
      const turns = await database.client<
        { mode: string; kind: string; revision: string; prompt: string }[]
      >`
      SELECT turn.authority->>'mode' AS mode,turn.input->>'kind' AS kind,
        turn.authority->>'requirementRevisionId' AS revision,intent.prompt_text AS prompt
      FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
      WHERE turn.ticket_id=${ticketID}`;
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ mode: "build", kind: "change-start", revision: documentID });
      expect(turns[0]?.prompt).toContain(requirement.acceptanceCriteria[1]);
      expect(creates).toBe(1);
      expect(await planning.get(owned.projectID, ticketID, owned.userID)).toBeNull();
      expect(
        await database.client`SELECT id FROM factory.requirement_approval
      WHERE ticket_id=${ticketID} AND requirement_revision_id=${documentID} AND approved_by=${owned.userID}`,
      ).toHaveLength(1);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await forge.stop(true);
      await database.client.end({ timeout: 0 });
      await host.dispose();
    }
  },
  60_000,
);

test("retiring automatic entry preserves admitted work and history without submitting an old queue item", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const migration = database.coordination();
  try {
    const owned = await fixture(undefined, undefined, database);
    const tickets = [crypto.randomUUID(), crypto.randomUUID()];
    const commands = [crypto.randomUUID(), crypto.randomUUID()];
    const conversationID = crypto.randomUUID();
    for (let i = 0; i < 2; i++) {
      await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
        VALUES(${tickets[i]!},${owned.projectID},${`Retained requirements ${i}`},'ready',${owned.userID})`;
      await database.client`INSERT INTO factory.requirements_entry_intent(ticket_id,command_id,created_by)
        VALUES(${tickets[i]!},${commands[i]!},${owned.userID})`;
    }
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
      VALUES(${conversationID},${owned.projectID},${tickets[1]!},'plan',${owned.userID})`;
    const turns = createAgentTurnStore(database);
    const admitted = await turns.admit(
      {
        kind: "project-message",
        commandId: commands[1]!,
        conversationId: conversationID,
        projectId: owned.projectID,
        ticketId: tickets[1]!,
        createdBy: owned.userID,
        text: "Retained explicit intent",
        intent: "requirements-interview",
      },
      {
        mode: "plan",
        conversationVersion: 1,
        modelId: "owned-planning-model",
        skillRevisionIds: [],
      },
    );
    const before = await turns.get(admitted.turn.id);
    await database.client`DELETE FROM factory.schema_migration WHERE version=7`;
    await migration.unsafe(
      await readFile(resolve("packages/db/migrations/0007_explicit_requirements.sql"), "utf8"),
    );
    expect(await turns.get(admitted.turn.id)).toEqual(before);
    const entries = await database.client<
      { ticketID: string; admitted: boolean; failure: string | null }[]
    >`
      SELECT ticket_id AS "ticketID",admitted_at IS NOT NULL AS admitted,failure
      FROM factory.requirements_entry_intent WHERE ticket_id=ANY(${tickets}::uuid[])`;
    expect(entries.find((row) => row.ticketID === tickets[0])).toMatchObject({
      admitted: false,
      failure: expect.stringContaining("retired"),
    });
    expect(entries.find((row) => row.ticketID === tickets[1])).toMatchObject({
      admitted: true,
      failure: null,
    });
    // A new controller cannot convert the unadmitted entry into a conversation
    // or model request. Do not recover the separately admitted historical turn.
    const planning = createProjectAgentController(database, { start: async () => null });
    expect(await planning.get(owned.projectID, tickets[0], owned.userID)).toBeNull();
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${tickets[0]!}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.ticket WHERE id=ANY(${tickets}::uuid[])`,
    ).toHaveLength(2);
  } finally {
    await migration.end({ timeout: 0 });
    await database.client.end({ timeout: 0 });
    await host.dispose();
  }
}, 60_000);
