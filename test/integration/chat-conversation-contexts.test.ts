import { expect, test } from "bun:test";
import { createCodingContexts } from "../../apps/factory/src/agent/conversation-contexts";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { appendConversationEntry } from "../../apps/factory/src/project-agent/conversation-store";
import { persistProjectOutput } from "../../apps/factory/src/project-agent/effects";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { fixtureValue } from "../fixtures/value";

test("fresh Coding retains history on the same Workspace and rejects old or unresolved execution targets", async () => {
  const owned = await fixture();
  try {
    const conversationID = crypto.randomUUID();
    await owned.database
      .client`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
      VALUES(${conversationID},${owned.projectID},${owned.ticketID},'build',${owned.userID})`;
    const oldAsset = crypto.randomUUID();
    await owned.database
      .client`INSERT INTO factory.attachment(id,project_id,owner_id,name,media_type,
      sha256,byte_length,reserved_bytes,state,text_content,completed_at)
      VALUES(${oldAsset},${owned.projectID},${owned.userID},'original.txt','text/plain',
        ${"a".repeat(64)},1,1,'ready','Original conversation only',now())`;
    const oldFile = `Earlier conversation file: /api/attachments/${oldAsset}`;
    await owned.database.client.begin((sql) =>
      appendConversationEntry(sql, conversationID, {
        kind: "user-message",
        actor: "user",
        mode: "build",
        body: oldFile,
        payload: {},
        citations: [],
        inReplyToEntryId: null,
        requirementRevisionId: null,
        createdBy: owned.userID,
      }),
    );
    const snapshot = {
      messages: [
        { id: "old-assistant", role: "assistant", text: "Retained implementation history", at: 1 },
      ],
      admittedMessages: [],
      messagesAvailable: true,
      turn: null,
    };
    const rotate = createCodingContexts(owned.database);
    const commandID = crypto.randomUUID();
    const contextID = await rotate(owned.changeID, owned.userID, commandID, null, snapshot);
    expect(await rotate(owned.changeID, owned.userID, commandID, null, snapshot)).toBe(contextID);
    await expect(
      rotate(owned.changeID, owned.userID, commandID, contextID, snapshot),
    ).rejects.toThrow("different input");
    const [workspace] = await owned.database.client<{ count: number; attemptID: string }[]>`
      SELECT (SELECT count(*)::integer FROM factory.development_workspace WHERE change_id=${owned.changeID}) AS count,
        runtime_attempt_id AS "attemptID" FROM factory.change WHERE id=${owned.changeID}`;
    expect(workspace).toEqual({ count: 1, attemptID: owned.attemptID });
    const project = createProjectAgentController(owned.database, { start: async () => null });
    const active = await project.get(owned.projectID, owned.ticketID, owned.userID);
    expect(active).toMatchObject({
      contextId: contextID,
      isActiveCoding: true,
      mode: "build",
      entries: [],
    });
    const original = await project.get(owned.projectID, owned.ticketID, owned.userID, "original");
    expect(original).toMatchObject({ isActiveCoding: false, codingHistory: snapshot });
    expect((await project.get(owned.projectID, owned.ticketID, owned.userID))?.contextId).toBe(
      contextID,
    );
    const admission = createChangeAdmission(owned.database, buildModelID);
    await expect(
      admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Old draft",
      }),
    ).rejects.toThrow("active Coding conversation changed");
    const build = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Continue from retained source",
      contextId: contextID,
    });
    const intent = await admission.intent(build.turn.id);
    const [attachmentContexts] = await owned.database.client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM factory.attachment_turn_context WHERE turn_id=${build.turn.id}`;
    expect(attachmentContexts?.count).toBe(0);
    expect(intent.bootstrap).toBe(true);
    expect(intent.sessionID).not.toBe(owned.sessionID);
    expect(build.turn.command.contextId).toBe(contextID);
    await expect(
      rotate(owned.changeID, owned.userID, crypto.randomUUID(), contextID, snapshot),
    ).rejects.toThrow("Finish Coding");

    // Separate read-only conversations do not seize the shared Coding boundary.
    const research = await project.newConversation(
      owned.projectID,
      owned.ticketID,
      owned.userID,
      crypto.randomUUID(),
    );
    if (!research?.contextId) throw new Error("Owned research context missing");
    const store = createAgentTurnStore(owned.database);
    const read = await store.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        conversationId: conversationID,
        contextId: research.contextId,
        projectId: owned.projectID,
        ticketId: owned.ticketID,
        createdBy: owned.userID,
        text: "Read the Project Wiki while Coding continues",
      },
      { mode: "investigate", conversationVersion: 1, modelId: "controlled-project-model" },
      async (sql, record) => {
        await appendConversationEntry(sql, conversationID, {
          kind: "user-message",
          actor: "user",
          mode: "investigate",
          body: record.command.kind === "project-message" ? record.command.text : "",
          payload: { turnId: record.id, commandId: record.commandId },
          contextId: fixtureValue(research.contextId, "research.contextId"),
          citations: [],
          inReplyToEntryId: null,
          requirementRevisionId: null,
          createdBy: owned.userID,
        });
      },
    );
    const owner = await store.claimPending(read.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned read owner missing");
    expect(await store.validateExecution(owner.id, owner.ownerToken)).toBe(true);
    await owned.database.client.begin((sql) =>
      persistProjectOutput(sql, owner, {
        kind: "answer",
        message: "This separate conversation has no Coding authority.",
        citations: [],
      }),
    );
    const readView = await project.get(
      owned.projectID,
      owned.ticketID,
      owned.userID,
      research.contextId,
    );
    expect(readView?.entries.map((entry) => entry.body)).toEqual([
      "Read the Project Wiki while Coding continues",
      "This separate conversation has no Coding authority.",
    ]);
    expect(
      (await project.get(owned.projectID, owned.ticketID, owned.userID, "original"))?.entries.map(
        (entry) => entry.body,
      ),
    ).toEqual([oldFile]);
    expect((await project.get(owned.projectID, owned.ticketID, owned.userID))?.contextId).toBe(
      contextID,
    );
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("personal Project conversations cannot be selected through another person's Project scope", async () => {
  const owned = await fixture();
  const other = crypto.randomUUID();
  try {
    await owned.database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${other},'Other',${`${other}@factory.local`},true)`;
    await owned.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${owned.projectID},${other},'developer',${owned.userID})`;
    const project = createProjectAgentController(owned.database, { start: async () => null });
    const commandID = crypto.randomUUID();
    const personal = await project.newConversation(
      owned.projectID,
      undefined,
      owned.userID,
      commandID,
    );
    expect(
      (await project.newConversation(owned.projectID, undefined, owned.userID, commandID))
        ?.contextId,
    ).toBe(personal?.contextId);
    await project.newConversation(owned.projectID, undefined, other, crypto.randomUUID());
    await expect(
      project.get(
        owned.projectID,
        undefined,
        other,
        fixtureValue(fixtureValue(personal, "personal").contextId, "personal!.contextId"),
      ),
    ).rejects.toThrow("Conversation not found");
    expect(
      (await project.get(owned.projectID, undefined, other))?.contexts.some(
        (context) => context.id === personal?.contextId,
      ),
    ).toBe(false);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("the first Build creates its shared conversation before parallel research can be admitted", async () => {
  const owned = await fixture();
  try {
    const build = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Keep Coding in this shared Workspace",
      },
    );
    expect(build.turn.command.conversationId).toBeString();
    const store = createAgentTurnStore(owned.database);
    const coding = await store.claimPending(build.turn.id);
    if (!coding?.ownerToken) throw new Error("Owned Coding lease missing");
    await owned.writers.prepareAgent(owned.changeID, coding.id);
    const project = createProjectAgentController(owned.database, { start: async () => null });
    const context = await project.newConversation(
      owned.projectID,
      owned.ticketID,
      owned.userID,
      crypto.randomUUID(),
    );
    if (!context?.contextId) throw new Error("Owned research context missing");
    const read = await store.admit(
      {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        conversationId: context.id,
        contextId: context.contextId,
        projectId: owned.projectID,
        ticketId: owned.ticketID,
        createdBy: owned.userID,
        text: "Read only Project information",
      },
      { mode: "investigate", modelId: "owned-research-model", conversationVersion: 1 },
    );
    const research = await store.claimPending(read.turn.id);
    if (!research?.ownerToken) throw new Error("Owned research lease missing");
    for (let pass = 0; pass < 8; pass++)
      expect(
        await Promise.all([
          store.validateExecution(coding.id, coding.ownerToken),
          store.validateExecution(research.id, research.ownerToken),
        ]),
      ).toEqual([true, true]);
    expect((await owned.writers.status(owned.changeID, owned.userID)).actor?.kind).toBe("agent");
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("adding conversations cannot invalidate an already admitted unversioned Coding turn", async () => {
  const owned = await fixture();
  try {
    const store = createAgentTurnStore(owned.database);
    const admitted = await store.admit(
      {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        projectId: owned.projectID,
        ticketId: owned.ticketID,
        changeId: owned.changeID,
        conversationId: null,
        createdBy: owned.userID,
        text: "Retained original command",
      },
      {
        mode: "build",
        requirementRevisionId: owned.revisionID,
        modelId: buildModelID,
        conversationVersion: null,
      },
      (sql, record) => claimAgentWriterIn(sql, owned.changeID, record.id, owned.userID),
    );
    const owner = await store.claimPending(admitted.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned retained lease missing");
    const project = createProjectAgentController(owned.database, { start: async () => null });
    await expect(
      project.newConversation(owned.projectID, owned.ticketID, owned.userID, crypto.randomUUID()),
    ).rejects.toThrow("must settle");
    expect(await store.validateExecution(owner.id, owner.ownerToken)).toBe(true);
    expect((await store.get(owner.id))?.command.conversationId).toBeNull();
    expect(await project.get(owned.projectID, owned.ticketID, owned.userID)).toBeNull();
  } finally {
    await owned.dispose();
  }
});
