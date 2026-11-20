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
  const fixture = conversationDatabase(
    () => {
      throw new Error("Conversation persistence must use typed queries");
    },
    ({ text, parameters, transaction }) => {
      expect(transaction).toBe(1);
      if (text.startsWith("select")) {
        expect(parameters).toEqual([conversationID]);
        expect(text).toEndWith("for update");
        return [[conversationID]];
      }
      expect(text).toStartWith('insert into "factory"."conversation_entry"');
      expect(text).toContain('COALESCE(MAX("ordinal"), 0) + 1');
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
        [
          parameters[0],
          "17",
          input.kind,
          input.actor,
          input.mode,
          input.body,
          parameters[7],
          "[]",
          input.inReplyToEntryId,
          input.requirementRevisionId,
          "2026-11-20T10:00:00Z",
        ],
      ];
    },
  );
  const entry = await fixture.database.client.begin((sql) =>
    appendConversationEntry(sql, conversationID, input),
  );
  expect(entry).toMatchObject({
    ordinal: 17,
    body: input.body,
    inReplyToEntryId: input.inReplyToEntryId,
    requirementRevisionId: input.requirementRevisionId,
    payload: { turnId: input.payload.turnId, contextId: input.contextId },
    createdAt: "2026-11-20T10:00:00.000Z",
  });
  expect(entry.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(input)).toBe(before);
  expect(fixture.statements.map(({ text }) => text.split(" ")[0])).toEqual(["select", "insert"]);
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
    createdAt: "2026-11-20T10:00:00.000Z",
  };
  const fixture = conversationDatabase(
    () => {
      throw new Error("History must use typed queries");
    },
    ({ text, parameters }) => {
      if (text.includes('from "factory"."conversation_context"')) {
        expect(parameters[1]).toBe(conversationID);
        const id = parameters[0];
        return id === foreign ? [] : [[id, "coding", id === original, null, "build"]];
      }
      expect(text).toContain(
        '"conversation_entry"."payload"->>\'contextId\' IS NOT DISTINCT FROM $2',
      );
      expect(text).toEndWith('order by "factory"."conversation_entry"."ordinal" asc');
      expect(parameters[0]).toBe(conversationID);
      return [
        [
          entry.id,
          "7",
          entry.kind,
          entry.actor,
          entry.mode,
          entry.body,
          "{}",
          "[]",
          null,
          null,
          entry.createdAt,
        ],
      ];
    },
  );
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
  expect(fixture.statements.every(({ text }) => text.startsWith("select"))).toBe(true);
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
  const fixture = conversationDatabase(
    () => {
      throw new Error("Reads and locks must use typed queries");
    },
    ({ text, parameters }) => {
      if (text.includes('from "factory"."conversation_context"')) {
        return [
          [
            parameters[0],
            parameters[0] === researchID ? "research" : "coding",
            false,
            null,
            parameters[0] === researchID ? "plan" : "build",
          ],
        ];
      }
      expect(text).toContain('from "factory"."ticket_conversation"');
      return [
        [
          conversationID,
          projectID,
          ticketID,
          "build",
          "11",
          ...(text.includes('"active_coding_context_id"') ? [codingID] : []),
        ],
      ];
    },
  );
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
  ).toEqual({
    id: conversationID,
    projectId: projectID,
    ticketId: ticketID,
    mode: "build",
    version: 11,
  });
  expect(
    await fixture.database.client.begin((sql) => lockConversation(sql, conversationID, codingID)),
  ).toBeUndefined();
  expect(
    await fixture.database.client.begin((sql) => lockConversation(sql, conversationID, researchID)),
  ).toMatchObject({ id: conversationID, contextId: researchID, mode: "plan", version: 1 });
  await findConversation(fixture.database, projectID, undefined, userID);
  expect(fixture.statements.at(-1)?.parameters).toEqual([projectID, userID, 1]);
  expect(fixture.statements.at(-1)?.text).toContain('"ticket_conversation"."ticket_id" is null');
  expect(fixture.statements.at(-1)?.text).toContain('"ticket_conversation"."created_by" = $2');
});

test("ensure keeps Ticket-before-membership locking and the unversioned Coding barrier without dispatch", async () => {
  for (const blocked of [false, true]) {
    const fixture = conversationDatabase(
      () => {
        throw new Error("Ensure must use typed queries");
      },
      ({ text }) => {
        if (text.includes('from "factory"."ticket"')) return [[ticketID]];
        if (text.includes("pg_advisory_xact_lock")) return [];
        if (text.includes('from "factory"."ticket_conversation"')) return [];
        if (text.includes("union all")) {
          expect(text).toContain('"agent_turn"."conversation_id" is null');
          expect(text).toContain('"change_agent_session"."stop_pending"');
          expect(text).toContain('"change_commit_operation"."state" not in');
          return blocked ? [["retained-turn"]] : [];
        }
        if (text.includes('from "factory"."change"')) return [[crypto.randomUUID()]];
        if (text.startsWith('insert into "factory"."ticket_conversation"'))
          return [[conversationID, projectID, ticketID, "build", "1"]];
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
    expect(fixture.statements[0]?.text).toContain("for share");
    expect(fixture.statements[1]?.text).toContain('"auth"."user"');
    expect(fixture.statements.every(({ transaction }) => transaction === 1)).toBe(true);
    expect(fixture.statements.some(({ text }) => text.startsWith("insert"))).toBe(!blocked);
  }
});
