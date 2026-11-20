import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { drizzleTransaction } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import {
  createPlanningTicketIn,
  insertInitialTicketIn,
} from "../../packages/ticket-authoring/src/authoring";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("initial Ticket authoring uses the caller transaction and keeps planning replay checks", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const input = {
      id: crypto.randomUUID(),
      projectId: owned.projectID,
      title: "Initial authoring",
      description: "Save requirements without starting work.",
      state: "ready" as const,
    };
    const authoring = {
      requirement: {
        id: crypto.randomUUID(),
        canonicalContent: canonicalRequirementContent({
          summary: input.description,
          acceptanceCriteria: ["The text is retained."],
          nonGoals: [],
        }),
      },
      document: {
        id: crypto.randomUUID(),
        inputDigest: "a".repeat(64),
        authorKind: "ai" as const,
      },
    };
    await expect(
      database.client.begin(async (sql) => {
        await insertInitialTicketIn(drizzleTransaction(sql), {
          ...input,
          createdBy: owned.userID,
          authoring,
        });
        throw new Error("Caller rejected publication");
      }),
    ).rejects.toThrow("Caller rejected publication");
    for (const rows of [
      await database.client`SELECT id FROM factory.ticket WHERE id=${input.id}`,
      await database.client`SELECT id FROM factory.requirement_revision WHERE id=${authoring.requirement.id}`,
      await database.client`SELECT id FROM factory.ticket_document_revision WHERE id=${authoring.document.id}`,
    ])
      expect(rows).toHaveLength(0);

    const create = (value = input, userID = owned.userID) =>
      database.client.begin((sql) =>
        createPlanningTicketIn(drizzleTransaction(sql), userID, value),
      );
    const [first, second] = await Promise.all([create(), create()]);
    expect(first).toEqual(second);
    expect(first).toEqual({
      id: input.id,
      projectId: owned.projectID,
      title: input.title,
      state: "ready",
    });
    await expect(create({ ...input, title: "Conflicting intent" })).rejects.toThrow(
      "different content",
    );
    await expect(create(input, crypto.randomUUID())).rejects.toThrow("Project not found");
    await expect(
      database.client.begin((sql) =>
        insertInitialTicketIn(drizzleTransaction(sql), {
          ...input,
          createdBy: owned.userID,
          authoring,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(
      await database.client`SELECT id FROM factory.requirement_revision WHERE ticket_id=${input.id}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.ticket_document_revision WHERE ticket_id=${input.id}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${input.id}`,
    ).toHaveLength(0);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);

test("complete manual requirements move an Idea without approval or inference", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const ticketID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES(${ticketID},${owned.projectID},'Inline requirements','Existing product intent.','inbox',${owned.userID})`;
    const documents = createTicketDocumentController(database);
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Inline requirements",
      description: "Existing product intent.",
      requirement: { summary: "Existing product intent.", acceptanceCriteria: [], nonGoals: [] },
    };
    const partial = await documents.save(ticketID, owned.userID, input);
    const [idea] = await database.client<
      { state: string }[]
    >`SELECT state FROM factory.ticket WHERE id=${ticketID}`;
    expect(idea?.state).toBe("inbox");
    const complete = await documents.save(ticketID, owned.userID, {
      ...input,
      commandId: crypto.randomUUID(),
      expectedVersion: partial.ticketVersion,
      expectedDocumentId: partial.id,
      requirementRevisionId: partial.requirementRevisionId,
      requirement: {
        ...input.requirement,
        acceptanceCriteria: ["The user can edit requirements in place."],
      },
    });
    expect(complete.requirementRevisionId).toBe(complete.id);
    const [ready] = await database.client<
      { state: string }[]
    >`SELECT state FROM factory.ticket WHERE id=${ticketID}`;
    expect(ready?.state).toBe("ready");
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);

test("partial manual drafts acknowledge the next write base without making incomplete requirements implementable", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const ticketID = crypto.randomUUID();
    await database.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
      VALUES(${ticketID},${owned.projectID},'Manual draft','A manual specification.','ready',${owned.userID})`;
    const documents = createTicketDocumentController(database);
    const firstInput = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Manual draft",
      description: "A manual specification.",
      requirement: {
        summary: "A manual specification.",
        acceptanceCriteria: ["The checklist counts checked items."],
        nonGoals: [],
      },
    };
    const first = await documents.save(ticketID, owned.userID, firstInput);
    const partialInput = {
      ...firstInput,
      commandId: crypto.randomUUID(),
      expectedVersion: first.ticketVersion,
      expectedDocumentId: first.id,
      requirementRevisionId: first.requirementRevisionId,
      requirement: { ...firstInput.requirement, acceptanceCriteria: [] },
    };
    const partial = await documents.save(ticketID, owned.userID, partialInput);
    expect(partial).toEqual({
      id: partialInput.commandId,
      ticketVersion: 3,
      requirementRevisionId: first.id,
    });
    const [document] = await database.client<{ revisionID: string | null }[]>`
      SELECT requirement_revision_id AS "revisionID" FROM factory.ticket_document_revision WHERE id=${partial.id}`;
    expect(document?.revisionID).toBeNull();
    const final = await documents.save(ticketID, owned.userID, {
      ...firstInput,
      commandId: crypto.randomUUID(),
      expectedVersion: partial.ticketVersion,
      expectedDocumentId: partial.id,
      requirementRevisionId: partial.requirementRevisionId,
      requirement: {
        ...firstInput.requirement,
        acceptanceCriteria: ["The checklist counts checked items and Reset clears it."],
      },
    });
    expect(final.ticketVersion).toBe(4);
    expect(final.requirementRevisionId).toBe(final.id);
    expect(await documents.save(ticketID, owned.userID, partialInput)).toEqual(partial);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
  } finally {
    await database.client.end();
    await host.dispose();
  }
}, 60_000);

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
    const saved = await documents.save(owned.ticketID, owned.userID, input);
    expect(saved).toEqual({
      id: input.commandId,
      ticketVersion: 2,
      requirementRevisionId: owned.revisionID,
    });
    expect(await documents.save(owned.ticketID, owned.userID, input)).toEqual(saved);
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
    // An uncertain acknowledgement must retain its own base even after another
    // editor has saved. It must not authorize overwriting that later version.
    expect(await documents.save(owned.ticketID, owned.userID, input)).toEqual(saved);
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

test.each([false, true])(
  "delivered follow-up is linked, retry-safe and unapproved with document=%s",
  async (withDocument) => {
    const process = await factoryProcess();
    const db = process.connect();
    try {
      const owned = await fixture(undefined, undefined, db);
      const documents = createTicketDocumentController(db);
      const revised = {
        summary: "Saved follow-up intent",
        acceptanceCriteria: ["Retain the revised document, not the delivered scope."],
        nonGoals: ["Do not restart the delivered Build."],
      };
      const document = withDocument
        ? await documents.save(owned.ticketID, owned.userID, {
            commandId: crypto.randomUUID(),
            expectedVersion: 1,
            expectedDocumentId: null,
            requirementRevisionId: owned.revisionID,
            title: "Revised wording",
            description: "Saved document for subsequent work.",
            requirement: revised,
          })
        : null;
      const input = {
        commandId: crypto.randomUUID(),
        expectedDocumentId: document?.id ?? null,
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
          documents: number;
          title: string;
          description: string;
          canonical: string;
          digest: string;
          ordinal: number;
          createdBy: string;
          sourceDocumentID: string | null;
          sourceRevisionID: string;
        }>
      >`
      SELECT follow.source_ticket_id AS "sourceID", ticket.project_id AS "projectID",
        follow.source_document_id AS "sourceDocumentID",follow.source_revision_id AS "sourceRevisionID",
        ticket.title,ticket.description,revision.canonical_content AS canonical,revision.content_digest AS digest,
        revision.ordinal,revision.created_by AS "createdBy",
        (SELECT count(*)::integer FROM factory.requirement_approval WHERE ticket_id = ticket.id) AS approved,
        (SELECT count(*)::integer FROM factory.change WHERE ticket_id = ticket.id) AS changes,
        (SELECT count(*)::integer FROM factory.requirement_revision WHERE ticket_id = ticket.id) AS revisions,
        (SELECT count(*)::integer FROM factory.ticket_document_revision WHERE ticket_id = ticket.id) AS documents
      FROM factory.ticket ticket JOIN factory.ticket_follow_up follow ON follow.ticket_id = ticket.id
      JOIN factory.requirement_revision revision ON revision.ticket_id=ticket.id WHERE ticket.id = ${first.ticketId}`;
      const [original] = await db.client<{ canonical: string }[]>`
      SELECT canonical_content AS canonical FROM factory.requirement_revision WHERE id=${owned.revisionID}`;
      if (!original) throw new Error("Owned original Requirements are missing");
      const canonical = withDocument ? canonicalRequirementContent(revised) : original.canonical;
      expect(result).toEqual({
        sourceID: owned.ticketID,
        projectID: owned.projectID,
        sourceDocumentID: document?.id ?? null,
        sourceRevisionID: owned.revisionID,
        title: withDocument ? "Follow-up: Revised wording" : "Follow-up: Owned Build regression",
        description: withDocument ? "Saved document for subsequent work." : "",
        canonical,
        digest: createHash("sha256").update(canonical).digest("hex"),
        ordinal: 1,
        createdBy: owned.userID,
        approved: 0,
        changes: 0,
        revisions: 1,
        documents: 0,
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
  },
  60_000,
);
