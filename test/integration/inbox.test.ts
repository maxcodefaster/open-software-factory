import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendConversationEntry } from "../../apps/factory/src/conversations/store";
import { createInboxService } from "../../apps/factory/src/inbox/service";
import { mentionText } from "../../packages/ticket-domain/src/attention";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

// Retained Coding records only. These fixtures never dispatch a model or native runtime.
async function retainedCodingTurn(
  owned: Awaited<ReturnType<typeof fixture>>,
  state: "completed" | "failed",
  contextId: string,
  text: string,
  at: Date,
) {
  const id = crypto.randomUUID();
  const promptID = `msg_inbox_${id.replaceAll("-", "")}`;
  const input = JSON.stringify({ kind: "change-prompt", contextId, text });
  const authority = JSON.stringify({ mode: "build", requirementRevisionId: owned.revisionID });
  await owned.database.client.begin(async (sql) => {
    await sql`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,
      input,input_digest,authority,state,outcome_summary,created_at)
      VALUES(${id},${crypto.randomUUID()},${owned.projectID},${owned.ticketID},${owned.changeID},
        ${owned.userID},${input}::jsonb,${createHash("sha256").update(input).digest("hex")},
        ${authority}::jsonb,${state},'Owned retained outcome',${at.toISOString()})`;
    await sql`INSERT INTO factory.change_agent_turn_intent(turn_id,change_id,session_id,prompt_id,
      prompt_text,bootstrap,session_title)
      VALUES(${id},${owned.changeID},${owned.sessionID},${promptID},${text},false,'Owned Inbox context')`;
  });
  return { id, promptID };
}

