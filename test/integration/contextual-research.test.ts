import { authenticatedBootstrap, callFactoryFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { createEpicConfirmation } from "../../apps/factory/src/project-agent/epic-confirmation";
import { readResearch, searchResearch } from "../../apps/factory/src/project-agent/research";
import type { EpicProposal } from "../../packages/conversation-domain/src/epic-proposal";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("Ticket detail hides unconfirmed code-derived proposals from Contributors after downgrade", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const conversationID = crypto.randomUUID(),
      entryID = crypto.randomUUID();
    const payload = {
      visibility: "developer",
      ticket: { title: "Private code-derived proposal", description: "Code-derived finding" },
      base: { id: owned.ticketID, version: 1, documentId: null, revisionId: owned.revisionID },
      requirement: {
        summary: "Code-derived private finding",
        acceptanceCriteria: ["Private code detail"],
        nonGoals: [],
      },
    };
    await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by,mode) VALUES(${conversationID},${owned.projectID},${owned.ticketID},${owned.userID},'plan')`;
    await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload) VALUES(${entryID},${conversationID},1,'requirement','project-agent','plan','Proposal',${JSON.stringify(payload)}::jsonb)`;
    await process.start();
    const cookie = await process.signIn();
    const session = (await authenticatedBootstrap(process.base, { cookie })) as {
      session: { user: { id: string } };
    };
    const actor = session.session.user.id;
    const read = () =>
      serverCall(
        callFactoryFunction(process.base, "getTicketDetail", [owned.ticketID], { cookie }),
      );
    expect((await read()).proposal).toMatchObject({ id: entryID });
    await db.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${owned.projectID},${actor},'product-contributor',${actor})`;
    await db.client`DELETE FROM factory.administrator WHERE user_id=${actor}`;
    expect((await read()).proposal).toBeNull();
    await db.client`UPDATE factory.project_membership SET role='developer' WHERE project_id=${owned.projectID} AND user_id=${actor}`;
    expect((await read()).proposal).toMatchObject({ id: entryID });
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60000);

test("weighted indexed research finds current specs, typos, references and relations without scope leakage", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const epic = crypto.randomUUID();
    expect(
      (await searchResearch(db, owned.projectID, owned.userID, "bounded local check")).some(
        (hit) => hit.id === owned.ticketID,
      ),
    ).toBe(true);
    expect(
      (await readResearch(db, owned.projectID, owned.userID, "ticket", owned.ticketID)).body,
    ).toContain("bounded local check");
    await db.client`INSERT INTO factory.epic(id,project_id,title,description,created_by) VALUES(${epic},${owned.projectID},'Invoice workflow','Rechnungen exportieren',${owned.userID})`;
    await db.client`UPDATE factory.ticket SET title='Invoice export',description='Rechnungen exportieren',epic_id=${epic} WHERE id=${owned.ticketID}`;
    const canonical = canonicalRequirementContent({
      summary: "CSV export supports Unicode customers",
      acceptanceCriteria: ["UTF8 exports preserve names"],
      nonGoals: [],
    });
    const document = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket_document_revision(id,ticket_id,ordinal,title,description,canonical_content,content_digest,requirement_revision_id,input_digest,created_by)
      VALUES(${document},${owned.ticketID},1,'Invoice export','',${canonical},${createHash("sha256").update(canonical).digest("hex")},${owned.revisionID},${"a".repeat(64)},${owned.userID})`;
    expect(
      (await searchResearch(db, owned.projectID, owned.userID, "bounded local check")).some(
        (hit) => hit.id === owned.ticketID,
      ),
    ).toBe(false);
    for (const query of [
      "Invoice export",
      "Invocie export",
      `TCK-${owned.ticketID.replaceAll("-", "").slice(0, 6)}`,
      "Unicode",
      "Rechnungen",
    ]) {
      const start = performance.now();
      const hits = await searchResearch(db, owned.projectID, owned.userID, query);
      expect(hits.some((hit) => hit.id === owned.ticketID)).toBe(true);
      console.log(
        JSON.stringify({
          query,
          databaseMs: Math.round(performance.now() - start),
          source: owned.ticketID,
        }),
      );
    }
    expect((await searchResearch(db, owned.projectID, owned.userID, "Invoice export"))[0]?.id).toBe(
      owned.ticketID,
    );
    const read = await readResearch(db, owned.projectID, owned.userID, "ticket", owned.ticketID);
    expect(read.body).toContain("Unicode");
    const wikiID = crypto.randomUUID();
    const longBody = `${"Background context. ".repeat(1100)}Unique late permission boundary.`;
    await db.client`INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by) VALUES(${wikiID},${owned.projectID},'permissions','Permissions',${longBody},${longBody},${"b".repeat(40)},${owned.userID})`;
    const longHit = (
      await searchResearch(db, owned.projectID, owned.userID, "Unique late permission")
    )[0];
    expect(longHit?.excerpt).toContain("Unique late permission");
    const firstPage = await readResearch(db, owned.projectID, owned.userID, "knowledge", wikiID);
    expect(firstPage.body.length).toBe(16000);
    expect(firstPage.nextOffset).toBe(16000);
    const finalPage = await readResearch(
      db,
      owned.projectID,
      owned.userID,
      "knowledge",
      wikiID,
      firstPage.nextOffset ?? 0,
      firstPage.version,
    );
    expect(firstPage.body + finalPage.body).toBe(longBody);
    expect(finalPage.nextOffset).toBeNull();
    await db.client`UPDATE factory.knowledge_page SET version=version+1 WHERE id=${wikiID}`;
    await expect(
      readResearch(
        db,
        owned.projectID,
        owned.userID,
        "knowledge",
        wikiID,
        16000,
        firstPage.version,
      ),
    ).rejects.toThrow("changed");
    expect(read.relationships.find((item) => item.id === epic)?.relationship).toBe("parent-epic");
    const prerequisite = crypto.randomUUID(),
      dependent = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id,project_id,title,description,created_by)
      VALUES(${prerequisite},${owned.projectID},'Prepare export','',${owned.userID}),
        (${dependent},${owned.projectID},'Deliver export','',${owned.userID})`;
    await db.client`INSERT INTO factory.ticket_dependency(project_id,ticket_id,prerequisite_id,created_by)
      VALUES(${owned.projectID},${dependent},${prerequisite},${owned.userID})`;
    expect(
      (await readResearch(db, owned.projectID, owned.userID, "ticket", dependent)).relationships,
    ).toContainEqual({
      source: "ticket",
      id: prerequisite,
      label: "Prepare export",
      relationship: "prerequisite",
    });
    expect(
      (await readResearch(db, owned.projectID, owned.userID, "ticket", prerequisite)).relationships,
    ).toContainEqual({
      source: "ticket",
      id: dependent,
      label: "Deliver export",
      relationship: "dependent",
    });
    expect(
      (await readResearch(db, owned.projectID, owned.userID, "epic", epic)).relationships[0]?.id,
    ).toBe(owned.ticketID);
    expect(await searchResearch(db, owned.projectID, owned.userID, "' | & ! <script> ;")).toEqual(
      [],
    );
    await db.client`UPDATE factory.ticket SET trashed_at=now() WHERE id=${owned.ticketID}`;
    expect(
      (await searchResearch(db, owned.projectID, owned.userID, "Unicode")).some(
        (hit) => hit.id === owned.ticketID,
      ),
    ).toBe(false);
    await expect(
      readResearch(db, owned.projectID, owned.userID, "ticket", owned.ticketID),
    ).rejects.toThrow("unavailable");
    const stranger = crypto.randomUUID();
    await db.client`INSERT INTO auth."user"(id,name,email) VALUES(${stranger},'Stranger',${`${stranger}@test.local`})`;
    await expect(searchResearch(db, owned.projectID, stranger, "Invoice")).rejects.toThrow(
      "Project not found",
    );
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60000);

test("exact-commit code reads share caches, reject secrets and recheck developer access", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const sha = "b".repeat(40),
      blob = "c".repeat(40);
    let inventories = 0,
      reads = 0;
    const api = "https://forge.test/api/v1";
    const owner = "factory";
    await db.client`UPDATE factory.project SET repository_url=${`${new URL(api).origin}/${owner}/owned-code.git`} WHERE id=${owned.projectID}`;
    const previous = [
      "FACTORY_FORGEJO_API_URL",
      "FACTORY_FORGEJO_OWNER",
      "FACTORY_FORGEJO_TOKEN",
    ].map((key) => [key, Bun.env[key]] as const);
    Bun.env["FACTORY_FORGEJO_API_URL"] = api;
    Bun.env["FACTORY_FORGEJO_OWNER"] = owner;
    Bun.env["FACTORY_FORGEJO_TOKEN"] = "owned-test-token";
    const controller = createKnowledgeController(db, {
      getDefaultBranch: async () => ({ name: "main", headSha: sha }),
      listFiles: async () => {
        inventories++;
        return [
          { path: "src/index.ts", sha: blob, size: 45 },
          { path: ".env.local", sha: blob, size: 45 },
          { path: "secrets.json", sha: blob, size: 45 },
        ];
      },
      getFileInfo: async () => {
        reads++;
        return { sha: blob, content: "export const answer = 42;\nconsole.log(answer);" };
      },
    });
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    const paths = await controller.codePaths(owned.projectID, "src", owned.userID);
    expect(paths.paths).toEqual(["src/index.ts"]);
    const value = { commitSha: sha, path: "src/index.ts", startLine: 1, lineCount: 1 };
    const [first, second] = await Promise.all([
      controller.code(owned.projectID, value, owned.userID),
      controller.code(owned.projectID, value, owned.userID),
    ]);
    expect(first).toEqual(second);
    expect(first.body).toContain("1: export");
    expect(first.truncated).toBe(true);
    expect(reads).toBe(1);
    expect(inventories).toBe(1);
    for (const path of [".env.local", "secrets.json", "../src/index.ts"])
      await expect(
        controller.code(owned.projectID, { ...value, path }, owned.userID),
      ).rejects.toThrow("unavailable");
    await db.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await expect(controller.code(owned.projectID, value, owned.userID)).rejects.toThrow(
      "Developer access required",
    );
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60000);

test("Epic confirmation is atomic, versioned and replayable; converts intent and starts no work", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const origin = crypto.randomUUID(),
      entryID = crypto.randomUUID(),
      conversationID = crypto.randomUUID();
    await db.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${origin},${owned.projectID},'Complete invoice workflow','ready',${owned.userID})`;
    await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by,mode) VALUES(${conversationID},${owned.projectID},${origin},${owned.userID},'plan')`;
    const requirement = {
      summary: "Export invoices",
      acceptanceCriteria: ["A contributor downloads invoices"],
      nonGoals: [],
    };
    const proposal: EpicProposal = {
      epic: { title: "Invoice workflow", description: "Manage invoicing" },
      members: [
        {
          key: "reuse",
          existingTicketId: owned.ticketID,
          expectedVersion: 1,
          title: "Existing delivery",
          description: "Retained",
          requirement,
          dependsOn: [],
        },
        {
          key: "export",
          existingTicketId: null,
          expectedVersion: null,
          title: "Export invoice",
          description: "Create export",
          requirement,
          dependsOn: ["reuse"],
        },
      ],
    };
    await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload)
      VALUES(${entryID},${conversationID},1,'requirement','project-agent','plan','Review proposed work',${JSON.stringify({ epicProposal: proposal, base: { id: origin, version: 1, documentId: null, revisionId: null } })}::jsonb)`;
    const confirm = createEpicConfirmation(db);
    const input = { commandId: crypto.randomUUID(), proposal };
    const active = await createAgentTurnStore(db).admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: owned.projectID,
        ticketId: origin,
        conversationId: conversationID,
        createdBy: owned.userID,
        text: "Clarify",
      },
      { mode: "plan", conversationVersion: 1, modelId: "owned-model" },
    );
    await expect(confirm(owned.projectID, entryID, owned.userID, input)).rejects.toThrow(
      "current clarification",
    );
    await db.client`UPDATE factory.agent_turn SET state='failed' WHERE id=${active.turn.id}`;
    await expect(
      confirm(owned.projectID, entryID, owned.userID, {
        ...input,
        proposal: {
          ...proposal,
          members: proposal.members.map((member) => ({
            ...member,
            dependsOn: member.key === "reuse" ? ["export"] : ["reuse"],
          })),
        },
      }),
    ).rejects.toThrow("cannot cycle");
    await expect(confirm(crypto.randomUUID(), entryID, owned.userID, input)).rejects.toThrow(
      "Project not found",
    );
    await db.client`UPDATE factory.ticket SET version=2 WHERE id=${origin}`;
    await expect(confirm(owned.projectID, entryID, owned.userID, input)).rejects.toThrow(
      "originating Ticket changed",
    );
    await db.client`UPDATE factory.ticket SET version=1 WHERE id=${origin}`;
    await expect(
      confirm(owned.projectID, entryID, owned.userID, {
        ...input,
        proposal: {
          ...proposal,
          members: proposal.members.map((member) =>
            member.existingTicketId ? { ...member, expectedVersion: 99 } : member,
          ),
        },
      }),
    ).rejects.toThrow("changed");
    expect(
      (await db.client`SELECT id FROM factory.epic WHERE project_id=${owned.projectID}`).length,
    ).toBe(0);
    const [a, b] = await Promise.all([
      confirm(owned.projectID, entryID, owned.userID, input),
      confirm(owned.projectID, entryID, owned.userID, input),
    ]);
    expect(a).toEqual(b);
    const [state] =
      await db.client`SELECT converted_to_epic_id FROM factory.ticket WHERE id=${origin}`;
    expect(state?.["converted_to_epic_id"]).toBe(a.epicId);
    const [newTicket] =
      await db.client`SELECT state,title FROM factory.ticket WHERE id=${a.ticketIds[1]!}`;
    expect(newTicket).toMatchObject({ state: "ready", title: "Export invoice" });
    expect(
      (
        await db.client`SELECT ticket_id FROM factory.requirements_entry_intent WHERE ticket_id=ANY(${a.ticketIds}::uuid[])`
      ).length,
    ).toBe(0);
    expect(
      (await db.client`SELECT id FROM factory.agent_turn WHERE project_id=${owned.projectID}`)
        .length,
    ).toBe(1);
    expect(
      (await db.client`SELECT title FROM factory.ticket WHERE id=${owned.ticketID}`)[0]?.["title"],
    ).toBe("Owned Build regression");
    expect(
      (await db.client`SELECT id FROM factory.change WHERE project_id=${owned.projectID}`).length,
    ).toBe(1);
    await expect(
      confirm(owned.projectID, entryID, owned.userID, {
        ...input,
        proposal: { ...proposal, epic: { ...proposal.epic, title: "Collision" } },
      }),
    ).rejects.toThrow("another decision");
    await expect(
      (async () => {
        await db.client`UPDATE factory.epic_confirmation SET decision='{}' WHERE id=${input.commandId}`;
      })(),
    ).rejects.toThrow("immutable");
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60000);

