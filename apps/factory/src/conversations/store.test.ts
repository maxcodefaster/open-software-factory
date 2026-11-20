import { expect, test } from "bun:test";
import { conversationDatabase } from "../../../../test/support/conversation-persistence";
import {
  appendConversationEntry,
  type ConversationEntry,
  ensureConversationIn,
  findConversation,
  lockConversation,
  readConversation,
  readConversationEntries,
} from "./store";

const projectID = crypto.randomUUID();
const ticketID = crypto.randomUUID();
const userID = crypto.randomUUID();
const conversationID = crypto.randomUUID();

test("append retains immutable entry identities and locks the Conversation in the caller's effect transaction", async () => {
  const input = {
    kind: "agent-message" as const,
    actor: "change-agent" as const,
    mode: "build" as const,
    body: "Exact retained reply",
    payload: { turnId: crypto.randomUUID(), contextId: "must-be-overridden" },
    contextId: crypto.randomUUID(),
    citations: [],
    inReplyToEntryId: crypto.randomUUID(),
    requirementRevisionId: crypto.randomUUID(),
    createdBy: userID,
  };
  const before = JSON.stringify(input);
  const fixture = conversationDatabase(({ text, parameters, transaction }) => {
    expect(transaction).toBe(1);
    if (text.startsWith("SELECT id FROM factory.ticket_conversation")) {
      expect(parameters).toEqual([conversationID]);
      expect(text).toEndWith("FOR UPDATE");
      return [{ id: conversationID }];
    }
    expect(text).toStartWith("INSERT INTO factory.conversation_entry");
    expect(text).toContain("COALESCE(MAX(ordinal), 0) + 1");
    expect(parameters).toEqual([
      expect.any(String),
      conversationID,
      conversationID,
      input.kind,
      input.actor,
      input.mode,
      input.body,
      JSON.stringify({ ...input.payload, contextId: input.contextId }),
      "[]",
      input.inReplyToEntryId,
      input.requirementRevisionId,
      userID,
    ]);
    return [
      {
        id: parameters[0],
        ordinal: 17,
        ...input,
        payload: JSON.parse(String(parameters[7])),
        createdAt: "2026-11-20T10:00:00Z",
      },
    ];
  });
  const entry = await fixture.database.client.begin((sql) =>
    appendConversationEntry(sql, conversationID, input),
  );
  expect(entry).toMatchObject({
    ordinal: 17,
    body: input.body,
    inReplyToEntryId: input.inReplyToEntryId,
    requirementRevisionId: input.requirementRevisionId,
    payload: { turnId: input.payload.turnId, contextId: input.contextId },
  });
  expect(entry.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(input)).toBe(before);
  expect(fixture.statements.map(({ text }) => text.split(" ")[0])).toEqual(["SELECT", "INSERT"]);
});

test("history maps only an original context to legacy entries and rejects cross-Conversation context IDs", async () => {
  const original = crypto.randomUUID();
  const next = crypto.randomUUID();
  const foreign = crypto.randomUUID();
  const entry: ConversationEntry = {
    id: crypto.randomUUID(),
    ordinal: 7,
    kind: "user-message",
    actor: "user",
    mode: "build",
    body: "Immutable authored history",
    payload: {},
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdAt: "2026-11-20T10:00:00Z",
  };
  const fixture = conversationDatabase(({ text, parameters }) => {
    if (text.includes("FROM factory.conversation_context")) {
      expect(parameters[1]).toBe(conversationID);
      const id = parameters[0];
      return id === foreign
        ? []
        : [{ id, kind: "coding", original: id === original, mode: "build" }];
    }
    expect(text).toContain("payload->>'contextId' IS NOT DISTINCT FROM ?");
    expect(text).toEndWith("ORDER BY ordinal");
    expect(parameters[0]).toBe(conversationID);
    return [entry];
  });
  expect([...(await readConversationEntries(fixture.database, conversationID))]).toEqual([entry]);
  expect(fixture.statements.at(-1)?.parameters).toEqual([conversationID, null]);
  await readConversationEntries(fixture.database, conversationID, original);
  expect(fixture.statements.at(-1)?.parameters).toEqual([conversationID, null]);
  await readConversationEntries(fixture.database, conversationID, next);
  expect(fixture.statements.at(-1)?.parameters).toEqual([conversationID, next]);
  const before = fixture.statements.length;
  await expect(
    readConversationEntries(fixture.database, conversationID, foreign),
  ).rejects.toMatchObject({
    code: "not-found",
  });
  expect(fixture.statements).toHaveLength(before + 1);
  expect(fixture.statements.every(({ text }) => text.startsWith("SELECT"))).toBe(true);
});