test("Inbox retains responsibility and personal receipts while deriving current authorized requests and grouped activity", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const service = createInboxService(database);
    const contributor = crypto.randomUUID(),
      peer = crypto.randomUUID(),
      outsider = crypto.randomUUID();
    for (const [id, name, role] of [
      [contributor, "Product colleague", "product-contributor"],
      [peer, "Developer colleague", "developer"],
      [outsider, "Unrelated person", null],
    ] as const) {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},${name},${`${id}@inbox.test`},true)`;
      if (role)
        await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${owned.projectID},${id},${role},${owned.userID})`;
    }
    expect((await service.ticket(owned.userID, owned.ticketID)).following).toBe(true);
    expect((await service.ticket(contributor, owned.ticketID)).following).toBe(false);
    expect(
      (await service.people(contributor, owned.projectID)).map((person) => person.id).sort(),
    ).toEqual([owned.userID, contributor, peer].sort());
    await expect(service.people(outsider, owned.projectID)).rejects.toThrow("Project not found");

    const assignment = {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      responsibleId: contributor,
    };
    const assigned = await service.responsibility(owned.userID, owned.ticketID, assignment);
    expect(assigned).toMatchObject({ responsibleId: contributor, version: 1 });
    expect((await service.ticket(contributor, owned.ticketID)).following).toBe(true);
    await service.responsibility(owned.userID, owned.ticketID, assignment);
    await expect(
      service.responsibility(owned.userID, owned.ticketID, { ...assignment, responsibleId: peer }),
    ).rejects.toThrow("identity changed");
    expect(await database.client`SELECT id FROM factory.ticket_responsibility_event`).toHaveLength(
      1,
    );
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
    expect(
      (await service.list(contributor)).items.some((item) => item.id.startsWith("responsibility:")),
    ).toBe(true);

    const conversationID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
      VALUES(${conversationID},${owned.projectID},${owned.ticketID},${owned.userID})`;
    async function entry(
      kind: "user-message" | "question" | "answer",
      actorID: string | null,
      body: string,
      payload: Record<string, unknown> = {},
      reply: string | null = null,
      id = conversationID,
    ) {
      return database.client.begin((sql) =>
        appendConversationEntry(sql, id, {
          kind,
          actor: kind === "question" ? "project-agent" : "user",
          mode: "plan",
          body,
          payload,
          citations: [],
          inReplyToEntryId: reply,
          requirementRevisionId: null,
          ...(actorID ? { createdBy: actorID } : {}),
        }),
      );
    }
    const question = await entry("question", null, "Which customer flow should we support?");
    const requestID = `question:${question.id}`;
    expect((await service.list(contributor)).items.some((item) => item.id === requestID)).toBe(
      true,
    );
    expect((await service.list(peer)).items.some((item) => item.id === requestID)).toBe(false);
    let request = fixtureValue(
      (await service.list(contributor)).items.find((item) => item.id === requestID),
      "(await service.list(contributor)).items.find((item) => item.id === requestID)",
    );
    await service.receipt(contributor, {
      itemId: request.id,
      eventId: request.eventId,
      action: "read",
    });
    request = fixtureValue(
      (await service.list(contributor)).items.find((item) => item.id === requestID),
      "(await service.list(contributor)).items.find((item) => item.id === requestID)",
    );
    expect(request).toMatchObject({ needsAction: true, unread: false });
    await expect(
      service.receipt(contributor, {
        itemId: request.id,
        eventId: request.eventId,
        action: "archive",
      }),
    ).rejects.toThrow("Resolve this request");
    await entry("answer", contributor, "The existing customer flow.", {}, question.id);
    expect((await service.list(contributor)).items.some((item) => item.id === requestID)).toBe(
      false,
    );
    expect((await service.list(peer)).items.some((item) => item.id === requestID)).toBe(false);

    const technical = await entry("question", null, "Which exact source interface?", {
      visibility: "developer",
    });
    expect(
      (await service.list(contributor)).items.some(
        (item) => item.id === `question:${technical.id}`,
      ),
    ).toBe(false);
    expect(
      (await service.list(peer)).items.some((item) => item.id === `question:${technical.id}`),
    ).toBe(true);
    const active = await service.ticket(owned.userID, owned.ticketID);
    await service.responsibility(owned.userID, owned.ticketID, {
      commandId: crypto.randomUUID(),
      expectedVersion: active.version,
      responsibleId: peer,
    });
    expect(
      (await service.list(owned.userID)).items.some(
        (item) => item.id === `question:${technical.id}`,
      ),
    ).toBe(false);
    expect(
      (await service.list(peer)).items.some((item) => item.id === `question:${technical.id}`),
    ).toBe(true);
    await entry(
      "answer",
      peer,
      "Use the existing interface.",
      { visibility: "developer" },
      technical.id,
    );

    await service.follow(contributor, owned.ticketID, false);
    await entry("user-message", owned.userID, "An ordinary update.");
    expect(
      (await service.list(contributor)).items.filter((item) => item.id.startsWith("conversation:")),
    ).toHaveLength(0);
    const token = mentionText({ id: contributor, name: "Product colleague" });
    await entry("user-message", owned.userID, `Please inspect this ${token}`);
    await entry("user-message", owned.userID, `One more detail for ${token}`);
    let discussion = fixtureValue(
      (await service.list(contributor)).items.find((item) => item.id.startsWith("conversation:")),
      '(await service.list(contributor)).items.find((item) => item.id.startsWith("conversation:"), )',
    );
    expect(discussion).toMatchObject({ needsAction: false, unread: true, updates: 2 });
    await service.receipt(contributor, {
      itemId: discussion.id,
      eventId: discussion.eventId,
      action: "archive",
    });
    expect(
      (await service.list(contributor)).items.find((item) => item.id === discussion.id)?.archived,
    ).toBe(true);
    await entry("user-message", owned.userID, `A new reply ${token}`);
    await expect(
      service.receipt(contributor, {
        itemId: discussion.id,
        eventId: discussion.eventId,
        action: "read",
      }),
    ).rejects.toThrow("changed");
    discussion = fixtureValue(
      (await service.list(contributor)).items.find((item) => item.id === discussion.id),
      "(await service.list(contributor)).items.find((item) => item.id === discussion.id)",
    );
    expect(discussion).toMatchObject({ unread: true, archived: false, updates: 3 });
    await service.receipt(contributor, {
      itemId: discussion.id,
      eventId: discussion.eventId,
      action: "read",
    });
    expect(
      (await service.list(contributor)).items.find((item) => item.id === discussion.id)?.unread,
    ).toBe(false);
    expect((await service.list(outsider)).items).toEqual([]);

    const feedbackID = crypto.randomUUID();
    await database.client`INSERT INTO factory.review_feedback(id,change_id,author_id,kind,state,commit_sha)
      VALUES(${feedbackID},${owned.changeID},${contributor},'thread','implemented',${"a".repeat(40)})`;
    // The responsible Developer is the preferred eligible recipient. A different
    // Contributor cannot resolve another person's Thread.
    expect(
      (await service.list(peer)).items.some((item) => item.id === `recheck:${feedbackID}`),
    ).toBe(true);
    await database.client`UPDATE factory.review_feedback SET state='resolved',version=version+1 WHERE id=${feedbackID}`;
    expect(
      (await service.list(peer)).items.some((item) => item.id === `recheck:${feedbackID}`),
    ).toBe(false);

    const privateID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,created_by)
      VALUES(${privateID},${owned.projectID},${contributor})`;
    const personalQuestion = await entry(
      "question",
      null,
      "Private Project question",
      {},
      null,
      privateID,
    );
    expect(
      (await service.list(contributor)).items.some(
        (item) => item.id === `question:${personalQuestion.id}`,
      ),
    ).toBe(true);
    expect(
      (await service.list(peer)).items.some(
        (item) => item.id === `question:${personalQuestion.id}`,
      ),
    ).toBe(false);
    const overview = await service.list(contributor);
    expect(overview.count).toBe(
      overview.items.filter((item) => item.needsAction || (item.unread && !item.archived)).length,
    );

    const before = await service.ticket(owned.userID, owned.ticketID);
    const collision = await Promise.allSettled(
      [peer, contributor].map((id) =>
        service.responsibility(owned.userID, owned.ticketID, {
          commandId: crypto.randomUUID(),
          expectedVersion: before.version,
          responsibleId: id,
        }),
      ),
    );
    expect(collision.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(
      service.responsibility(owned.userID, owned.ticketID, {
        commandId: crypto.randomUUID(),
        expectedVersion: (await service.ticket(owned.userID, owned.ticketID)).version,
        responsibleId: outsider,
      }),
    ).rejects.toThrow("active member");
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${owned.projectID} AND user_id=${contributor}`;
    expect((await service.list(contributor)).items).toEqual([]);
    await expect(
      service.receipt(contributor, {
        itemId: discussion.id,
        eventId: discussion.eventId,
        action: "read",
      }),
    ).rejects.toThrow("changed");
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${peer}`;
    await expect(service.list(peer)).rejects.toThrow("disabled");
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 120_000);

