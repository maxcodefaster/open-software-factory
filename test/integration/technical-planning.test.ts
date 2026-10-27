import { expect, test } from "bun:test";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createTicketService } from "../../apps/factory/src/change/service";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { persistProjectOutput } from "../../apps/factory/src/project-agent/effects";
import { admittedTicketContext } from "../../apps/factory/src/project-agent/ticket-context";
import { renderArchitectureDiagrams } from "../../apps/factory/src/technical-design/diagrams";
import {
  saveTechnicalDesignIn,
  technicalPlanningOutstandingIn,
} from "../../apps/factory/src/technical-design/store";
import type { AgentTurnRecord } from "../../apps/factory/src/agent/turn-store";
import { planningDesign, planningProduct } from "../fixtures/technical-planning";
import { technicalPlanningBaseInput } from "../../packages/requirement-domain/src/technical-design";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { fixtureValue } from "../fixtures/value";

test("technical revisions are exact, immutable, retry-safe and developer-only", async () => {
  const host = await factoryProcess();
  const db = host.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const ticketID = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${ticketID},${owned.projectID},'Export invoices','ready',${owned.userID})`;
    const documents = createTicketDocumentController(db);
    const product = await documents.save(ticketID, owned.userID, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Export invoices",
      description: "",
      requirement: planningProduct,
    });
    const id = crypto.randomUUID();
    const base = {
      requirementRevisionId: fixtureValue(
        product.requirementRevisionId,
        "product.requirementRevisionId",
      ),
      documentId: product.id,
      previousDesignId: null,
      sourceCommit: "a".repeat(40),
    };
    const renders = await renderArchitectureDiagrams(planningDesign);
    const input = {
      id,
      ticketID,
      userID: owned.userID,
      base,
      content: planningDesign,
      citations: [
        {
          source: "code" as const,
          id: owned.projectID,
          label: "Inspected invoices",
          path: "src/invoices.ts",
          commitSha: base.sourceCommit,
        },
      ],
      renders,
    };
    await db.client.begin((sql) => saveTechnicalDesignIn(sql, input));
    await db.client.begin((sql) => saveTechnicalDesignIn(sql, input));
    expect(
      await db.client`SELECT id FROM factory.technical_design_revision WHERE ticket_id=${ticketID}`,
    ).toHaveLength(1);
    await expect(
      (async () => {
        await db.client`UPDATE factory.technical_design_revision SET source_commit=${"b".repeat(40)} WHERE id=${id}`;
      })(),
    ).rejects.toThrow();
    const unused = async () => {
      throw new Error("This read-only proof starts no Build.");
    };
    const service = createTicketService({
      database: db,
      access: createAccessController(db),
      documents,
      trash: { trash: unused, restore: unused },
      changes: { start: unused, approve: unused, createRevision: unused },
      agent: { admitStartIn: unused },
    });
    const detail = await service.detail(owned.userID, ticketID);
    expect(detail.technicalDesigns?.[0]?.content).toEqual(planningDesign);
    expect(detail.technicalDesigns?.[0]?.diagramRenders[0]).toContain("<svg");
    await db.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const contributor = await service.detail(owned.userID, ticketID);
    expect(contributor.technicalDesignPresent).toBe(true);
    expect(contributor.technicalDesigns).toEqual([]);
    await expect(
      service.saveTechnicalDesign(owned.userID, ticketID, {
        commandId: crypto.randomUUID(),
        expectedRevisionId: id,
        content: planningDesign,
      }),
    ).rejects.toThrow();
    await db.client`UPDATE factory.project_membership SET role='developer'
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const changed = await documents.save(ticketID, owned.userID, {
      commandId: crypto.randomUUID(),
      expectedVersion: product.ticketVersion,
      expectedDocumentId: product.id,
      requirementRevisionId: product.requirementRevisionId,
      title: "Export invoices",
      description: "",
      requirement: { ...planningProduct, summary: "A different product scope" },
    });
    expect(changed.requirementRevisionId).not.toBe(product.requirementRevisionId);
    await expect(
      db.client.begin((sql) =>
        saveTechnicalDesignIn(sql, {
          ...input,
          id: crypto.randomUUID(),
          base: { ...base, previousDesignId: id },
        }),
      ),
    ).rejects.toThrow("Ticket changed");
    expect(
      await db.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
  } finally {
    await db.client.end();
    await host.dispose();
  }
}, 60_000);

