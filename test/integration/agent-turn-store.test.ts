import { expect, test } from "bun:test";
import type { AgentTurnAuthority, AgentTurnCommand } from "#conversation-domain/agent-turn";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { appendConversationEntry } from "../../apps/factory/src/conversations/store";
import { factoryProcess } from "../fixtures/factory-process";

async function fixture() {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const conversationID = crypto.randomUUID();
  const suffix = projectID.slice(0, 8);
  await database.client
    .begin(async (transaction) => {
      await transaction`
      INSERT INTO auth."user"(id, name, email, email_verified)
      VALUES (${userID}, 'Owned Admission Regression', ${`admission-${suffix}@factory.local`}, true)
    `;
      await transaction`
      INSERT INTO factory.project(id, slug, name, repository_url, default_branch, actor_template_path, created_by)
      VALUES (${projectID}, ${`admission-${suffix}`}, 'Owned Admission Regression',
        'https://example.invalid/admission.git', 'main', '.factory/actor-template.json', ${userID})
    `;
      await transaction`
      INSERT INTO factory.ticket_conversation(id, project_id, created_by)
      VALUES (${conversationID}, ${projectID}, ${userID})
    `;
      await transaction`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${projectID},${userID},'developer',${userID})`;
    })
    .catch(async (cause) => {
      await database.client.end();
      await processFixture.dispose();
      throw cause;
    });
  const command = {
    kind: "project-message",
    commandId: crypto.randomUUID(),
    projectId: projectID,
    createdBy: userID,
    conversationId: conversationID,
    ticketId: null,
    text: "Investigate this owned Project",
  } satisfies AgentTurnCommand;
  const authority = {
    mode: "investigate",
    conversationVersion: 1,
    modelId: "owned-admission-model",
    skillRevisionIds: [],
    requiredSkillRevisionIds: [],
  } satisfies AgentTurnAuthority;
  return {
    database,
    command,
    authority,
    store: () => createAgentTurnStore(database),
    async dispose() {
      try {
        await database.client.begin(async (transaction) => {
          await transaction`DELETE FROM factory.project WHERE id = ${projectID} AND created_by = ${userID}`;
          await transaction`DELETE FROM auth."user" WHERE id = ${userID} AND email = ${`admission-${suffix}@factory.local`}`;
        });
      } finally {
        await database.client.end();
        await processFixture.dispose();
      }
    },
  };
}

test("admission and its user input commit together or both roll back", async () => {
  const owned = await fixture();
  try {
    const input = async (transaction: Parameters<typeof appendConversationEntry>[0]) => {
      await appendConversationEntry(transaction, owned.command.conversationId, {
        kind: "user-message",
        actor: "user",
        mode: "investigate",
        body: owned.command.text,
        payload: {},
        citations: [],
        inReplyToEntryId: null,
        requirementRevisionId: null,
        createdBy: owned.command.createdBy,
      });
    };
    await expect(
      owned.store().admit(owned.command, owned.authority, async (transaction) => {
        await input(transaction);
        throw new Error("Injected admission failure");
      }),
    ).rejects.toThrow("Injected admission failure");
    expect(await owned.store().getByCommand(owned.command.commandId)).toBeNull();
    expect(
      await owned.database.client`SELECT id FROM factory.conversation_entry
      WHERE conversation_id = ${owned.command.conversationId}`,
    ).toHaveLength(0);
    await owned.store().admit(owned.command, owned.authority, input);
    await owned.store().admit(owned.command, owned.authority, input);
    expect(
      await owned.database.client`SELECT id FROM factory.conversation_entry
      WHERE conversation_id = ${owned.command.conversationId}`,
    ).toHaveLength(1);
  } finally {
    await owned.dispose();
  }
});