test("Delivery, review supersession and blocked Inputs use the actual decision categories and independent management right", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await candidateReviewFixture(undefined, database);
    const service = createInboxService(database);
    await database.client`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,turn_id=NULL WHERE change_id=${owned.changeID}`;
    await database.client`UPDATE factory.candidate_review SET state='passed',result=${JSON.stringify({ summary: "Exact candidate inspected." })}::jsonb,
      completed_at=now() WHERE id=${owned.reviewID}`;
    const taskID = `delivery:${owned.reviewID}`;
    expect((await service.list(owned.userID)).items.some((item) => item.id === taskID)).toBe(true);
    const feedbackID = crypto.randomUUID();
    await database.client`INSERT INTO factory.review_feedback(id,change_id,author_id,kind,state,commit_sha)
      VALUES(${feedbackID},${owned.changeID},${owned.userID},'thread','open',${owned.commit})`;
    expect((await service.list(owned.userID)).items.some((item) => item.id === taskID)).toBe(false);
    await database.client`UPDATE factory.review_feedback SET state='resolved',version=version+1 WHERE id=${feedbackID}`;
    expect((await service.list(owned.userID)).items.some((item) => item.id === taskID)).toBe(true);
    await database.client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by,ordinal,supersedes_id)
      VALUES(${crypto.randomUUID()},${owned.verificationID},${owned.changeID},${owned.commit},${"a".repeat(40)},${owned.userID},2,${owned.reviewID})`;
    expect((await service.list(owned.userID)).items.some((item) => item.id === taskID)).toBe(false);

    const managerID = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${managerID},'Contributor with management',${`${managerID}@inbox.test`},true)`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${owned.projectID},${managerID},'product-contributor',true,${owned.userID})`;
    const hookID = crypto.randomUUID(),
      policyID = crypto.randomUUID(),
      incidentID = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.monitoring_hook(id,project_id,name,version,enabled,secret_digest,policy_id)
        VALUES(${hookID},${owned.projectID},'Owned Input',1,false,${"c".repeat(64)},${policyID})`;
      await sql`INSERT INTO factory.monitoring_policy(id,hook_id,delegated_by,delegation,instructions)
        VALUES(${policyID},${hookID},${managerID},'prepare-ticket','Clarify the received product request.')`;
    });
    await database.client`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,fingerprint,payload_digest,
      title,context,state,reason)
      VALUES(${incidentID},${hookID},${owned.projectID},${policyID},1,${"d".repeat(64)},${"e".repeat(64)},
        'Owned request','Retained request','blocked','Connected source needs authorization.')`;
    expect(
      (await service.list(managerID)).items.find((item) => item.id === `input:${incidentID}`),
    ).toMatchObject({ target: "inputs", needsAction: false, ticketId: null });
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `input:${incidentID}`),
    ).toBe(false);
    await database.client`UPDATE factory.monitoring_incident SET state='prepared' WHERE id=${incidentID}`;
    expect(
      (await service.list(managerID)).items.some((item) => item.id === `input:${incidentID}`),
    ).toBe(false);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 120_000);