test("full Planning confirmation durably admits exactly one technical task against the pinned source", async () => {
  const host = await factoryProcess();
  const db = host.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const ticketID = crypto.randomUUID(),
      conversationID = crypto.randomUUID(),
      commandID = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${ticketID},${owned.projectID},'Export invoices','ready',${owned.userID})`;
    await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
      VALUES(${conversationID},${owned.projectID},${ticketID},'plan',${owned.userID})`;
    const turn: AgentTurnRecord = {
      id: crypto.randomUUID(),
      commandId: commandID,
      state: "completed",
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
        text: "Plan product and tech",
        intent: "full-planning",
        sourceCommit: "a".repeat(40),
      },
      authority: {
        mode: "plan",
        modelId: "owned-planner",
        conversationVersion: 1,
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
      },
    };
    await db.client.begin(async (sql) => {
      const ticketContext = await admittedTicketContext(sql, owned.projectID, ticketID);
      await appendConversationEntry(sql, conversationID, {
        kind: "user-message",
        actor: "user",
        mode: "plan",
        body: "Plan product and tech",
        payload: {
          commandId: commandID,
          ticketContext,
          intent: "full-planning",
          sourceCommit: "a".repeat(40),
        },
        citations: [],
        inReplyToEntryId: null,
        requirementRevisionId: null,
      });
      await persistProjectOutput(
        sql,
        turn,
        {
          kind: "requirement",
          message: "Confirm the product scope.",
          ticket: { title: "Export invoices", description: "" },
          requirement: planningProduct,
          citations: [],
        },
        false,
        undefined,
        "a".repeat(40),
      );
    });
    const [proposal] = await db.client<
      { id: string }[]
    >`SELECT id FROM factory.conversation_entry WHERE conversation_id=${conversationID} AND kind='requirement'`;
    const controller = createProjectAgentController(db, { start: async () => null });
    const documents = createTicketDocumentController(db, (sql, input) =>
      controller.admitTechnicalIn(sql, input),
    );
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      proposalEntryId: fixtureValue(proposal, "proposal").id,
      title: "Export invoices",
      description: "",
      requirement: planningProduct,
    };
    const confirmed = await documents.save(ticketID, owned.userID, input);
    expect(await documents.save(ticketID, owned.userID, input)).toEqual(confirmed);
    const tasks = await db.client<{ input: Record<string, unknown>; state: string }[]>`
      SELECT input,state FROM factory.agent_turn WHERE ticket_id=${ticketID}`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state).toBe("pending");
    expect(tasks[0]?.input).toMatchObject({
      intent: "technical-planning",
      sourceCommit: "a".repeat(40),
      commandId: input.commandId,
    });
    expect(
      await db.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    const [entry] = await db.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM factory.conversation_entry WHERE payload->>'commandId'=${input.commandId}`;
    expect(entry?.payload["technicalBase"]).toMatchObject({
      requirementRevisionId: confirmed.requirementRevisionId,
      documentId: confirmed.id,
    });
    expect(
      await db.client.begin((sql) =>
        technicalPlanningOutstandingIn(sql, ticketID, confirmed.requirementRevisionId),
      ),
    ).toBe(true);
    await db.client.begin((sql) =>
      saveTechnicalDesignIn(sql, {
        id: crypto.randomUUID(),
        ticketID,
        userID: owned.userID,
        base: technicalPlanningBaseInput.parse(entry?.payload["technicalBase"]),
        content: { ...planningDesign, diagrams: [] },
        renders: [],
        citations: [],
      }),
    );
    expect(
      await db.client.begin((sql) =>
        technicalPlanningOutstandingIn(sql, ticketID, confirmed.requirementRevisionId),
      ),
    ).toBe(false);
  } finally {
    await db.client.end();
    await host.dispose();
  }
}, 60_000);

test("Implement freezes the exact technical revision, rejects stale source and passes the design into Build", async () => {
  const host = await factoryProcess();
  const db = host.connect();
  const env = {
    FACTORY_FORGEJO_API_URL: process.env["FACTORY_FORGEJO_API_URL"],
    FACTORY_FORGEJO_TOKEN: process.env["FACTORY_FORGEJO_TOKEN"],
    FACTORY_FORGEJO_OWNER: process.env["FACTORY_FORGEJO_OWNER"],
  };
  let head = "b".repeat(40);
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/repos/owned/planning"))
        return Response.json({
          owner: { login: "owned" },
          name: "planning",
          default_branch: "main",
        });
      if (path.endsWith("/branches/main"))
        return Response.json({ name: "main", commit: { id: head } });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const owned = await fixture(undefined, undefined, db),
      ticketID = crypto.randomUUID();
    await db.client`UPDATE factory.project SET repository_url=${`http://127.0.0.1:${forge.port}/owned/planning.git`} WHERE id=${owned.projectID}`;
    await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${ticketID},${owned.projectID},'Export invoices','ready',${owned.userID})`;
    const documents = createTicketDocumentController(db);
    const product = await documents.save(ticketID, owned.userID, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Export invoices",
      description: "",
      requirement: planningProduct,
    });
    const designID = crypto.randomUUID();
    await db.client.begin((sql) =>
      saveTechnicalDesignIn(sql, {
        id: designID,
        ticketID,
        userID: owned.userID,
        base: {
          requirementRevisionId: fixtureValue(
            product.requirementRevisionId,
            "product.requirementRevisionId",
          ),
          documentId: product.id,
          previousDesignId: null,
          sourceCommit: "a".repeat(40),
        },
        content: { ...planningDesign, diagrams: [] },
        citations: [],
        renders: [],
      }),
    );
    Object.assign(process.env, {
      FACTORY_FORGEJO_API_URL: `http://127.0.0.1:${forge.port}/api/v1`,
      FACTORY_FORGEJO_TOKEN: "owned-token",
      FACTORY_FORGEJO_OWNER: "owned",
    });
    const changes = createChangeController(db, { stop: async () => null });
    const admission = createChangeAdmission(db, "owned-coding-model"),
      commandID = crypto.randomUUID();
    const input = {
      commandID,
      revisionID: fixtureValue(product.requirementRevisionId, "product.requirementRevisionId"),
      technicalDesignRevisionID: designID,
      admitBuild: (sql: Parameters<typeof admission.admitIn>[0], changeID: string) =>
        admission.admitIn(sql, changeID, owned.userID, {
          kind: "change-start",
          commandId: commandID,
        }),
    };
    const { technicalDesignRevisionID: _designID, ...withoutDesign } = input;
    await expect(changes.start(ticketID, owned.userID, withoutDesign)).rejects.toThrow(
      "current technical design",
    );
    await expect(changes.start(ticketID, owned.userID, input)).rejects.toThrow("source changed");
    expect(
      await db.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    head = "a".repeat(40);
    const change = await changes.start(ticketID, owned.userID, input);
    const [scope] = await db.client<{ technicalID: string; prompt: string }[]>`
      SELECT approval.technical_design_revision_id AS "technicalID",intent.prompt_text AS prompt
      FROM factory.requirement_approval approval JOIN factory.change change ON change.requirement_approval_id=approval.id
      JOIN factory.agent_turn turn ON turn.change_id=change.id
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id WHERE change.id=${fixtureValue(change, "change").id}`;
    expect(scope?.technicalID).toBe(designID);
    expect(scope?.prompt).toContain("Approved technical design:");
    expect(scope?.prompt).toContain(JSON.stringify(planningDesign.proposedChanges));
    await expect(
      documents.save(ticketID, owned.userID, {
        commandId: crypto.randomUUID(),
        expectedVersion: product.ticketVersion,
        expectedDocumentId: product.id,
        requirementRevisionId: product.requirementRevisionId,
        title: "Export invoices",
        description: "",
        requirement: planningProduct,
      }),
    ).rejects.toThrow();
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await forge.stop(true);
    await db.client.end();
    await host.dispose();
  }
}, 60_000);
