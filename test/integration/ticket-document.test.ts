import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { fixture, buildModelID } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("post-start human edits are immutable documents, never new Build scope or inference", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const documents = createTicketDocumentController(db);
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: owned.revisionID,
      title: "Reworded ticket",
      description: "Readable human context",
      requirement: {
        summary: "A human edit after implementation",
        acceptanceCriteria: ["A clearer description"],
        nonGoals: ["Do not automatically build"],
      },
    };
    await documents.save(owned.ticketID, owned.userID, input);
    await documents.save(owned.ticketID, owned.userID, input);
    const [counts] = await db.client<
      Array<{
        documents: number;
        requirements: number;
        turns: number;
        revisionID: string;
        title: string;
      }>
    >`
      SELECT (SELECT count(*)::integer FROM factory.ticket_document_revision WHERE ticket_id = ${owned.ticketID}) AS documents,
        (SELECT count(*)::integer FROM factory.requirement_revision WHERE ticket_id = ${owned.ticketID}) AS requirements,
        (SELECT count(*)::integer FROM factory.agent_turn WHERE ticket_id = ${owned.ticketID}) AS turns,
        approval.requirement_revision_id AS "revisionID", ticket.title
      FROM factory.ticket ticket JOIN factory.requirement_approval approval ON approval.ticket_id = ticket.id WHERE ticket.id = ${owned.ticketID}`;
    expect(counts).toEqual({
      documents: 1,
      requirements: 1,
      turns: 0,
      revisionID: owned.revisionID,
      title: input.title,
    });
    await expect(
      documents.save(owned.ticketID, owned.userID, { ...input, commandId: crypto.randomUUID() }),
    ).rejects.toThrow("changed elsewhere");
    await expect(
      documents.save(owned.ticketID, owned.userID, { ...input, title: "Command collision" }),
    ).rejects.toThrow("another document");
    await expect(
      (async () => {
        await db.client`UPDATE factory.ticket_document_revision SET title = 'changed' WHERE id = ${input.commandId}`;
      })(),
    ).rejects.toThrow("immutable");
    await expect(
      (async () => {
        await db.client`DELETE FROM factory.ticket_document_revision WHERE id = ${input.commandId}`;
      })(),
    ).rejects.toThrow("immutable");
    const strangerID = crypto.randomUUID();
    await db.client`INSERT INTO auth."user"(id, name, email) VALUES (${strangerID}, 'Not a member', ${`${strangerID}@factory.local`})`;
    await expect(documents.save(owned.ticketID, strangerID, input)).rejects.toThrow(
      "Project not found",
    );
    await db.client`UPDATE factory.ticket SET state = 'done' WHERE id = ${owned.ticketID}`;
    await documents.save(owned.ticketID, owned.userID, {
      ...input,
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      expectedDocumentId: input.commandId,
      title: "Delivered wording",
    });
    const admission = createChangeAdmission(db, buildModelID);
    const turn = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Correct only within the original scope",
    });
    const [recorded] = await db.client<
      Array<{ revisionID: string }>
    >`SELECT authority->>'requirementRevisionId' AS "revisionID" FROM factory.agent_turn WHERE id = ${turn.turn.id}`;
    expect(recorded?.revisionID).toBe(owned.revisionID);
    // A real new Requirements scope must still invalidate the old approval.
    const canonical = canonicalRequirementContent({
      summary: "Unapproved scope",
      acceptanceCriteria: ["Additional work"],
      nonGoals: [],
    });
    await db.client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
      VALUES (${crypto.randomUUID()}, ${owned.ticketID}, 2, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${owned.userID})`;
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Old scope",
      }),
    ).rejects.toThrow("latest approved");
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60_000);

test("delivered follow-up is linked, retry-safe and unapproved; it never reuses delivered Build", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const documents = createTicketDocumentController(db);
    const input = {
      commandId: crypto.randomUUID(),
      expectedDocumentId: null,
      requirementRevisionId: owned.revisionID,
    };
    await expect(documents.followUp(owned.ticketID, owned.userID, input)).rejects.toThrow(
      "delivered",
    );
    await db.client`UPDATE factory.change SET state = 'delivered' WHERE id = ${owned.changeID}`;
    const first = await documents.followUp(owned.ticketID, owned.userID, input);
    expect(await documents.followUp(owned.ticketID, owned.userID, input)).toEqual(first);
    const [result] = await db.client<
      Array<{
        sourceID: string;
        projectID: string;
        approved: number;
        changes: number;
        revisions: number;
      }>
    >`
      SELECT follow.source_ticket_id AS "sourceID", ticket.project_id AS "projectID",
        (SELECT count(*)::integer FROM factory.requirement_approval WHERE ticket_id = ticket.id) AS approved,
        (SELECT count(*)::integer FROM factory.change WHERE ticket_id = ticket.id) AS changes,
        (SELECT count(*)::integer FROM factory.requirement_revision WHERE ticket_id = ticket.id) AS revisions
      FROM factory.ticket ticket JOIN factory.ticket_follow_up follow ON follow.ticket_id = ticket.id WHERE ticket.id = ${first.ticketId}`;
    expect(result).toEqual({
      sourceID: owned.ticketID,
      projectID: owned.projectID,
      approved: 0,
      changes: 0,
      revisions: 1,
    });
    await expect(
      documents.followUp(owned.ticketID, owned.userID, {
        ...input,
        expectedDocumentId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("different work");
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60_000);