test("shared reads and locks preserve root versions, research context versions and private Conversation lookup", async () => {
  const researchID = crypto.randomUUID();
  const codingID = crypto.randomUUID();
  const root = {
    id: conversationID,
    projectId: projectID,
    ticketId: ticketID,
    mode: "build" as const,
    version: 11,
    activeCodingContextId: codingID,
  };
  const fixture = conversationDatabase(({ text, parameters }) => {
    if (text.includes("FROM factory.conversation_context")) {
      return [
        {
          id: parameters[0],
          kind: parameters[0] === researchID ? "research" : "coding",
          mode: parameters[0] === researchID ? "plan" : "build",
        },
      ];
    }
    expect(text).toContain("FROM factory.ticket_conversation");
    return [root];
  });
  expect(await readConversation(fixture.database, conversationID, codingID)).toEqual({
    ...root,
    contextId: codingID,
  });
  expect(await readConversation(fixture.database, conversationID, researchID)).toEqual({
    ...root,
    contextId: researchID,
    mode: "plan",
    version: 1,
  });
  expect(
    await fixture.database.client.begin((sql) => lockConversation(sql, conversationID)),
  ).toEqual(root);
  expect(
    await fixture.database.client.begin((sql) => lockConversation(sql, conversationID, codingID)),
  ).toBeUndefined();
  expect(
    await fixture.database.client.begin((sql) => lockConversation(sql, conversationID, researchID)),
  ).toMatchObject({ id: conversationID, contextId: researchID, mode: "plan", version: 1 });
  await findConversation(fixture.database, projectID, undefined, userID);
  expect(fixture.statements.at(-1)?.parameters).toEqual([projectID, null, userID, null]);
  expect(fixture.statements.at(-1)?.text).toContain("ticket_id IS NULL AND created_by = ?");
});

test("ensure keeps Ticket-before-membership locking and the unversioned Coding barrier without dispatch", async () => {
  for (const blocked of [false, true]) {
    const fixture = conversationDatabase(
      ({ text }) => {
        if (text.startsWith("SELECT id FROM factory.ticket")) return [{ id: ticketID }];
        if (text.includes("pg_advisory_xact_lock")) return [];
        if (text.startsWith('SELECT id,project_id AS "projectId"')) return [];
        if (text.includes("conversation_id IS NULL"))
          return blocked ? [{ id: "retained-turn" }] : [];
        expect(text).toStartWith("INSERT INTO factory.ticket_conversation");
        return [
          {
            id: conversationID,
            projectId: projectID,
            ticketId: ticketID,
            mode: "build",
            version: 1,
          },
        ];
      },
      ({ text }) => {
        if (text.includes('"auth"."user"')) return [[userID]];
        if (text.includes('"factory"."account_access"')) return [[null, null]];
        if (text.includes('"factory"."project_membership"')) return [["developer", false]];
        if (text.includes('"factory"."administrator"')) return [];
        if (text.includes('"factory"."project"')) return [[projectID]];
        throw new Error(`Unexpected authority query: ${text}`);
      },
    );
    const result = fixture.database.client.begin((sql) =>
      ensureConversationIn(sql, projectID, ticketID, userID),
    );
    if (blocked) await expect(result).rejects.toThrow("must settle");
    else expect(await result).toMatchObject({ id: conversationID, mode: "build", version: 1 });
    expect(fixture.statements[0]?.text).toContain("FOR SHARE");
    expect(fixture.statements[1]?.text).toContain('"auth"."user"');
    expect(fixture.statements.every(({ transaction }) => transaction === 1)).toBe(true);
    expect(fixture.statements.some(({ text }) => text.startsWith("INSERT"))).toBe(!blocked);
  }
});