test("a stored provider failure reaches the Inbox in plain words", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const service = createInboxService(database);
    await database.client`UPDATE factory.change SET state='failed',
      failure='rate_limit_exceeded: Your requests to gpt-5.6-terra in swedencentral have exceeded token rate limit.'
      WHERE id=${owned.changeID}`;
    const item = (await service.list(owned.userID)).items.find(
      (candidate) => candidate.id === `change:${owned.changeID}`,
    );
    expect(item?.preview).toContain("limiting requests");
    expect(item?.preview).not.toContain("rate_limit_exceeded");
  } finally {
    await database.client.end();
    await host.dispose();
  }
});

test("responsibility CAS, retries and history share the owned transaction, including rollback on a rejected event", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const service = createInboxService(database);
    const peer = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${peer},'Owned recipient',${`${peer}@inbox.test`},true)`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${owned.projectID},${peer},'developer',${owned.userID})`;
    const command = { commandId: crypto.randomUUID(), expectedVersion: 0, responsibleId: peer };
    const simultaneous = await Promise.all([
      service.responsibility(owned.userID, owned.ticketID, command),
      service.responsibility(owned.userID, owned.ticketID, command),
    ]);
    expect(simultaneous.map((view) => view.version)).toEqual([1, 1]);
    const history =
      await database.client`SELECT * FROM factory.ticket_responsibility_event ORDER BY id`;
    expect(history).toHaveLength(1);
    for (const changed of [
      { ...command, expectedVersion: 1 },
      { ...command, responsibleId: null },
    ])
      await expect(service.responsibility(owned.userID, owned.ticketID, changed)).rejects.toThrow(
        "identity changed",
      );
    await expect(service.responsibility(peer, owned.ticketID, command)).rejects.toThrow(
      "identity changed",
    );
    await expect(
      service.responsibility(owned.userID, owned.ticketID, {
        ...command,
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Responsibility changed");
    await service.follow(peer, owned.ticketID, false);

    // The failure occurs after the current responsibility write. It must roll back
    // that write and must not implicitly re-follow the recipient or retain an event.
    await database.client`CREATE FUNCTION factory.reject_owned_inbox_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned Inbox event rejected'; END $$`;
    await database.client`CREATE TRIGGER reject_owned_inbox_event BEFORE INSERT
      ON factory.ticket_responsibility_event FOR EACH ROW EXECUTE FUNCTION factory.reject_owned_inbox_event()`;
    await expect(
      service.responsibility(owned.userID, owned.ticketID, {
        commandId: crypto.randomUUID(),
        expectedVersion: 1,
        responsibleId: owned.userID,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "Owned Inbox event rejected" }),
    });
    expect(await service.ticket(peer, owned.ticketID)).toMatchObject({
      responsibleId: peer,
      version: 1,
      following: false,
    });
    expect(
      await database.client`SELECT * FROM factory.ticket_responsibility_event ORDER BY id`,
    ).toEqual(history);
    await database.client`DROP TRIGGER reject_owned_inbox_event ON factory.ticket_responsibility_event`;
    await database.client`DROP FUNCTION factory.reject_owned_inbox_event()`;
    const cleared = await service.responsibility(owned.userID, owned.ticketID, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      responsibleId: null,
    });
    expect(cleared).toMatchObject({ responsibleId: null, version: 2 });
    const replay = await service.responsibility(owned.userID, owned.ticketID, command);
    expect(replay).toMatchObject({ responsibleId: null, version: 2 });
    expect((await service.ticket(peer, owned.ticketID)).following).toBe(false);
    expect(
      await database.client`SELECT * FROM factory.ticket_responsibility_event WHERE id=${command.commandId}`,
    ).toEqual(history);
    expect(await database.client`SELECT id FROM factory.ticket_responsibility_event`).toHaveLength(
      2,
    );
    expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);

    await database.client`UPDATE factory.ticket SET trashed_at=now(),trashed_by=${owned.userID} WHERE id=${owned.ticketID}`;
    await expect(service.ticket(peer, owned.ticketID)).rejects.toThrow("Ticket not found");
    await expect(service.follow(peer, owned.ticketID, true)).rejects.toThrow("Ticket not found");
    await expect(service.responsibility(owned.userID, owned.ticketID, command)).rejects.toThrow(
      "Ticket not found",
    );
    expect((await service.list(peer)).items).toEqual([]);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 120_000);

