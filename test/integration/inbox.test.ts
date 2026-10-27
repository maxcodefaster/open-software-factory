import { expect, test } from "bun:test";
import { createInboxService } from "../../apps/factory/src/inbox/service";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { mentionText } from "../../packages/ticket-domain/src/attention";
import { factoryProcess } from "../fixtures/factory-process";
import { fixture } from "../fixtures/change-agent-turns";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { fixtureValue } from "../fixtures/value";

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
