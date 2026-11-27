import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDatabase } from "#db/client";
import { canonicalRequirementContent } from "#requirement-domain/requirement";
import {
  activateCodingContextIn,
  archiveContextIn,
  contextCommandIn,
  contextIn,
  contextsIn,
  contextTranscriptIn,
  insertContextIn,
} from "../../apps/factory/src/conversations/contexts";
import {
  appendConversationEntry,
  ensureConversationIn,
  findConversation,
  lockConversation,
  readConversation,
  readConversationEntries,
} from "../../apps/factory/src/conversations/store";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";

let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
beforeAll(async () => {
  server = await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
}, 60_000);

async function withDatabase(
  run: (owned: {
    database: ReturnType<typeof createDatabase>;
    userID: string;
    otherID: string;
    projectID: string;
    ticketID: string;
    changeID: string;
    revisionID: string;
    conversationID: string;
  }) => Promise<void>,
) {
  if (!server) throw new Error("Owned PostgreSQL server is required");
  const target = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = target.url;
  const database = createDatabase(3);
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  const userID = crypto.randomUUID();
  const otherID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  const changeID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const approvalID = crypto.randomUUID();
  try {
    await database.client.begin(async (transaction) => {
      for (const id of [userID, otherID]) {
        await transaction`INSERT INTO auth."user"(id,name,email,email_verified)
          VALUES(${id},'Conversation fixture',${`${id}@conversation.test`},true)`;
      }
      await transaction`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectID},${`conversation-${projectID}`},'Conversation fixture','https://example.invalid/fixture.git',
          'main','.factory/actor-template.json',${userID})`;
      for (const id of [userID, otherID]) {
        await transaction`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
          VALUES(${projectID},${id},'developer',${userID})`;
      }
      await transaction`INSERT INTO factory.ticket(id,project_id,title,created_by)
        VALUES(${ticketID},${projectID},'Conversation fixture',${userID})`;
      const content = canonicalRequirementContent({
        summary: "Conversation persistence",
        acceptanceCriteria: ["Retain exact history"],
        nonGoals: [],
      });
      await transaction`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${userID})`;
      await transaction`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
        VALUES(${approvalID},${ticketID},${revisionID},${userID})`;
      await transaction`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
        VALUES(${changeID},${projectID},${ticketID},${approvalID},
          ${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${"a".repeat(40)},'branch-pending',${userID})`;
    });
    const conversation = await database.client.begin((transaction) =>
      ensureConversationIn(transaction, projectID, ticketID, userID),
    );
    expect(conversation.mode).toBe("build");
    await run({
      database,
      userID,
      otherID,
      projectID,
      ticketID,
      changeID,
      revisionID,
      conversationID: conversation.id,
    });
  } finally {
    await database.client.end({ timeout: 2 });
    await target.dispose();
  }
}

function message(body: string, createdBy: string, contextId?: string) {
  return {
    kind: "user-message" as const,
    actor: "user" as const,
    mode: "build" as const,
    body,
    payload: { retained: true },
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdBy,
    ...(contextId ? { contextId } : {}),
  };
}

