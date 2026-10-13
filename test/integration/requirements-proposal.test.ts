import { expect, test } from "bun:test";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { persistProjectOutput } from "../../apps/factory/src/project-agent/effects";
import { admittedTicketContext } from "../../apps/factory/src/project-agent/ticket-context";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import type { AgentTurnRecord } from "../../apps/factory/src/agent/turn-store";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("Requirements output stages a proposal; confirmation is atomic, exact and retry-safe", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const ticketID = crypto.randomUUID();
    const conversationID = crypto.randomUUID();
    const commandID = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES (${ticketID},${owned.projectID},'Original title','Human intent','ready',${owned.userID})`;
    await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
      VALUES (${conversationID},${owned.projectID},${ticketID},'plan',${owned.userID})`;
    const turn: AgentTurnRecord = {
      id: crypto.randomUUID(),
      commandId: commandID,
      state: "running",
      ownerToken: null,
      ownerExpiresAt: null,
      outcomeSummary: null,
      command: {
        kind: "project-message",
        commandId: commandID,
        conversationId: conversationID,
        projectId: owned.projectID,
        ticketId: ticketID,
        createdBy: owned.userID,
        text: "Elaborate this Ticket",
        intent: "requirements-interview",
      },
      authority: {
        mode: "plan",
        modelId: "owned-model",
        conversationVersion: 1,
        skillRevisionIds: [],
      },
    };
    const output = {
      kind: "requirement" as const,
      message: "Requirements are ready for confirmation.",
      ticket: {
        title: "Clear intended outcome",
        description: "Readable for product and developers",
      },
      requirement: {
        summary: "A specific outcome",
        acceptanceCriteria: ["A user can observe the outcome"],
        nonGoals: [],
      },
      citations: [],
    };
    await db.client.begin(async (sql) => {
      const ticketContext = await admittedTicketContext(sql, owned.projectID, ticketID);
      await appendConversationEntry(sql, conversationID, {
        kind: "user-message",
        actor: "user",
        mode: "plan",
        body: turn.command.kind === "project-message" ? turn.command.text : "",
        payload: { commandId: commandID, ticketContext },
        citations: [],
        inReplyToEntryId: null,
        requirementRevisionId: null,
      });
      await persistProjectOutput(sql, turn, output);
    });
    const [before] = await db.client<
      Array<{ title: string; description: string; state: string; revisions: number }>
    >`
      SELECT title,description,state,(SELECT count(*)::int FROM factory.requirement_revision WHERE ticket_id=${ticketID}) AS revisions
      FROM factory.ticket WHERE id=${ticketID}`;
    expect(before).toEqual({
      title: "Original title",
      description: "Human intent",
      state: "ready",
      revisions: 0,
    });
    const [proposal] = await db.client<Array<{ id: string }>>`
      SELECT id FROM factory.conversation_entry WHERE conversation_id=${conversationID} AND kind='requirement'`;
    if (!proposal) throw new Error("Missing staged proposal");
    const documents = createTicketDocumentController(db);
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      proposalEntryId: proposal.id,
      ...output.ticket,
      requirement: output.requirement,
    };
    await expect(
      documents.save(ticketID, owned.userID, { ...input, title: "Tampered" }),
    ).rejects.toThrow("without replacing");
    await documents.save(ticketID, owned.userID, input);
    await documents.save(ticketID, owned.userID, input);
    const [accepted] = await db.client<
      Array<{
        title: string;
        state: string;
        revisions: number;
        documents: number;
        authorKind: string;
      }>
    >`
      SELECT ticket.title,ticket.state,(SELECT count(*)::int FROM factory.requirement_revision WHERE ticket_id=${ticketID}) AS revisions,
        (SELECT count(*)::int FROM factory.ticket_document_revision WHERE ticket_id=${ticketID}) AS documents,document.author_kind AS "authorKind"
      FROM factory.ticket ticket JOIN factory.ticket_document_revision document ON document.ticket_id=ticket.id WHERE ticket.id=${ticketID}`;
    expect(accepted).toEqual({
      title: output.ticket.title,
      state: "ready",
      revisions: 1,
      documents: 1,
      authorKind: "ai",
    });
    // Description-only refinement must not create the same content-addressed requirement twice.
    const refinement = {
      ...input,
      proposalEntryId: undefined,
      commandId: crypto.randomUUID(),
      expectedVersion: 2,
      expectedDocumentId: input.commandId,
      requirementRevisionId: input.commandId,
      description: "Human refinement",
    };
    await documents.save(ticketID, owned.userID, refinement);
    const [refined] = await db.client<Array<{ documents: number; requirements: number }>>`
      SELECT (SELECT count(*)::int FROM factory.ticket_document_revision WHERE ticket_id=${ticketID}) AS documents,
        (SELECT count(*)::int FROM factory.requirement_revision WHERE ticket_id=${ticketID}) AS requirements`;
    expect(refined).toEqual({ documents: 2, requirements: 1 });
    await expect(
      documents.save(ticketID, owned.userID, {
        ...input,
        commandId: crypto.randomUUID(),
        expectedVersion: 2,
        expectedDocumentId: input.commandId,
        requirementRevisionId: input.commandId,
      }),
    ).rejects.toThrow("changed elsewhere");
    const changed = {
      ...refinement,
      commandId: crypto.randomUUID(),
      expectedVersion: 3,
      expectedDocumentId: refinement.commandId,
      requirement: { ...output.requirement, summary: "Another scope" },
    };
    await documents.save(ticketID, owned.userID, changed);
    const restored = {
      ...changed,
      commandId: crypto.randomUUID(),
      expectedVersion: 4,
      expectedDocumentId: changed.commandId,
      requirementRevisionId: changed.commandId,
      requirement: output.requirement,
    };
    await documents.save(ticketID, owned.userID, restored);
    expect(
      (await db.client`SELECT id FROM factory.requirement_revision WHERE ticket_id=${ticketID}`)
        .length,
    ).toBe(3);
    const [counts] = await db.client<Array<{ changes: number; approvals: number }>>`
      SELECT (SELECT count(*)::int FROM factory.change WHERE ticket_id=${ticketID}) AS changes,
        (SELECT count(*)::int FROM factory.requirement_approval WHERE ticket_id=${ticketID}) AS approvals`;
    expect(counts).toEqual({ changes: 0, approvals: 0 });
    // Clearing a criterion retains incomplete human work, never an implementable stale spec.
    const partial = {
      ...refinement,
      commandId: crypto.randomUUID(),
      expectedVersion: 5,
      expectedDocumentId: restored.commandId,
      requirementRevisionId: restored.commandId,
      requirement: { ...output.requirement, acceptanceCriteria: [] },
    };
    await documents.save(ticketID, owned.userID, partial);
    const [incomplete] = await db.client<Array<{ revision: string | null }>>`
      SELECT requirement_revision_id AS revision FROM factory.ticket_document_revision WHERE id=${partial.commandId}`;
    expect(incomplete?.revision).toBeNull();
    const writes = await Promise.allSettled(
      ["Human A", "Human B"].map((title) =>
        documents.save(ticketID, owned.userID, {
          ...partial,
          commandId: crypto.randomUUID(),
          expectedVersion: 6,
          expectedDocumentId: partial.commandId,
          title,
        }),
      ),
    );
    expect(writes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((value) => value.status === "rejected")).toHaveLength(1);
    const stranger = crypto.randomUUID();
    await db.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${stranger},'Stranger',${`stranger-${stranger}@example.invalid`},true)`;
    await expect(
      documents.save(ticketID, stranger, { ...partial, commandId: crypto.randomUUID() }),
    ).rejects.toThrow("not found");
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60_000);

test("preimplementation manual document saves retain partial intent and never invoke an Agent", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const ticketID = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES (${ticketID},${owned.projectID},'An idea',${owned.userID})`;
    const documents = createTicketDocumentController(db);
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "An edited idea",
      description: "Human text",
      requirement: null,
    };
    await documents.save(ticketID, owned.userID, input);
    await documents.save(ticketID, owned.userID, input);
    await expect(
      documents.save(ticketID, owned.userID, { ...input, commandId: crypto.randomUUID() }),
    ).rejects.toThrow("changed elsewhere");
    const [result] = await db.client<
      Array<{ title: string; documents: number; requirements: number; turns: number }>
    >`
      SELECT title,(SELECT count(*)::int FROM factory.ticket_document_revision WHERE ticket_id=${ticketID}) AS documents,
        (SELECT count(*)::int FROM factory.requirement_revision WHERE ticket_id=${ticketID}) AS requirements,
        (SELECT count(*)::int FROM factory.agent_turn WHERE ticket_id=${ticketID}) AS turns FROM factory.ticket WHERE id=${ticketID}`;
    expect(result).toEqual({ title: input.title, documents: 1, requirements: 0, turns: 0 });
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60_000);
