import { expect, test } from "bun:test";
import { conversationDatabase } from "../../../../test/support/conversation-persistence";
import {
  activateCodingContextIn,
  archiveContextIn,
  contextCommandIn,
  contextTranscriptIn,
  insertContextIn,
} from "./contexts";

const conversationID = crypto.randomUUID();
const userID = crypto.randomUUID();
const changeID = crypto.randomUUID();

test("research, original Coding and fresh Coding use the same locked ordinal/identity persistence", async () => {
  const archive = {
    session: { id: "retained-native-session", active_turn_id: crypto.randomUUID() },
    transcript: { turn: { id: crypto.randomUUID() }, messages: ["Retained history"] },
  };
  const contexts: Array<Parameters<typeof insertContextIn>[1]> = [
    {
      id: crypto.randomUUID(),
      conversationID,
      commandID: crypto.randomUUID(),
      createdBy: userID,
      kind: "research",
      mode: "plan",
      title: "New conversation",
    },
    {
      id: crypto.randomUUID(),
      conversationID,
      commandID: crypto.randomUUID(),
      createdBy: userID,
      kind: "coding",
      mode: "build",
      title: "Original Coding conversation",
      changeID,
      nativeSessionID: "retained-native-session",
      original: true,
      archive,
    },
    {
      id: crypto.randomUUID(),
      conversationID,
      commandID: crypto.randomUUID(),
      createdBy: userID,
      kind: "coding",
      mode: "build",
      title: "New Coding conversation",
      changeID,
      nativeSessionID: "exact-new-session",
      previousContextID: crypto.randomUUID(),
    },
  ];
  let current = contexts[0];
  const fixture = conversationDatabase(({ text, parameters }) => {
    if (text.startsWith("SELECT")) {
      expect(text).toEndWith("FOR UPDATE");
      expect(parameters).toEqual([conversationID]);
      return [{ id: conversationID }];
    }
    if (!current) throw new Error("Missing test context");
    const coding = current.kind === "coding" ? current : undefined;
    expect(text).toContain("COALESCE(MAX(ordinal),0)+1");
    expect(parameters).toEqual([
      current.id,
      conversationID,
      current.commandID,
      current.kind,
      conversationID,
      current.title,
      userID,
      current.mode,
      coding?.changeID ?? null,
      coding?.nativeSessionID ?? null,
      coding?.previousContextID ?? null,
      coding?.original ?? false,
      coding?.archive ? JSON.stringify(coding.archive.session) : null,
      coding?.archive ? JSON.stringify(coding.archive.transcript) : "[]",
    ]);
    return [];
  });
  const before = JSON.stringify(contexts);
  await fixture.database.client.begin(async (sql) => {
    for (current of contexts) await insertContextIn(sql, current);
  });
  expect(JSON.stringify(contexts)).toBe(before);
  expect(fixture.statements.map(({ text }) => text.split(" ")[0])).toEqual([
    "SELECT",
    "INSERT",
    "SELECT",
    "INSERT",
    "SELECT",
    "INSERT",
  ]);
  expect(fixture.statements.every(({ transaction }) => transaction === 1)).toBe(true);
});

test("shared context receipts return exact IDs and reject cross-kind, user, Conversation, Change and previous-context reuse", async () => {
  const commandID = crypto.randomUUID();
  const contextID = crypto.randomUUID();
  for (const kind of ["research", "coding"] as const) {
    const receipt = {
      id: contextID,
      conversationID,
      userID,
      kind,
      changeID: kind === "coding" ? changeID : null,
      previousID: null,
    };
    let observed: Omit<typeof receipt, "previousID"> & { previousID: string | null } = {
      ...receipt,
    };
    const fixture = conversationDatabase(({ text, parameters }) => {
      expect(text).toStartWith("SELECT");
      expect(parameters).toEqual([commandID]);
      return [observed];
    });
    const command: Parameters<typeof contextCommandIn>[1] =
      kind === "research"
        ? { conversationID, commandID, createdBy: userID, kind }
        : { conversationID, commandID, createdBy: userID, kind, changeID, previousContextID: null };
    expect(await fixture.database.client.begin((sql) => contextCommandIn(sql, command))).toBe(
      contextID,
    );
    for (const invalid of [
      { ...receipt, conversationID: crypto.randomUUID() },
      { ...receipt, userID: crypto.randomUUID() },
      { ...receipt, kind: kind === "research" ? ("coding" as const) : ("research" as const) },
      ...(kind === "coding"
        ? [
            { ...receipt, changeID: crypto.randomUUID() },
            { ...receipt, previousID: crypto.randomUUID() },
          ]
        : []),
    ]) {
      observed = invalid;
      await expect(
        fixture.database.client.begin((sql) => contextCommandIn(sql, command)),
      ).rejects.toThrow("different input");
    }
    expect(fixture.statements.every(({ text }) => text.startsWith("SELECT"))).toBe(true);
  }
});

