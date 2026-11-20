import { expect, test } from "bun:test";
import { conversationDatabase } from "../../../../test/support/conversation-persistence";
import { createCodingContexts } from "./conversation-contexts";

function codingContextFixture() {
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  const contextRows = new Map<
    string,
    {
      id: string;
      conversationID: string;
      commandID: string;
      userID: string;
      kind: string;
      changeID: string;
      previousID: string | null;
      original: boolean;
      nativeID: string;
      session: unknown;
      transcript: unknown;
    }
  >();
  const state = {
    contextID: null as string | null,
    latestTurnID: crypto.randomUUID() as string | null,
    nativeID: "retained-exact-native-session",
    writer: {
      projectID,
      available: true,
      state: "agent",
      userID: null as string | null,
      epoch: "9",
      turnID: null,
    },
    developer: true,
    settled: true,
    failArchive: false,
    resets: 0,
  };
  const fixture = conversationDatabase(
    ({ text, parameters }) => {
      if (text.startsWith("SELECT change.project_id"))
        return [{ projectID, available: state.writer.available }];
      if (text.startsWith("SELECT state,epoch")) return [state.writer];
      if (text.startsWith("SELECT ticket_id")) return [{ ticketID }];
      if (text.startsWith("SELECT id FROM factory.ticket")) return [{ id: ticketID }];
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.startsWith('SELECT id,project_id AS "projectId"'))
        return [
          {
            id: conversationID,
            projectId: projectID,
            ticketId: ticketID,
            mode: "build",
            version: 11,
            activeCodingContextId: state.contextID,
          },
        ];
      if (text.startsWith("SELECT conversation.id"))
        return [{ id: conversationID, contextID: state.contextID }];
      if (text.includes("FROM factory.conversation_context WHERE command_id"))
        return [...contextRows.values()].filter((row) => row.commandID === parameters[0]);
      if (text.startsWith("SELECT to_jsonb(session)")) {
        expect(text).toContain("state IN ('committed','stopped') AND NOT stop_pending");
        expect(text).toContain("factory.agent_turn");
        expect(text).toContain("factory.change_commit_operation");
        expect(text).toContain("factory.candidate_review");
        expect(parameters.slice(0, 6)).toEqual([
          changeID,
          changeID,
          changeID,
          changeID,
          changeID,
          state.contextID,
        ]);
        return state.settled && parameters[6] === state.latestTurnID
          ? [
              {
                session: {
                  active_turn_id: state.latestTurnID,
                  opencode_session_id: state.nativeID,
                },
                nativeID: state.nativeID,
              },
            ]
          : [];
      }
      if (text.startsWith("SELECT id FROM factory.ticket_conversation")) {
        expect(parameters).toEqual([conversationID]);
        expect(text).toEndWith("FOR UPDATE");
        return [{ id: conversationID }];
      }
      if (text.startsWith("INSERT INTO factory.conversation_context")) {
        const [
          id,
          parent,
          commandID,
          kind,
          ordinalParent,
          _title,
          creator,
          mode,
          change,
          nativeID,
          previousID,
          original,
          session,
          transcript,
        ] = parameters;
        expect([parent, ordinalParent, creator, mode, change]).toEqual([
          conversationID,
          conversationID,
          userID,
          "build",
          changeID,
        ]);
        contextRows.set(String(id), {
          id: String(id),
          conversationID,
          commandID: String(commandID),
          userID,
          kind: String(kind),
          changeID,
          previousID: previousID as string | null,
          original: original as boolean,
          nativeID: String(nativeID),
          session: session === null ? null : JSON.parse(String(session)),
          transcript: JSON.parse(String(transcript)),
        });
        return [];
      }
      if (text.startsWith("UPDATE factory.conversation_context")) {
        if (state.failArchive) throw new Error("Owned archive write unavailable");
        expect(parameters[3]).toBe(conversationID);
        const context = contextRows.get(String(parameters[2]));
        if (!context) throw new Error("Missing owned context");
        context.session = JSON.parse(String(parameters[0]));
        context.transcript = JSON.parse(String(parameters[1]));
        return [{ id: context.id }];
      }
      if (text.startsWith("UPDATE factory.ticket_conversation")) {
        expect(parameters[1]).toBe(conversationID);
        expect(text).not.toMatch(/version|epoch/);
        state.contextID = String(parameters[0]);
        return [];
      }
      if (text.startsWith("UPDATE factory.change_agent_session")) {
        expect(parameters).toEqual([
          state.contextID ? `ses_factory_${state.contextID.replaceAll("-", "")}` : null,
          parameters[0],
          changeID,
        ]);
        expect(text).toContain("native_session_confirmed_at=NULL");
        expect(text).toContain("implementation_session_confirmed_at=NULL");
        expect(text).toContain("active_turn_id=NULL,active_inbox_id=NULL");
        state.nativeID = String(parameters[0]);
        state.latestTurnID = null;
        state.resets++;
        return [];
      }
      throw new Error(`Unexpected Coding context query: ${text}`);
    },
    ({ text }) => {
      if (text.includes('"auth"."user"')) return [[userID]];
      if (text.includes('"factory"."account_access"')) return [[null, null]];
      if (text.includes('"factory"."project_membership"'))
        return [[state.developer ? "developer" : "product-contributor", false]];
      if (text.includes('"factory"."administrator"')) return [];
      if (text.includes('"factory"."project"')) return [[projectID]];
      throw new Error(`Unexpected Coding context authority: ${text}`);
    },
  );
  return {
    ...fixture,
    userID,
    changeID,
    state,
    contextRows,
    rotate: createCodingContexts(fixture.database),
  };
}