test("PostgreSQL retains exact contexts, replay receipts, original history and API timestamp strings", async () => {
  await withDatabase(async ({ database, conversationID, userID, otherID, projectID, changeID }) => {
    const original = crypto.randomUUID();
    const coding = crypto.randomUUID();
    const research = crypto.randomUUID();
    const commandID = crypto.randomUUID();
    const archive = {
      session: { id: "exact-original-session" },
      transcript: { messages: ["Retained"] },
    };
    const citations = [
      {
        source: "code" as const,
        id: crypto.randomUUID(),
        label: "Source",
        reference: 1,
        path: "README.md",
        commitSha: "a".repeat(40),
      },
    ];
    const entry = await database.client.begin(async (transaction) => {
      const saved = await appendConversationEntry(transaction, conversationID, {
        ...message("Original\n  authored question", userID),
        citations,
      });
      await insertContextIn(transaction, {
        id: original,
        conversationID,
        commandID: crypto.randomUUID(),
        createdBy: userID,
        kind: "coding",
        mode: "build",
        title: "Original fallback",
        changeID,
        nativeSessionID: archive.session.id,
        original: true,
        archive,
      });
      await insertContextIn(transaction, {
        id: coding,
        conversationID,
        commandID,
        createdBy: userID,
        kind: "coding",
        mode: "build",
        title: "Coding fallback",
        changeID,
        nativeSessionID: "exact-next-session",
        previousContextID: original,
      });
      await insertContextIn(transaction, {
        id: research,
        conversationID,
        commandID: crypto.randomUUID(),
        createdBy: userID,
        kind: "research",
        mode: "plan",
        title: "Research fallback",
      });
      await activateCodingContextIn(transaction, conversationID, coding);
      return saved;
    });
    expect(typeof entry.createdAt).toBe("string");
    expect(entry.createdAt).toBe(new Date(entry.createdAt).toISOString());
    expect(entry.citations).toEqual(citations);
    expect(await readConversationEntries(database, conversationID, original)).toEqual([entry]);
    expect(await readConversationEntries(database, conversationID, coding)).toEqual([]);
    expect(await contextTranscriptIn(database.client, conversationID)).toEqual({
      transcript: archive.transcript,
    });
    expect(
      await database.client.begin((tx) => contextIn(tx, conversationID, coding)),
    ).toMatchObject({
      id: coding,
      nativeSessionID: "exact-next-session",
      kind: "coding",
    });
    expect(await readConversation(database, conversationID, research)).toMatchObject({
      contextId: research,
      mode: "plan",
      version: 1,
      activeCodingContextId: coding,
    });
    expect(await readConversation(database, conversationID, coding)).toMatchObject({
      contextId: coding,
      mode: "build",
      version: 1,
    });
    await database.client.begin(async (transaction) => {
      const command = {
        conversationID,
        commandID,
        createdBy: userID,
        kind: "coding" as const,
        changeID,
        previousContextID: original,
      };
      expect(await contextCommandIn(transaction, command)).toBe(coding);
      for (const invalid of [
        { ...command, conversationID: crypto.randomUUID() },
        { ...command, createdBy: otherID },
        { ...command, kind: "research" as const },
        { ...command, changeID: crypto.randomUUID() },
        { ...command, previousContextID: null },
      ]) {
        await expect(contextCommandIn(transaction, invalid)).rejects.toMatchObject({
          code: "conflict",
        });
      }
      expect(await lockConversation(transaction, conversationID, coding)).toBeUndefined();
      expect(await lockConversation(transaction, conversationID, research)).toMatchObject({
        mode: "plan",
        version: 1,
      });
    });
    const personal = await database.client.begin((tx) =>
      ensureConversationIn(tx, projectID, undefined, otherID),
    );
    await expect(readConversationEntries(database, personal.id, coding)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(await contextTranscriptIn(database.client, personal.id, coding)).toBeUndefined();
    await expect(
      database.client.begin((tx) => archiveContextIn(tx, personal.id, coding, archive)),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      database.client.begin((tx) => archiveContextIn(tx, conversationID, original, archive)),
    ).rejects.toMatchObject({
      cause: { message: "Conversation identity and archived history are immutable" },
    });
    const archived =
      await database.client`SELECT archived_session,transcript FROM factory.conversation_context WHERE id=${original}`;
    expect(archived[0]).toEqual({
      archived_session: archive.session,
      transcript: archive.transcript,
    });
    await expect(
      database.client`UPDATE factory.conversation_entry SET body='Rewritten' WHERE id=${entry.id}`,
    ).rejects.toThrow("Conversation Entries are immutable");
    const contexts = await database.client.begin((tx) => contextsIn(tx, conversationID));
    expect(contexts.map((row) => row.id)).toEqual([research, coding, original]);
    expect(contexts.at(-1)?.title).toBe("Original authored question");
    expect(
      contexts.every(
        (row) =>
          typeof row.createdAt === "string" &&
          row.createdAt === new Date(row.createdAt).toISOString(),
      ),
    ).toBe(true);
  });
});

test("PostgreSQL context titles prefer the earliest authored entry, then admitted input, then saved title", async () => {
  await withDatabase(async ({ database, conversationID, userID, projectID, ticketID }) => {
    const inputContext = crypto.randomUUID();
    const entryContext = crypto.randomUUID();
    const emptyContext = crypto.randomUUID();
    await database.client.begin(async (tx) => {
      for (const id of [inputContext, entryContext, emptyContext]) {
        await insertContextIn(tx, {
          id,
          conversationID,
          commandID: crypto.randomUUID(),
          createdBy: userID,
          kind: "research",
          mode: "investigate",
          title: "Saved fallback",
        });
      }
      for (const [index, text] of ["Earliest\n admitted input", "Later input"].entries()) {
        await tx`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,conversation_id,created_by,input,input_digest,authority,state,created_at)
          VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${projectID},${ticketID},${conversationID},${userID},
            ${JSON.stringify({ kind: "project-message", contextId: inputContext, text })}::jsonb,
            ${"a".repeat(64)},'{"mode":"investigate"}','completed',${new Date(1000 + index).toISOString()})`;
      }
      await appendConversationEntry(tx, conversationID, {
        ...message("Ignore agent reply", userID, entryContext),
        actor: "project-agent",
        kind: "agent-message",
      });
      await appendConversationEntry(
        tx,
        conversationID,
        message(`First\n  ${"x".repeat(100)}`, userID, entryContext),
      );
      await appendConversationEntry(
        tx,
        conversationID,
        message("Second user entry", userID, entryContext),
      );
    });
    const rows = await database.client.begin((tx) => contextsIn(tx, conversationID));
    expect(rows.map((row) => row.title)).toEqual([
      "Saved fallback",
      `First ${"x".repeat(74)}`,
      "Earliest admitted input",
    ]);
    expect(
      (await readConversationEntries(database, conversationID, entryContext)).map(
        (row) => row.body,
      ),
    ).toHaveLength(3);
  });
});

test("PostgreSQL JSON-null archives remain immutable and context identity cannot be rewritten", async () => {
  await withDatabase(async ({ database, conversationID, userID, changeID }) => {
    for (const insertNull of [true, false]) {
      const id = crypto.randomUUID();
      await database.client.begin(async (tx) => {
        await insertContextIn(tx, {
          id,
          conversationID,
          commandID: crypto.randomUUID(),
          createdBy: userID,
          kind: "coding",
          mode: "build",
          title: "Null archive",
          changeID,
          nativeSessionID: null,
          ...(insertNull ? { archive: { session: null, transcript: null } } : {}),
        });
        if (!insertNull)
          await archiveContextIn(tx, conversationID, id, { session: null, transcript: null });
      });
      const [row] = await database.client`SELECT archived_session IS NULL AS sql_null,
        jsonb_typeof(archived_session) AS session_type,jsonb_typeof(transcript) AS transcript_type
        FROM factory.conversation_context WHERE id=${id}`;
      expect(row).toEqual({ sql_null: false, session_type: "null", transcript_type: "null" });
      await expect(
        database.client.begin((tx) =>
          archiveContextIn(tx, conversationID, id, { session: {}, transcript: [] }),
        ),
      ).rejects.toMatchObject({
        cause: { message: "Conversation identity and archived history are immutable" },
      });
      await expect(
        database.client`UPDATE factory.conversation_context SET title='Rewritten' WHERE id=${id}`,
      ).rejects.toThrow("Conversation identity and archived history are immutable");
    }
  });
});

test("PostgreSQL shares the caller's commit, rollback and nested savepoint connection", async () => {
  await withDatabase(async ({ database, conversationID, userID }) => {
    const id = crypto.randomUUID();
    await expect(
      database.client.begin(async (tx) => {
        await insertContextIn(tx, {
          id,
          conversationID,
          commandID: crypto.randomUUID(),
          createdBy: userID,
          kind: "research",
          mode: "plan",
          title: "Rolled back context",
        });
        await appendConversationEntry(tx, conversationID, message("Rolled back entry", userID, id));
        expect(await contextIn(tx, conversationID, id)).toMatchObject({ id });
        throw new Error("Owned outer rollback");
      }),
    ).rejects.toThrow("Owned outer rollback");
    expect(await contextTranscriptIn(database.client, conversationID, id)).toBeUndefined();
    await database.client.begin(async (tx) => {
      const [before] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await expect(
        tx.savepoint(async (nested) => {
          await insertContextIn(nested, {
            id,
            conversationID,
            commandID: crypto.randomUUID(),
            createdBy: userID,
            kind: "research",
            mode: "plan",
            title: "Savepoint context",
          });
          await appendConversationEntry(nested, conversationID, message("Savepoint entry", userID));
          throw new Error("Owned savepoint rollback");
        }),
      ).rejects.toThrow("Owned savepoint rollback");
      expect(await contextTranscriptIn(tx, conversationID, id)).toBeUndefined();
      const committed = await appendConversationEntry(
        tx,
        conversationID,
        message("Committed entry", userID),
      );
      expect(committed.ordinal).toBe(1);
      const [after] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(after?.pid).toBe(before?.pid);
    });
    expect(
      (await readConversationEntries(database, conversationID)).map((row) => row.body),
    ).toEqual(["Committed entry"]);
  });
});

test("PostgreSQL context and entry writers contend on one Conversation lock and allocate unique ordinals", async () => {
  await withDatabase(async ({ database, conversationID, userID, changeID }) => {
    const entered = Promise.withResolvers<number>();
    const competing = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const first = database.client.begin(async (tx) => {
      await insertContextIn(tx, {
        id: crypto.randomUUID(),
        conversationID,
        commandID: crypto.randomUUID(),
        createdBy: userID,
        kind: "research",
        mode: "plan",
        title: "First context",
      });
      const [session] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!session) throw new Error("First connection missing");
      entered.resolve(session.pid);
      await release.promise;
      return appendConversationEntry(tx, conversationID, message("First writer", userID));
    });
    let second: Promise<unknown> | undefined;
    try {
      const firstPID = await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("First writer ended before reporting its connection");
        }),
      ]);
      second = database.client.begin(async (tx) => {
        const [session] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!session) throw new Error("Second connection missing");
        competing.resolve(session.pid);
        const entry = await appendConversationEntry(
          tx,
          conversationID,
          message("Second writer", userID),
        );
        await insertContextIn(tx, {
          id: crypto.randomUUID(),
          conversationID,
          commandID: crypto.randomUUID(),
          createdBy: userID,
          kind: "coding",
          mode: "build",
          title: "Second context",
          changeID,
          nativeSessionID: null,
        });
        return entry;
      });
      const secondPID = await Promise.race([
        competing.promise,
        second.then(() => {
          throw new Error("Second writer ended before reporting its connection");
        }),
      ]);
      expect(secondPID).not.toBe(firstPID);
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [activity] = await database.client<{ waiting: boolean }[]>`
          SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${secondPID}`;
        if (activity?.waiting) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    await first;
    await second;
    expect(
      (await readConversationEntries(database, conversationID)).map((row) => [
        row.ordinal,
        row.body,
      ]),
    ).toEqual([
      [1, "First writer"],
      [2, "Second writer"],
    ]);
    expect(
      (await database.client.begin((tx) => contextsIn(tx, conversationID))).map((row) => [
        row.ordinal,
        row.kind,
      ]),
    ).toEqual([
      [2, "coding"],
      [1, "research"],
    ]);
  });
}, 15_000);