test("Epic confirmation keeps an implemented origin and its admitted scope without starting member work", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  try {
    const owned = await fixture(undefined, undefined, db);
    const conversationID = crypto.randomUUID(),
      entryID = crypto.randomUUID();
    const requirement = {
      summary: "Invoice work",
      acceptanceCriteria: ["Observable invoice outcome"],
      nonGoals: [],
    };
    const proposal: EpicProposal = {
      epic: { title: "Invoice workflow", description: "Follow-on invoice work" },
      members: [
        {
          key: "original",
          existingTicketId: owned.ticketID,
          expectedVersion: 1,
          title: "Proposed rename ignored",
          description: "Ignored reuse",
          requirement,
          dependsOn: [],
        },
        {
          key: "follow-on",
          existingTicketId: null,
          expectedVersion: null,
          title: "Download invoices",
          description: "New outcome",
          requirement,
          dependsOn: ["original"],
        },
      ],
    };
    await db.client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by,mode) VALUES(${conversationID},${owned.projectID},${owned.ticketID},${owned.userID},'plan')`;
    await db.client`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload) VALUES(${entryID},${conversationID},1,'requirement','project-agent','plan','Review proposed work',${JSON.stringify({ epicProposal: proposal, base: { id: owned.ticketID, version: 1, documentId: null, revisionId: owned.revisionID } })}::jsonb)`;
    const result = await createEpicConfirmation(db)(owned.projectID, entryID, owned.userID, {
      commandId: crypto.randomUUID(),
      proposal,
    });
    const [origin] =
      await db.client`SELECT title,epic_id,converted_to_epic_id FROM factory.ticket WHERE id=${owned.ticketID}`;
    expect(origin).toMatchObject({
      title: "Owned Build regression",
      epic_id: result.epicId,
      converted_to_epic_id: null,
    });
    expect(result.ticketIds[0]).toBe(owned.ticketID);
    expect(
      (
        await db.client`SELECT approval.requirement_revision_id FROM factory.change change JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id WHERE change.id=${owned.changeID}`
      )[0]?.["requirement_revision_id"],
    ).toBe(owned.revisionID);
    expect(
      await db.client`SELECT id FROM factory.requirement_revision WHERE ticket_id=${owned.ticketID}`,
    ).toHaveLength(1);
    expect(
      await db.client`SELECT id FROM factory.agent_turn WHERE project_id=${owned.projectID}`,
    ).toHaveLength(0);
    expect(
      await db.client`SELECT ticket_id FROM factory.requirements_entry_intent WHERE ticket_id=ANY(${result.ticketIds}::uuid[])`,
    ).toHaveLength(0);
    expect(
      await db.client`SELECT id FROM factory.change WHERE project_id=${owned.projectID}`,
    ).toHaveLength(1);
  } finally {
    await db.client.end();
    await process.dispose();
  }
}, 60000);