test("Coding archives and rotates through the shared owner while keeping exact sessions, history, versions and writer epochs", async () => {
  const fixture = codingContextFixture();
  const { rotate, state, contextRows, changeID, userID } = fixture;
  const snapshot = {
    turn: { id: state.latestTurnID ?? "" },
    messages: [{ id: "old-exact-message", text: "Retained" }],
  };
  const commandID = crypto.randomUUID();
  const first = await rotate(changeID, userID, commandID, null, snapshot);
  const rows = [...contextRows.values()];
  const original = rows.find((row) => row.original);
  expect(original?.nativeID).toBe("retained-exact-native-session");
  expect(original?.transcript).toEqual(snapshot);
  expect(original?.session).toMatchObject({ active_turn_id: snapshot.turn.id });
  expect(contextRows.get(first)).toMatchObject({
    commandID,
    previousID: null,
    nativeID: `ses_factory_${first.replaceAll("-", "")}`,
    original: false,
    session: null,
    transcript: [],
  });
  expect(state.resets).toBe(1);
  expect(state.writer.epoch).toBe("9");
  const originalBytes = JSON.stringify(original);
  const nextSnapshot = {
    turn: null,
    messages: [{ id: "next-exact-message", text: "Next context" }],
  };
  const second = await rotate(changeID, userID, crypto.randomUUID(), first, nextSnapshot);
  expect(second).not.toBe(first);
  expect(contextRows.get(first)?.transcript).toEqual(nextSnapshot);
  expect(contextRows.get(second)?.previousID).toBe(first);
  expect(JSON.stringify(original)).toBe(originalBytes);
  expect(await rotate(changeID, userID, commandID, null, snapshot)).toBe(first);
  expect(contextRows.size).toBe(3);
  expect(state.resets).toBe(2);
  const writes = fixture.statements.filter(({ text }) => /^(INSERT|UPDATE)/.test(text));
  expect(writes.filter(({ transaction }) => transaction === 3)).toHaveLength(0);
  for (const transaction of [1, 2]) {
    const current = writes.filter((statement) => statement.transaction === transaction);
    expect(current.at(-1)?.text).toStartWith("UPDATE factory.change_agent_session");
    expect(current.at(-2)?.text).toStartWith("UPDATE factory.ticket_conversation");
  }
});

test("Coding admission, stale transcript, replay mismatch and archive failures never reach session reset", async () => {
  for (const failure of [
    "developer",
    "unavailable",
    "context",
    "handoff",
    "human",
    "unsettled",
    "transcript",
    "replay",
    "archive",
  ]) {
    const fixture = codingContextFixture();
    const { state, rotate, changeID, userID } = fixture;
    const commandID = crypto.randomUUID();
    const snapshot: { turn: { id: string } | null; messages: unknown[] } = {
      turn: { id: state.latestTurnID ?? "" },
      messages: [],
    };
    let expectedContextID: string | null = null;
    if (failure === "developer") state.developer = false;
    if (failure === "unavailable") state.writer.available = false;
    if (failure === "context") state.contextID = crypto.randomUUID();
    if (failure === "handoff") state.writer.state = "handoff";
    if (failure === "human") {
      state.writer.state = "human";
      state.writer.userID = crypto.randomUUID();
    }
    if (failure === "unsettled") state.settled = false;
    if (failure === "transcript" && snapshot.turn) snapshot.turn.id = crypto.randomUUID();
    if (failure === "replay" || failure === "archive") {
      const first = await rotate(changeID, userID, commandID, null, snapshot);
      const row = fixture.contextRows.get(first);
      if (!row) throw new Error("Missing first owned context");
      if (failure === "replay") row.kind = "research";
      else {
        state.failArchive = true;
        expectedContextID = first;
        snapshot.turn = null;
      }
    }
    const before = state.resets;
    await expect(
      rotate(
        changeID,
        userID,
        failure === "archive" ? crypto.randomUUID() : commandID,
        expectedContextID,
        snapshot,
      ),
    ).rejects.toThrow();
    expect(state.resets).toBe(before);
    expect(state.writer.epoch).toBe("9");
    const lastTransaction = fixture.transactions();
    const writes = fixture.statements.filter(
      ({ text, transaction }) => transaction === lastTransaction && /^(INSERT|UPDATE)/.test(text),
    );
    expect(writes).toHaveLength(failure === "archive" ? 1 : 0);
  }
});