test("archive and active pointer writes retain exact payloads without touching history, versions, epochs or native sessions", async () => {
  const contextID = crypto.randomUUID();
  const transcript = {
    turn: { id: crypto.randomUUID() },
    messages: [{ id: "immutable-message", text: "Retained" }],
  };
  const archive = { session: { active_turn_id: transcript.turn.id }, transcript };
  const before = JSON.stringify(archive);
  const fixture = conversationDatabase(({ text, parameters }) => {
    if (text.startsWith("UPDATE factory.conversation_context")) {
      expect(text).toContain("WHERE id=? AND conversation_id=?");
      expect(parameters).toEqual([
        JSON.stringify(archive.session),
        JSON.stringify(transcript),
        contextID,
        conversationID,
      ]);
    } else {
      expect(text).toStartWith("UPDATE factory.ticket_conversation SET active_coding_context_id");
      expect(parameters).toEqual([contextID, conversationID]);
    }
    expect(text).not.toMatch(
      /version|epoch|factory\.conversation_entry|factory\.change_agent_session/,
    );
    return [{ id: contextID }];
  });
  await fixture.database.client.begin(async (sql) => {
    await archiveContextIn(sql, conversationID, contextID, archive);
    await activateCodingContextIn(sql, conversationID, contextID);
  });
  expect(JSON.stringify(archive)).toBe(before);
  expect(fixture.statements.every(({ transaction }) => transaction === 1)).toBe(true);
});

test("a missing or cross-Conversation archive target cannot be treated as saved", async () => {
  const fixture = conversationDatabase(() => []);
  await expect(
    fixture.database.client.begin((sql) =>
      archiveContextIn(sql, conversationID, crypto.randomUUID(), { session: {}, transcript: {} }),
    ),
  ).rejects.toMatchObject({ code: "conflict", message: "Conversation context changed." });
});

test("transcript reads stay scoped to the requested context or the retained original", async () => {
  const contextID = crypto.randomUUID();
  const transcript = { messages: [{ id: "original-message", text: "Retained authored text" }] };
  const fixture = conversationDatabase(({ text, parameters }) => {
    expect(text).toContain("WHERE conversation_id=?");
    expect(text).toContain("?::uuid IS NULL AND original");
    expect(parameters).toEqual([conversationID, parameters[1], parameters[1]]);
    return [{ transcript }];
  });
  expect(await contextTranscriptIn(fixture.database.client, conversationID, contextID)).toEqual({
    transcript,
  });
  expect(fixture.statements.at(-1)?.parameters).toEqual([conversationID, contextID, contextID]);
  expect(await contextTranscriptIn(fixture.database.client, conversationID)).toEqual({
    transcript,
  });
  expect(fixture.statements.at(-1)?.parameters).toEqual([conversationID, null, null]);
});

test("context inserts await the Conversation lock and preserve explicit archive nulls rather than defaults", async () => {
  const lock = Promise.withResolvers<unknown[]>();
  const fixture = conversationDatabase(({ text, parameters }) => {
    if (text.startsWith("SELECT")) return lock.promise;
    expect(parameters.slice(-2)).toEqual(["null", "null"]);
    return [];
  });
  const pending = fixture.database.client.begin((sql) =>
    insertContextIn(sql, {
      id: crypto.randomUUID(),
      conversationID,
      commandID: crypto.randomUUID(),
      createdBy: userID,
      title: "Original Coding conversation",
      kind: "coding",
      mode: "build",
      changeID,
      nativeSessionID: null,
      original: true,
      archive: { session: null, transcript: null },
    }),
  );
  expect(fixture.statements).toHaveLength(1);
  expect(fixture.statements[0]?.text).toEndWith("FOR UPDATE");
  lock.resolve([{ id: conversationID }]);
  await pending;
  expect(fixture.statements).toHaveLength(2);
});