test("Inbox groups exact conversation, Coding and review targets without exposing developer or private Project histories", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const service = createInboxService(database);
    const contributor = crypto.randomUUID(),
      peer = crypto.randomUUID(),
      admin = crypto.randomUUID();
    for (const [id, role] of [
      [contributor, "product-contributor"],
      [peer, "developer"],
      [admin, null],
    ] as const) {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},${role ?? "System manager"},${`${id}@inbox.test`},true)`;
      if (role)
        await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${owned.projectID},${id},${role},${owned.userID})`;
    }
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${admin})`;
    expect(
      (await service.people(admin, owned.projectID)).some((person) => person.id === admin),
    ).toBe(false);
    await expect(
      service.responsibility(admin, owned.ticketID, {
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        responsibleId: admin,
      }),
    ).rejects.toThrow("active member");
    await service.follow(contributor, owned.ticketID, false);
    await service.follow(peer, owned.ticketID, true);
    const conversationID = crypto.randomUUID(),
      contextA = crypto.randomUUID(),
      contextB = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
      VALUES(${conversationID},${owned.projectID},${owned.ticketID},${owned.userID})`;
    const add = (
      kind: "question" | "user-message",
      body: string,
      payload: Record<string, unknown>,
      id = conversationID,
    ) =>
      database.client.begin((sql) =>
        appendConversationEntry(sql, id, {
          kind,
          body,
          payload,
          actor: kind === "question" ? "project-agent" : "user",
          mode: "plan",
          citations: [],
          inReplyToEntryId: null,
          requirementRevisionId: null,
          ...(kind === "user-message" ? { createdBy: owned.userID } : {}),
        }),
      );
    const questionA = await add("question", "Question in A", { contextId: contextA });
    const questionB = await add("question", "Question in B", { contextId: contextB });
    const original = await add("question", "Original question", {});
    await add("user-message", "Research is independent of the pending answer", {
      intent: "project-research",
    });
    for (const question of [questionA, questionB, original])
      expect(
        (await service.list(peer)).items.find((item) => item.id === `question:${question.id}`),
      ).toMatchObject({
        eventId: question.id,
        target: "conversation",
        targetId: question.id,
        contextId:
          question.id === original.id ? null : question.id === questionA.id ? contextA : contextB,
        needsAction: true,
      });
    const replacementA = await add("question", "Current A question", { contextId: contextA });
    const questions = (await service.list(peer)).items.filter((item) => item.needsAction);
    expect(questions.some((item) => item.id === `question:${questionA.id}`)).toBe(false);
    expect(questions.map((item) => item.eventId).sort()).toEqual(
      [replacementA.id, questionB.id, original.id].sort(),
    );
    const token = mentionText({ id: contributor, name: "Contributor" });
    await add("user-message", `Hidden developer mention ${token}`, {
      contextId: contextB,
      visibility: "developer",
    });
    await add("user-message", `Literal mention \`${token}\``, { contextId: contextB });
    expect(
      (await service.list(contributor)).items.filter((item) => item.id.startsWith("conversation:")),
    ).toEqual([]);
    await add("user-message", `First public mention ${token}`, { contextId: contextA });
    const latest = await add("user-message", `Second public mention ${token}`, {
      contextId: contextA,
    });
    const activityID = `conversation:${conversationID}:${contextA}`;
    expect(
      (await service.list(contributor)).items.find((item) => item.id === activityID),
    ).toMatchObject({
      eventId: latest.id,
      targetId: latest.id,
      contextId: contextA,
      updates: 2,
      needsAction: false,
    });
    const beforeReceipt =
      await database.client`SELECT * FROM factory.conversation_entry ORDER BY id`;
    await service.receipt(contributor, {
      itemId: activityID,
      eventId: latest.id,
      action: "archive",
    });
    await service.receipt(contributor, {
      itemId: activityID,
      eventId: latest.id,
      action: "unread",
    });
    expect(
      (await service.list(contributor)).items.find((item) => item.id === activityID),
    ).toMatchObject({
      unread: true,
      archived: false,
    });
    expect((await service.list(peer)).items.find((item) => item.id === activityID)?.unread).toBe(
      true,
    );
    expect(await database.client`SELECT * FROM factory.conversation_entry ORDER BY id`).toEqual(
      beforeReceipt,
    );

    const first = await retainedCodingTurn(
      owned,
      "completed",
      contextA,
      `Coding mention ${token}`,
      new Date(1000),
    );
    const last = await retainedCodingTurn(
      owned,
      "completed",
      contextA,
      `Latest Coding mention ${token}`,
      new Date(2000),
    );
    const other = await retainedCodingTurn(
      owned,
      "completed",
      contextB,
      "Separate Coding context",
      new Date(3000),
    );
    const codingID = `coding:${owned.changeID}:${contextA}`;
    expect((await service.list(peer)).items.find((item) => item.id === codingID)).toMatchObject({
      eventId: last.id,
      target: "coding",
      targetId: last.promptID,
      contextId: contextA,
      updates: 2,
    });
    expect(
      (await service.list(peer)).items.find(
        (item) => item.id === `coding:${owned.changeID}:${contextB}`,
      ),
    ).toMatchObject({
      eventId: other.id,
      targetId: other.promptID,
      contextId: contextB,
      updates: 1,
    });
    expect(
      (await service.list(contributor)).items.some((item) => item.id.startsWith("coding:")),
    ).toBe(false);
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id.startsWith("coding:")),
    ).toBe(false);
    await service.receipt(peer, { itemId: codingID, eventId: last.id, action: "read" });
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE id IN (${first.id},${last.id},${other.id})`,
    ).toHaveLength(3);

    const feedbackID = crypto.randomUUID(),
      messageA = crypto.randomUUID(),
      messageB = crypto.randomUUID();
    await database.client`INSERT INTO factory.review_feedback(id,change_id,author_id,kind,state,commit_sha)
      VALUES(${feedbackID},${owned.changeID},${contributor},'thread','implemented',${"a".repeat(40)})`;
    await database.client`INSERT INTO factory.review_feedback_message(id,feedback_id,author_id,body,created_at)
      VALUES(${messageA},${feedbackID},${owned.userID},${`First feedback ${token}`},${new Date(1000).toISOString()}),
        (${messageB},${feedbackID},${owned.userID},${`Latest feedback ${token}`},${new Date(2000).toISOString()})`;
    expect(
      (await service.list(contributor)).items.find((item) => item.id === `feedback:${feedbackID}`),
    ).toMatchObject({
      eventId: messageB,
      target: "review",
      targetId: feedbackID,
      contextId: null,
      updates: 2,
    });
    await service.responsibility(owned.userID, owned.ticketID, {
      commandId: crypto.randomUUID(),
      expectedVersion: 0,
      responsibleId: contributor,
    });
    expect(
      (await service.list(contributor)).items.find((item) => item.id === `recheck:${feedbackID}`),
    ).toMatchObject({
      target: "review",
      targetId: feedbackID,
      eventId: `${feedbackID}:1`,
      needsAction: true,
    });
    expect(
      (await service.list(peer)).items.some((item) => item.id === `recheck:${feedbackID}`),
    ).toBe(false);

    const privateID = crypto.randomUUID(),
      privateTurn = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,created_by)
      VALUES(${privateID},${owned.projectID},${contributor})`;
    const privateQuestion = await add("question", "Private question", {}, privateID);
    await database.client`INSERT INTO factory.agent_turn(id,command_id,project_id,conversation_id,created_by,
      input,input_digest,authority,state)
      VALUES(${privateTurn},${crypto.randomUUID()},${owned.projectID},${privateID},${contributor},
        '{"kind":"project-message"}',${"a".repeat(64)},'{"mode":"plan"}','failed')`;
    for (const viewer of [peer, admin, owned.userID]) {
      const view = await service.list(viewer);
      expect(
        view.items.some(
          (item) => item.eventId === privateQuestion.id || item.eventId === privateTurn,
        ),
      ).toBe(false);
    }
    const privateItems = (await service.list(contributor)).items.filter(
      (item) => item.ticketId === null,
    );
    expect(privateItems.map((item) => item.eventId).sort()).toEqual(
      [privateQuestion.id, privateTurn].sort(),
    );
    const snapshot = await database.client`SELECT * FROM factory.agent_turn ORDER BY id`;
    await service.list(admin);
    await service.list(contributor);
    expect(await database.client`SELECT * FROM factory.agent_turn ORDER BY id`).toEqual(snapshot);
    await database.client`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${contributor}`;
    expect(
      (await service.people(peer, owned.projectID)).some((person) => person.id === contributor),
    ).toBe(false);
    expect(
      (await service.list(peer)).items.some((item) => item.id === `recheck:${feedbackID}`),
    ).toBe(true);
    await expect(service.list(contributor)).rejects.toThrow("disabled");
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 120_000);