test("product effects cannot commit if outcome ownership expires", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const owner = await owned.store().claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Ownership required");
    await owned.store().beginDispatch(turn.id, owner.ownerToken);
    await expect(
      owned
        .store()
        .settle(turn.id, owner.ownerToken, "completed", "Owned result", async (transaction) => {
          await appendConversationEntry(transaction, owned.command.conversationId, {
            kind: "agent-message",
            actor: "project-agent",
            mode: "investigate",
            body: "Must roll back",
            payload: {},
            citations: [],
            inReplyToEntryId: null,
            requirementRevisionId: null,
          });
          await transaction`UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${turn.id}`;
        }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await owned.database.client`SELECT id FROM factory.conversation_entry
      WHERE conversation_id = ${owned.command.conversationId}`,
    ).toHaveLength(0);
    expect(await owned.store().get(turn.id)).toMatchObject({
      state: "dispatching",
      ownerToken: owner.ownerToken,
    });
    expect(await owned.store().settle(turn.id, owner.ownerToken, "completed", "Owned result")).toBe(
      true,
    );
    let effects = 0;
    expect(
      await owned
        .store()
        .settle(turn.id, owner.ownerToken, "completed", "Repeated result", async () => {
          effects += 1;
        }),
    ).toBe(false);
    expect(effects).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("concurrent duplicate command IDs replay one immutable admission", async () => {
  const owned = await fixture();
  try {
    const admissions = await Promise.all(
      Array.from({ length: 8 }, () => owned.store().admit(owned.command, owned.authority)),
    );
    expect(new Set(admissions.map((result) => result.turn.id)).size).toBe(1);
    expect(admissions.filter((result) => !result.replayed)).toHaveLength(1);
    const replay = await owned
      .store()
      .admit(owned.command, { ...owned.authority, modelId: "changed-default" });
    expect(replay.turn.authority).toEqual(owned.authority);
    await expect(
      owned.store().admit({ ...owned.command, text: "Changed payload" }, owned.authority),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      owned.store().admit({ ...owned.command, projectId: crypto.randomUUID() }, owned.authority),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await owned.dispose();
  }
});

test("different commands cannot concurrently own the same execution boundary", async () => {
  const owned = await fixture();
  try {
    const admissions = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        owned.store().admit({ ...owned.command, commandId: crypto.randomUUID() }, owned.authority),
      ),
    );
    expect(admissions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(admissions.filter((result) => result.status === "rejected")).toHaveLength(7);
  } finally {
    await owned.dispose();
  }
});

test("the database rejects a second active owner even without the admission lock", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const otherCommand = { ...owned.command, commandId: crypto.randomUUID() };
    await expect(
      Promise.resolve(owned.database.client`
      INSERT INTO factory.agent_turn(
        id, command_id, project_id, ticket_id, conversation_id, change_id, created_by,
        input, input_digest, authority
      ) SELECT ${crypto.randomUUID()}, ${otherCommand.commandId}, project_id, ticket_id,
        conversation_id, change_id, created_by, ${JSON.stringify(otherCommand)}::jsonb,
        input_digest, authority FROM factory.agent_turn WHERE id = ${turn.id}
    `),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "agent_turn_active_boundary_uidx" });
  } finally {
    await owned.dispose();
  }
});

test("unrelated personal Project conversations can own work independently", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const admissions = await Promise.all([
      first.store().admit(first.command, first.authority),
      second.store().admit(second.command, second.authority),
    ]);
    expect(admissions[0]?.turn.id).not.toBe(admissions[1]?.turn.id);
    expect(admissions.every((admission) => !admission.replayed)).toBe(true);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("an expired pre-dispatch owner can be replaced but cannot dispatch or settle", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => owned.store().claimPending(turn.id)),
    );
    const owner = claims.find((claim) => claim !== null);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    if (!owner?.ownerToken) throw new Error("Ownership was not recorded");
    await owned.database.client`
      UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${turn.id}
    `;
    // New store instance stands in for loss of the former process-local owner.
    const recovered = await owned.store().claimPending(turn.id);
    if (!recovered?.ownerToken) throw new Error("Pending intent was not recovered");
    expect(recovered.command).toEqual(owned.command);
    expect(recovered.ownerToken).not.toBe(owner.ownerToken);
    expect(await owned.store().beginDispatch(turn.id, owner.ownerToken)).toBeNull();
    expect(await owned.store().renew(turn.id, owner.ownerToken)).toBe(false);
    expect(await owned.store().beginDispatch(turn.id, recovered.ownerToken)).toMatchObject({
      state: "dispatching",
    });
    expect(await owned.store().settle(turn.id, owner.ownerToken, "completed", "Stale result")).toBe(
      false,
    );
    expect(
      await owned.store().settle(turn.id, recovered.ownerToken, "completed", "Owned result"),
    ).toBe(true);
    expect(await owned.store().get(turn.id)).toMatchObject({
      state: "completed",
      ownerToken: null,
      outcomeSummary: "Owned result",
    });
    expect(await owned.store().claimPending(turn.id)).toBeNull();
    const replay = await owned.store().admit(owned.command, owned.authority);
    expect(replay.turn.id).toBe(turn.id);
    expect(replay.turn.state).toBe("completed");
    await expect(
      Promise.resolve(owned.database.client`
      UPDATE factory.agent_turn SET state = 'pending' WHERE id = ${turn.id}
    `),
    ).rejects.toThrow("Terminal Agent Turn is immutable");
  } finally {
    await owned.dispose();
  }
});