test("PostgreSQL ensure preserves personal lookup, no-Change mode and explicit membership authorization", async () => {
  await withDatabase(async ({ database, userID, otherID, projectID, ticketID, conversationID }) => {
    const personal = await database.client.begin((tx) =>
      ensureConversationIn(tx, projectID, undefined, userID),
    );
    expect(personal).toMatchObject({
      projectId: projectID,
      ticketId: null,
      mode: "investigate",
      version: 1,
    });
    expect(await findConversation(database, projectID, undefined, otherID)).toBeUndefined();
    expect(await findConversation(database, projectID, undefined, userID)).toMatchObject({
      id: personal.id,
    });
    expect(await findConversation(database, projectID, ticketID, otherID)).toMatchObject({
      id: conversationID,
    });
    expect(
      (await database.client.begin((tx) => ensureConversationIn(tx, projectID, undefined, userID)))
        .id,
    ).toBe(personal.id);
    const freshTicket = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${freshTicket},${projectID},'No Change',${userID})`;
    expect(
      await database.client.begin((tx) => ensureConversationIn(tx, projectID, freshTicket, userID)),
    ).toMatchObject({ mode: "investigate" });
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${projectID} AND user_id=${otherID}`;
    await expect(
      database.client.begin((tx) => ensureConversationIn(tx, projectID, ticketID, otherID)),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      database.client.begin((tx) =>
        ensureConversationIn(tx, projectID, crypto.randomUUID(), userID),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

test("PostgreSQL refuses new shared conversations while unversioned Coding turns remain unresolved", async () => {
  await withDatabase(
    async ({ database, userID, projectID, ticketID, changeID, revisionID, conversationID }) => {
      await database.client`DELETE FROM factory.ticket_conversation WHERE id=${conversationID}`;
      for (const state of ["pending", "dispatching", "running", "uncertain"] as const) {
        await expect(
          database.client.begin(async (tx) => {
            await tx`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,
            input,input_digest,authority,state,owner_token,owner_expires_at)
            VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${projectID},${ticketID},${changeID},
              ${userID},'{"kind":"change-prompt"}',${"a".repeat(64)},
              ${JSON.stringify({ mode: "build", requirementRevisionId: revisionID })}::jsonb,
              ${state},${state === "uncertain" ? null : crypto.randomUUID()},
              ${state === "uncertain" ? null : new Date(Date.now() + 60_000).toISOString()})`;
            await expect(
              ensureConversationIn(tx, projectID, ticketID, userID),
            ).rejects.toMatchObject({
              code: "conflict",
            });
            expect(await findConversation(database, projectID, ticketID, userID)).toBeUndefined();
            throw new Error("Owned unresolved turn rollback");
          }),
        ).rejects.toThrow("Owned unresolved turn rollback");
      }
      expect(
        await database.client.begin((tx) => ensureConversationIn(tx, projectID, ticketID, userID)),
      ).toMatchObject({ mode: "build" });
    },
  );
});
