import { expect, spyOn, test } from "bun:test";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { ticketDocumentInput } from "../../../../packages/requirement-domain/src/document";
import { ticketRequirementsInput } from "../../../../test/fixtures/ticket-requirements";
import { conversationDatabase } from "../../../../test/support/conversation-persistence";
import { createAccessController } from "../access/controller";
import { type TicketDetail } from "./contracts";
import { createChangeController } from "./controller";
import { createTicketService } from "./service";
import type { ChangeView } from "./types";

test("Change start requires explicit Implement admission before any database or Forge operation", async () => {
  const keys = {
    FACTORY_FORGEJO_API_URL: "https://owned-change.invalid/api/v1/",
    FACTORY_FORGEJO_TOKEN: "owned-unused-token",
    FACTORY_FORGEJO_OWNER: "owned",
  };
  const previous = new Map(Object.keys(keys).map((key) => [key, process.env[key]]));
  let transactions = 0;
  const database = {
    client: {
      async begin() {
        transactions++;
        throw new Error("Unguarded start reached the database");
      },
    },
  } as unknown as ReturnType<typeof createDatabase>;
  Object.assign(process.env, keys);
  try {
    const controller = createChangeController(
      database,
      { stop: async () => null },
      undefined,
      undefined,
      {} as ReturnType<typeof createForgejoClient>,
    );
    await expect(
      Reflect.apply(controller.start, controller, [crypto.randomUUID(), crypto.randomUUID()]),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Use Implement with an exact saved Requirement Revision and command identity.",
    });
    expect(transactions).toBe(0);
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test.each(["stale revision", "partial document", "pending technical planning"] as const)(
  "Implement rejects %s before saving approval or creating a branch",
  async (scenario) => {
    const keys = {
      FACTORY_FORGEJO_API_URL: "https://owned-change.invalid/api/v1/",
      FACTORY_FORGEJO_TOKEN: "owned-unused-token",
      FACTORY_FORGEJO_OWNER: "owned",
    };
    const previous = new Map(Object.keys(keys).map((key) => [key, process.env[key]]));
    const userID = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const revisionID = crypto.randomUUID();
    const fixture = conversationDatabase(
      ({ text }) => {
        if (text.includes("pg_advisory_xact_lock")) return [];
        throw new Error(`Unexpected admission SQL: ${text}`);
      },
      ({ text }) => {
        if (text.startsWith('select "project_id"')) return [[projectID, "ready", false]];
        if (text.includes('from "auth"."user"')) return [[userID]];
        if (text.includes('from "factory"."account_access"')) return [[null, null]];
        if (text.includes('from "factory"."project_membership"')) return [["developer", false]];
        if (text.includes('from "factory"."administrator"')) return [];
        if (text.includes('from "factory"."project"')) return [[projectID]];
        if (text.includes('from "factory"."requirement_revision"'))
          return [[scenario === "stale revision" ? crypto.randomUUID() : revisionID]];
        if (text.includes('from "factory"."ticket_document_revision"'))
          return [[scenario === "partial document" ? null : revisionID]];
        if (text.includes('from (select "id" from "factory"."agent_turn"'))
          return [[crypto.randomUUID()]];
        if (text.includes('from "factory"."agent_turn"')) return [];
        throw new Error(`Unexpected admission query: ${text}`);
      },
    );
    Object.assign(process.env, keys);
    try {
      const controller = createChangeController(
        fixture.database,
        { stop: async () => null },
        undefined,
        undefined,
        {} as ReturnType<typeof createForgejoClient>,
      );
      await expect(
        controller.start(crypto.randomUUID(), userID, {
          commandID: crypto.randomUUID(),
          revisionID,
          admitBuild: async () => {
            throw new Error("Rejected requirements cannot admit Coding");
          },
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message:
          scenario === "stale revision"
            ? "The Ticket changed. Review the current requirements before implementing."
            : scenario === "partial document"
              ? "Finish the current specification before implementing."
              : "Finish Technical Planning before implementing this Ticket.",
      });
      expect(fixture.statements.some(({ text }) => /^(insert|update)/.test(text))).toBe(false);
    } finally {
      for (const [key, value] of previous)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  },
);

test("saved-document retry keeps its observed Ticket version, document and approved scope", () => {
  const ticketID = crypto.randomUUID();
  const commandID = crypto.randomUUID();
  const documentID = crypto.randomUUID();
  const approvedID = crypto.randomUUID();
  const detail = {
    ticket: { id: ticketID, title: "Observed title", description: "Observed request", version: 7 },
    documentRevisions: [{ id: documentID }],
    revisions: [{ id: crypto.randomUUID() }, { id: approvedID, approvalId: crypto.randomUUID() }],
  } as unknown as TicketDetail;
  const requirement = { summary: "Exact scope", acceptanceCriteria: ["Keep source"], nonGoals: [] };
  const input = ticketRequirementsInput(detail, requirement, commandID);
  const encoded = JSON.stringify(input);
  detail.ticket.version++;
  detail.ticket.title = "Later title";
  const observedDocument = detail.documentRevisions[0];
  if (!observedDocument) throw new Error("Observed document is missing");
  observedDocument.id = crypto.randomUUID();
  requirement.summary = "Later scope";
  requirement.acceptanceCriteria.push("Unapproved addition");
  expect(ticketDocumentInput.parse(input)).toMatchObject({
    commandId: commandID,
    expectedVersion: 7,
    expectedDocumentId: documentID,
    requirementRevisionId: approvedID,
    title: "Observed title",
    description: "Observed request",
    requirement: { summary: "Exact scope", acceptanceCriteria: ["Keep source"], nonGoals: [] },
  });
  expect(JSON.stringify(input)).toBe(encoded);
  expect(Object.isFrozen(input)).toBe(true);
  expect(Object.isFrozen(input.requirement)).toBe(true);
});

test("exact Implement replay keeps the admitted Change source and invokes its original command authority", async () => {
  const configuration = {
    FACTORY_FORGEJO_API_URL: "https://owned-replay.invalid/api/v1/",
    FACTORY_FORGEJO_TOKEN: "owned-unused-token",
    FACTORY_FORGEJO_OWNER: "owned",
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const commandID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const fixture = conversationDatabase(
    ({ text }) => {
      if (text.includes("pg_advisory_xact_lock")) return [];
      throw new Error(`Unexpected replay SQL: ${text}`);
    },
    ({ text }) => {
      if (text.startsWith("update")) return [];
      if (text.startsWith('select "project_id"')) return [[projectID, "ready", false]];
      if (text.includes('from "auth"."user"')) return [[userID]];
      if (text.includes('from "factory"."account_access"')) return [[null, null]];
      if (text.includes('from "factory"."project_membership"')) return [["developer", false]];
      if (text.includes('from "factory"."administrator"')) return [];
      if (text.includes('from "factory"."project"')) return [[projectID]];
      if (text.includes('from "factory"."requirement_revision"')) return [[revisionID]];
      if (text.includes('from "factory"."ticket_document_revision"')) return [[revisionID]];
      if (text.includes('from (select "id" from "factory"."agent_turn"')) return [];
      if (text.includes('from "factory"."technical_design_revision"')) return [];
      if (text.includes('from "factory"."requirement_approval"')) return [[revisionID, null]];
      if (text.includes('from "factory"."change"')) return [[changeID]];
      if (text.includes('inner join "factory"."change_agent_turn_intent"'))
        return [[commandID, "high"]];
      if (text.includes('from "factory"."agent_turn"'))
        return text.includes("->>'requirementRevisionId'")
          ? [[ticketID, userID, revisionID, "change-start"]]
          : [];
      throw new Error(`Unexpected replay query: ${text}`);
    },
  );
  const database = { ...fixture.database, db: drizzleTransaction(fixture.database.client) };
  const unavailable = async () => {
    throw new Error("Replay cannot replace source or create work");
  };
  Object.assign(process.env, configuration);
  const admitted: unknown[][] = [];
  try {
    const controller = createChangeController(
      database,
      { stop: unavailable },
      undefined,
      undefined,
      {
        getDefaultBranch: unavailable,
        getBranch: unavailable,
        ensureBranch: unavailable,
      } as unknown as ReturnType<typeof createForgejoClient>,
    );
    const retained = { id: changeID, baseSha: "a".repeat(40), state: "active" } as ChangeView;
    const get = spyOn(controller, "get").mockResolvedValue(retained);
    try {
      const tickets = createTicketService({
        database,
        access: createAccessController(database),
        documents: { save: unavailable, followUp: unavailable },
        trash: { trash: unavailable, restore: unavailable },
        changes: controller,
        agent: {
          admitStartIn: async (sql, ...args) => {
            expect(fixture.statements.at(-1)?.transaction).not.toBeNull();
            expect(sql).not.toBe(database.client);
            admitted.push(args);
            return {} as Awaited<
              ReturnType<Parameters<typeof createTicketService>[0]["agent"]["admitStartIn"]>
            >;
          },
        },
      });
      const command = Object.freeze({
        commandId: commandID,
        revisionId: revisionID,
        codingReasoning: "high" as const,
      });
      for (let replay = 0; replay < 2; replay++)
        expect(await tickets.implement(userID, ticketID, command)).toEqual({ id: changeID });
      expect(admitted).toEqual([
        [changeID, userID, commandID, "high"],
        [changeID, userID, commandID, "high"],
      ]);
      expect((await controller.get(changeID))?.baseSha).toBe("a".repeat(40));
      await expect(
        tickets.implement(userID, ticketID, { ...command, revisionId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(admitted).toHaveLength(2);
      expect(fixture.statements.some(({ text }) => text.startsWith("insert"))).toBe(false);
    } finally {
      get.mockRestore();
    }
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