test("dispatching work is not reclassified as undispatched after lease loss", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const owner = await owned.store().claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Ownership was not recorded");
    await owned.store().beginDispatch(turn.id, owner.ownerToken);
    await owned.database.client`
      UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${turn.id}
    `;
    expect(await owned.store().claimPending(turn.id)).toBeNull();
    expect(await owned.store().renew(turn.id, owner.ownerToken)).toBe(false);
    expect(await owned.store().settle(turn.id, owner.ownerToken, "completed", "Late result")).toBe(
      false,
    );
    expect(await owned.store().get(turn.id)).toMatchObject({ state: "dispatching" });
  } finally {
    await owned.dispose();
  }
});

test("a changed Conversation mode fences pending dispatch and admission cannot be rewritten", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const owner = await owned.store().claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Ownership was not recorded");
    await owned.database.client`
      UPDATE factory.ticket_conversation SET version = version + 1
      WHERE id = ${owned.command.conversationId}
    `;
    expect(await owned.store().beginDispatch(turn.id, owner.ownerToken)).toBeNull();
    await owned.database.client`
      UPDATE factory.ticket_conversation SET mode = 'plan'
      WHERE id = ${owned.command.conversationId}
    `;
    expect(await owned.store().beginDispatch(turn.id, owner.ownerToken)).toBeNull();
    await expect(
      Promise.resolve(owned.database.client`
      UPDATE factory.agent_turn SET authority = ${JSON.stringify({ ...owned.authority, mode: "plan" })}::jsonb
      WHERE id = ${turn.id}
    `),
    ).rejects.toThrow("Agent Turn admission is immutable");
  } finally {
    await owned.dispose();
  }
});

test("Drizzle admission retains JSON objects, normalized Unicode input and string lease timestamps", async () => {
  const owned = await fixture();
  try {
    const command = { ...owned.command, text: '  Prüfe 界 "quoted" \\ path\n🙂  ' };
    const { turn } = await owned.store().admit(command, {
      mode: "investigate",
      conversationVersion: 1,
      modelId: "  owned-model  ",
    });
    const normalized = { ...command, text: command.text.trim() };
    expect(turn.command).toEqual(normalized);
    expect(turn.authority).toEqual({
      ...owned.authority,
      modelId: "owned-model",
    });
    const [stored] = await owned.database.client<
      { input: unknown; authority: unknown; json: string; bytes: number; chars: number }[]
    >`SELECT input,authority,input::text AS json,octet_length(input::text) AS bytes,
      length(input::text) AS chars FROM factory.agent_turn WHERE id=${turn.id}`;
    expect(stored?.input).toEqual(normalized);
    expect(stored?.authority).toEqual(turn.authority);
    expect(stored?.bytes).toBe(Buffer.byteLength(stored?.json ?? "", "utf8"));
    expect(stored?.bytes).toBeGreaterThan(stored?.chars ?? 0);
    const owner = await owned.store().claimPending(turn.id);
    if (!owner?.ownerToken || !owner.ownerExpiresAt) throw new Error("Owned lease required");
    expect(typeof owner.ownerExpiresAt).toBe("string");
    expect(new Date(owner.ownerExpiresAt).toISOString()).toBe(owner.ownerExpiresAt);
    expect((await owned.store().get(turn.id))?.ownerExpiresAt).toBe(owner.ownerExpiresAt);
    expect((await owned.store().getByCommand(command.commandId))?.ownerExpiresAt).toBe(
      owner.ownerExpiresAt,
    );
    expect(await owned.store().renew(turn.id, owner.ownerToken, 60_000)).toBe(true);
    expect(await owned.store().beginDispatch(turn.id, owner.ownerToken)).toMatchObject({
      state: "dispatching",
      ownerExpiresAt: expect.any(String),
    });
    const summary = "界".repeat(2_000);
    expect(await owned.store().settle(turn.id, owner.ownerToken, "completed", summary)).toBe(true);
    expect(await owned.store().get(turn.id)).toMatchObject({
      outcomeSummary: summary,
      ownerToken: null,
      ownerExpiresAt: null,
    });
  } finally {
    await owned.dispose();
  }
});