test("technical-design and failed Coding attention follows current revisions, pauses and retained terminal history", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const service = createInboxService(database);
    const ticketID = crypto.randomUUID(),
      revisionID = crypto.randomUUID(),
      designID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${ticketID},${owned.projectID},'Owned design attention','ready',${owned.userID})`;
    await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
      SELECT ${revisionID},${ticketID},1,canonical_content,content_digest,created_by
      FROM factory.requirement_revision WHERE id=${owned.revisionID}`;
    const design = async (id: string, ordinal: number, basis: string, previous: string | null) => {
      const content = `Owned design ${ordinal}`;
      await database.client`INSERT INTO factory.technical_design_revision(id,ticket_id,requirement_revision_id,
        previous_revision_id,ordinal,source_commit,canonical_content,content_digest,renderer_version,created_by,author_kind)
        VALUES(${id},${ticketID},${basis},${previous},${ordinal},${"a".repeat(40)},${content},
          ${createHash("sha256").update(content).digest("hex")},'owned-inbox-test',${owned.userID},'human')`;
    };
    await design(designID, 1, revisionID, null);
    expect(
      (await service.list(owned.userID)).items.find((item) => item.id === `design:${designID}`),
    ).toMatchObject({
      eventId: designID,
      ticketId: ticketID,
      target: "ticket",
      targetId: null,
      contextId: null,
      needsAction: true,
    });
    const secondDesign = crypto.randomUUID();
    await design(secondDesign, 2, revisionID, designID);
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${designID}`),
    ).toBe(false);
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${secondDesign}`),
    ).toBe(true);
    const secondRevision = crypto.randomUUID();
    await database.client`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
      SELECT ${secondRevision},ticket_id,2,canonical_content,content_digest,created_by
      FROM factory.requirement_revision WHERE id=${revisionID}`;
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${secondDesign}`),
    ).toBe(false);
    const thirdDesign = crypto.randomUUID();
    await design(thirdDesign, 3, secondRevision, secondDesign);
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${thirdDesign}`),
    ).toBe(true);
    const conversationID = crypto.randomUUID(),
      planningID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
      VALUES(${conversationID},${owned.projectID},${ticketID},${owned.userID})`;
    await database.client`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,conversation_id,created_by,
      input,input_digest,authority,state)
      VALUES(${planningID},${crypto.randomUUID()},${owned.projectID},${ticketID},${conversationID},${owned.userID},
        '{"kind":"project-message","intent":"technical-planning"}',${"a".repeat(64)},'{"mode":"plan"}','pending')`;
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${thirdDesign}`),
    ).toBe(false);
    await database.client`UPDATE factory.agent_turn SET state='stopped' WHERE id=${planningID}`;
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${thirdDesign}`),
    ).toBe(true);
    await database.client`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,
      technical_design_revision_id,approved_by)
      VALUES(${crypto.randomUUID()},${ticketID},${secondRevision},${thirdDesign},${owned.userID})`;
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `design:${thirdDesign}`),
    ).toBe(false);
    expect(
      await database.client`SELECT id FROM factory.technical_design_revision WHERE ticket_id=${ticketID}`,
    ).toHaveLength(3);

    const context = crypto.randomUUID();
    const failure = await retainedCodingTurn(
      owned,
      "failed",
      context,
      "Owned failed Coding input",
      new Date(1000),
    );
    expect(
      (await service.list(owned.userID)).items.find((item) => item.id === `turn:${failure.id}`),
    ).toMatchObject({
      eventId: failure.id,
      target: "conversation",
      targetId: null,
      contextId: context,
      needsAction: true,
    });
    const history = await database.client`SELECT * FROM factory.agent_turn WHERE id=${failure.id}`;
    await database.client`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${failure.id},'coding-budget-used')`;
    const paused = await service.list(owned.userID);
    expect(paused.items.some((item) => item.id === `turn:${failure.id}`)).toBe(false);
    expect(paused.items.find((item) => item.id === `pause:${failure.id}`)).toMatchObject({
      eventId: failure.id,
      target: "ticket",
      targetId: null,
      contextId: null,
      needsAction: true,
    });
    await database.client`UPDATE factory.ticket SET state='done' WHERE id=${owned.ticketID}`;
    expect(
      (await service.list(owned.userID)).items.some(
        (item) => item.needsAction && item.ticketId === owned.ticketID,
      ),
    ).toBe(false);
    await database.client`UPDATE factory.ticket SET state='inbox' WHERE id=${owned.ticketID}`;
    const replacement = await retainedCodingTurn(
      owned,
      "completed",
      context,
      "Owned replacement",
      new Date(2000),
    );
    expect(
      (await service.list(owned.userID)).items.some(
        (item) => item.id === `pause:${failure.id}` || item.id === `turn:${failure.id}`,
      ),
    ).toBe(false);
    await database.client`UPDATE factory.coding_pause SET resumed_by_turn_id=${replacement.id} WHERE turn_id=${failure.id}`;
    expect(await database.client`SELECT * FROM factory.agent_turn WHERE id=${failure.id}`).toEqual(
      history,
    );
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 120_000);

test("review, Verification and editing requests retain exact candidate and writer-epoch selection", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await candidateReviewFixture(undefined, database);
    const service = createInboxService(database);
    const peer = crypto.randomUUID(),
      contributor = crypto.randomUUID();
    for (const [id, role] of [
      [peer, "developer"],
      [contributor, "product-contributor"],
    ] as const) {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},${role},${`${id}@inbox.test`},true)`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
        VALUES(${owned.projectID},${id},${role},${owned.userID})`;
    }
    await database.client`UPDATE factory.candidate_review SET state='incomplete',
      result='{"summary":"Owned incomplete review"}',completed_at=now() WHERE id=${owned.reviewID}`;
    const reviewID = `review:${owned.reviewID}`,
      checkID = `verification:${owned.verificationID}`;
    expect(
      (await service.list(contributor)).items.find((item) => item.id === reviewID),
    ).toMatchObject({
      eventId: owned.reviewID,
      target: "ticket",
      preview: "Owned incomplete review",
      needsAction: true,
    });
    await database.client`UPDATE factory.verification SET state='failed',summary='Owned failed Verification',
      repair_prompted_at=now() WHERE id=${owned.verificationID}`;
    expect((await service.list(peer)).items.find((item) => item.id === checkID)).toMatchObject({
      eventId: owned.verificationID,
      target: "ticket",
      preview: "Owned failed Verification",
      needsAction: true,
    });
    expect((await service.list(contributor)).items.some((item) => item.id === checkID)).toBe(false);
    const reviewHistory =
      await database.client`SELECT * FROM factory.candidate_review WHERE id=${owned.reviewID}`;
    const newerReview = crypto.randomUUID();
    await database.client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,
      created_by,ordinal,supersedes_id,state)
      VALUES(${newerReview},${owned.verificationID},${owned.changeID},${owned.commit},${"a".repeat(40)},
        ${owned.userID},2,${owned.reviewID},'incomplete')`;
    const reviews = await service.list(peer);
    expect(reviews.items.some((item) => item.id === reviewID)).toBe(false);
    expect(reviews.items.some((item) => item.id === `review:${newerReview}`)).toBe(true);
    const newerCheck = crypto.randomUUID();
    await database.client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,
      created_by,state,created_at)
      VALUES(${newerCheck},${owned.changeID},${"e".repeat(40)},1,'owned-inbox-check',${owned.userID},'pending',${new Date(Date.now() + 1000).toISOString()})`;
    expect((await service.list(peer)).items.some((item) => item.id === checkID)).toBe(false);
    await database.client`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,
      branch_name,expected_parent_sha,commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
      SELECT ${crypto.randomUUID()},change_id,runtime_attempt_id,2,branch_name,commit_sha,${"e".repeat(40)},
        ${"e".repeat(40)},'Owned successor candidate',${crypto.randomUUID()},'succeeded',created_by,now()
      FROM factory.change_commit_operation WHERE change_id=${owned.changeID} AND sequence=1`;
    expect(
      (await service.list(peer)).items.some((item) => item.id === `review:${newerReview}`),
    ).toBe(false);
    expect(
      await database.client`SELECT * FROM factory.candidate_review WHERE id=${owned.reviewID}`,
    ).toEqual(reviewHistory);

    await database.client`UPDATE factory.change_writer SET state='human',user_id=${owned.userID},turn_id=NULL
      WHERE change_id=${owned.changeID}`;
    const requestID = crypto.randomUUID();
    await database.client`INSERT INTO factory.change_editing_request(id,change_id,requester_id,owner_id,writer_epoch)
      SELECT ${requestID},change_id,${peer},user_id,epoch FROM factory.change_writer WHERE change_id=${owned.changeID}`;
    expect(
      (await service.list(owned.userID)).items.find((item) => item.id === `editing:${requestID}`),
    ).toMatchObject({
      eventId: requestID,
      target: "ticket",
      targetId: null,
      contextId: null,
      needsAction: true,
    });
    expect(
      (await service.list(peer)).items.some((item) => item.id === `editing:${requestID}`),
    ).toBe(false);
    await database.client`UPDATE factory.change_writer SET epoch=epoch+1 WHERE change_id=${owned.changeID}`;
    expect(
      (await service.list(owned.userID)).items.some((item) => item.id === `editing:${requestID}`),
    ).toBe(false);
    const [retainedRequest] = await database.client<{ state: string }[]>`
      SELECT state FROM factory.change_editing_request WHERE id=${requestID}`;
    expect(retainedRequest?.state).toBe("requested");
    const currentRequest = crypto.randomUUID();
    await database.client`INSERT INTO factory.change_editing_request(id,change_id,requester_id,owner_id,writer_epoch)
      SELECT ${currentRequest},change_id,${peer},user_id,epoch FROM factory.change_writer WHERE change_id=${owned.changeID}`;
    expect(
      (await service.list(owned.userID)).items.some(
        (item) => item.id === `editing:${currentRequest}`,
      ),
    ).toBe(true);
    await database.client`UPDATE factory.change_editing_request SET state='accepted',decided_by=${owned.userID},decided_at=now()
      WHERE id=${currentRequest}`;
    expect(
      (await service.list(owned.userID)).items.some(
        (item) => item.id === `editing:${currentRequest}`,
      ),
    ).toBe(false);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 120_000);