test("the native authority byte limit still rejects a multibyte JSON object accepted by the DTO", async () => {
  const owned = await fixture();
  try {
    const revisions = Array.from({ length: 16 }, () => crypto.randomUUID());
    const authority = {
      ...owned.authority,
      modelId: "界".repeat(200),
      modelConnection: { connectionID: crypto.randomUUID(), version: 1 },
      skillRevisionIds: revisions,
      requiredSkillRevisionIds: revisions,
    };
    expect(JSON.stringify(authority).length).toBeLessThan(2_000);
    expect(Buffer.byteLength(JSON.stringify(authority), "utf8")).toBeGreaterThan(2_000);
    await expect(owned.store().admit(owned.command, authority)).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "agent_turn_authority_check" },
    });
    expect(await owned.store().getByCommand(owned.command.commandId)).toBeNull();
  } finally {
    await owned.dispose();
  }
});

test("Drizzle admission and reads stay inside the caller's native savepoint", async () => {
  const owned = await fixture();
  try {
    await owned.database.client.begin(async (transaction) => {
      await expect(
        transaction.savepoint(async (savepoint) => {
          const { turn } = await owned.store().admitIn(savepoint, owned.command, owned.authority);
          expect(
            await owned.store().getByCommand(owned.command.commandId, savepoint),
          ).toMatchObject({
            id: turn.id,
          });
          throw new Error("Rollback only the admission savepoint");
        }),
      ).rejects.toThrow("Rollback only the admission savepoint");
      expect(await owned.store().getByCommand(owned.command.commandId, transaction)).toBeNull();
      await owned.store().admitIn(transaction, owned.command, owned.authority);
    });
    expect(await owned.store().getByCommand(owned.command.commandId)).toMatchObject({
      state: "pending",
    });
  } finally {
    await owned.dispose();
  }
});

test("markRunning rolls back its product callback when the exact owner expires during persistence", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const owner = await owned.store().claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned lease required");
    await owned.store().beginDispatch(turn.id, owner.ownerToken);
    await expect(
      owned.store().markRunning(turn.id, owner.ownerToken, async (sql) => {
        await appendConversationEntry(sql, owned.command.conversationId, {
          kind: "agent-message",
          actor: "project-agent",
          mode: "investigate",
          body: "Dispatch persistence must roll back",
          payload: {},
          citations: [],
          inReplyToEntryId: null,
          requirementRevisionId: null,
        });
        await sql`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 second'
          WHERE id=${turn.id}`;
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owned.store().get(turn.id)).toMatchObject({
      state: "dispatching",
      ownerToken: owner.ownerToken,
    });
    expect(
      await owned.database.client`SELECT id FROM factory.conversation_entry
        WHERE conversation_id=${owned.command.conversationId}`,
    ).toHaveLength(0);
    expect(await owned.store().markRunning(turn.id, owner.ownerToken, async () => {})).toBe(true);
  } finally {
    await owned.dispose();
  }
});

test("expired Project inference stays uncertain and cannot acquire external recovery authority", async () => {
  const owned = await fixture();
  try {
    const { turn } = await owned.store().admit(owned.command, owned.authority);
    const owner = await owned.store().claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned lease required");
    await owned.store().beginDispatch(turn.id, owner.ownerToken);
    expect(await owned.store().quarantineExpiredProject(turn.id)).toBe(false);
    await owned.database
      .client`UPDATE factory.agent_turn SET owner_expires_at=clock_timestamp()-interval '1 second'
      WHERE id=${turn.id}`;
    expect(await owned.store().claimExternalRecovery(turn.id)).toBeNull();
    expect(await owned.store().quarantineExpiredProject(turn.id)).toBe(true);
    expect(await owned.store().quarantineExpiredProject(turn.id)).toBe(false);
    expect(await owned.store().claimPending(turn.id)).toBeNull();
    expect(await owned.store().claimExternalRecovery(turn.id)).toBeNull();
    expect(await owned.store().get(turn.id)).toMatchObject({
      state: "uncertain",
      ownerToken: null,
      ownerExpiresAt: null,
      outcomeSummary: expect.stringContaining("new explicit attempt"),
    });
    const replay = await owned.store().admit(owned.command, owned.authority);
    expect(replay).toMatchObject({ replayed: true, turn: { id: turn.id, state: "uncertain" } });
    const explicit = await owned
      .store()
      .admit({ ...owned.command, commandId: crypto.randomUUID() }, owned.authority);
    expect(explicit.turn.id).not.toBe(turn.id);
  } finally {
    await owned.dispose();
  }
});
