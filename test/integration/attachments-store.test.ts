import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { type AgentTurnRecord } from "../../apps/factory/src/agent/turn-record";
import { attachmentDigest } from "../../apps/factory/src/attachments/objects";
import {
  assertMessageAttachmentsIn,
  attachmentContextIn,
  createAttachmentStore,
  freezeAttachmentContextIn,
  freezeFeedbackAttachmentsIn,
} from "../../apps/factory/src/attachments/store";
import {
  attachmentIDs,
  attachmentMarkdown,
} from "../../packages/conversation-domain/src/attachments";
import { drizzleTransaction } from "../../packages/db/src/client";
import { attachmentReferenceCases } from "../fixtures/attachment-references";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { memoryPrivateObjects } from "../fixtures/private-objects";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
beforeAll(async () => {
  const inherited = process.env["FACTORY_TEST_POSTGRES"];
  server = inherited
    ? { identity: JSON.parse(inherited), dispose: async () => {} }
    : await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

// No application, runtime, image processing or model calls. Every proof clones
// the sealed baseline into its own disposable database on the owned server.
async function realPostgres() {
  const owned = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const client = postgres(owned.url, { max: 4 });
  const database = {
    client,
    db: drizzleTransaction(client),
    coordination: () => postgres(owned.url, { max: 1, idle_timeout: 0 }),
  };
  const userID = crypto.randomUUID(),
    otherID = crypto.randomUUID();
  const projectID = crypto.randomUUID(),
    otherProjectID = crypto.randomUUID();
  const ticketID = crypto.randomUUID();
  try {
    for (const id of [userID, otherID])
      await client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${id},'Owned attachment contributor',${`${id}@attachments.test`},true)`;
    for (const id of [projectID, otherProjectID]) {
      await client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${id},${`attachment-${id}`},'Attachment proof','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${userID})`;
      for (const user of [userID, otherID])
        await client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
          VALUES(${id},${user},'developer',${userID})`;
    }
    await client`INSERT INTO factory.ticket(id,project_id,title,created_by)
      VALUES(${ticketID},${projectID},'Attachment proof',${userID})`;
  } catch (cause) {
    await client.end({ timeout: 2 });
    await owned.dispose();
    throw cause;
  }
  const objects = memoryPrivateObjects();
  const store = createAttachmentStore(database, objects, async (bytes) => ({
    text: new TextDecoder().decode(bytes),
    previews: [],
  }));
  function input(text = "Owned reference", projectId = projectID) {
    const bytes = new TextEncoder().encode(text);
    return {
      bytes,
      file: {
        id: crypto.randomUUID(),
        projectId,
        name: "reference.txt",
        mediaType: "text/plain" as const,
        bytes: bytes.length,
        sha256: attachmentDigest(bytes),
      },
    };
  }
  async function upload(text = "Owned reference", projectId = projectID) {
    const item = input(text, projectId);
    await store.begin(userID, item.file);
    await store.upload(userID, item.file.id, item.bytes);
    return item;
  }
  return {
    database,
    userID,
    otherID,
    projectID,
    otherProjectID,
    ticketID,
    objects,
    store,
    input,
    upload,
    async dispose() {
      await client.end({ timeout: 2 });
      await owned.dispose();
    },
  };
}

test("native publication parses the feature corpus and rejects private, unpublished and cross-Project files", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  try {
    const { file } = await f.upload();
    for (const { content, ids } of attachmentReferenceCases(file.id)) {
      const target = crypto.randomUUID();
      expect(attachmentIDs(content)).toEqual(ids);
      await sql`SELECT factory.bind_attachment_references(${f.projectID},${f.userID},'ticket',${target},${content},false)`;
      const rows = await sql<
        { id: string }[]
      >`SELECT attachment_id AS id FROM factory.attachment_reference WHERE reference_id=${target}`;
      expect(
        rows.map((row) => row.id),
        content,
      ).toEqual(ids);
    }
    const pending = f.input();
    await f.store.begin(f.userID, pending.file);
    const foreign = await f.upload("Foreign reference", f.otherProjectID);
    for (const [actor, item] of [
      [f.otherID, file],
      [f.userID, pending.file],
      [f.userID, foreign.file],
    ] as const) {
      await expect(
        sql.begin(async (transaction) => {
          await transaction`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          VALUES(${crypto.randomUUID()},${f.ticketID},1,${attachmentMarkdown(item)},${attachmentDigest(new TextEncoder().encode(attachmentMarkdown(item)))},${actor})`;
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(f.store.metadata(f.otherID, file.id)).rejects.toMatchObject({ status: 404 });
    const revision = crypto.randomUUID(),
      content = attachmentMarkdown(file);
    await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
      VALUES(${revision},${f.ticketID},1,${content},${attachmentDigest(new TextEncoder().encode(content))},${f.userID})`;
    expect(await f.store.metadata(f.otherID, file.id)).toMatchObject({
      id: file.id,
      state: "ready",
    });
    expect(
      await sql`SELECT attachment_id FROM factory.attachment_reference WHERE kind='requirement' AND reference_id=${revision}`,
    ).toHaveLength(1);
    await expect(
      sql`UPDATE factory.requirement_revision SET canonical_content='rewritten' WHERE id=${revision}`,
    ).rejects.toThrow("immutable");
    for (const update of [
      sql`UPDATE factory.attachment SET owner_id=${f.otherID} WHERE id=${file.id}`,
      sql`UPDATE factory.attachment SET text_content='rewritten' WHERE id=${file.id}`,
      sql`UPDATE factory.attachment SET objects='[]'::jsonb WHERE id=${file.id}`,
      sql`UPDATE factory.attachment SET reserved_bytes=reserved_bytes+1 WHERE id=${file.id}`,
      sql`DELETE FROM factory.attachment_reference WHERE reference_id=${revision}`,
    ])
      await expect(update).rejects.toThrow("immutable");
    await sql`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.otherID}`;
    await expect(f.store.metadata(f.otherID, file.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.dispose();
  }
});

test("store intent and draft CAS retain exact identity, empty arrays and Project binding", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  try {
    const item = f.input();
    const results = await Promise.all([
      f.store.begin(f.userID, item.file),
      f.store.begin(f.userID, item.file),
    ]);
    expect(results).toEqual([results[0], results[0]]);
    expect(await sql`SELECT id FROM factory.attachment WHERE id=${item.file.id}`).toHaveLength(1);
    for (const change of [
      { name: "changed.txt" },
      { draftId: crypto.randomUUID() },
      { sha256: "f".repeat(64) },
    ])
      await expect(f.store.begin(f.userID, { ...item.file, ...change })).rejects.toMatchObject({
        status: 409,
      });
    await f.store.upload(f.userID, item.file.id, item.bytes);
    const draft = crypto.randomUUID();
    await f.store.retainDraft(f.userID, f.projectID, draft, {
      sequence: 4,
      ids: [item.file.id, item.file.id],
    });
    await f.store.retainDraft(f.userID, f.projectID, draft, { sequence: 3, ids: [] });
    await f.store.retainDraft(f.userID, f.projectID, draft, { sequence: 4, ids: [] });
    await f.store.retainDraft(f.userID, f.otherProjectID, draft, { sequence: 5, ids: [] });
    expect([
      ...(await sql`SELECT sequence::float8 AS sequence,attachment_ids AS ids,project_id AS project FROM factory.attachment_draft WHERE id=${draft}`),
    ]).toEqual([{ sequence: 4, ids: [item.file.id], project: f.projectID }]);
    await f.store.retainDraft(f.userID, f.projectID, draft, {
      sequence: Number.MAX_SAFE_INTEGER,
      ids: [],
    });
    expect([
      ...(await sql`SELECT sequence::float8 AS sequence,attachment_ids AS ids FROM factory.attachment_draft WHERE id=${draft}`),
    ]).toEqual([{ sequence: Number.MAX_SAFE_INTEGER, ids: [] }]);
    await f.store.retainDraft(f.userID, f.projectID, f.ticketID, {
      sequence: 1,
      ids: [item.file.id],
    });
    expect(await sql`SELECT id FROM factory.attachment_draft WHERE id=${f.ticketID}`).toHaveLength(
      0,
    );
    await sql.begin((transaction) =>
      assertMessageAttachmentsIn(transaction, f.projectID, f.userID, attachmentMarkdown(item.file)),
    );
    await expect(
      sql.begin((transaction) =>
        assertMessageAttachmentsIn(
          transaction,
          f.otherProjectID,
          f.userID,
          attachmentMarkdown(item.file),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.store.usage(f.projectID, f.userID)).usedBytes).toBe(item.bytes.length * 2);
  } finally {
    await f.dispose();
  }
});

test("upload claims, recorded manifests and revocation fence conversion and storage publication", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let conversions = 0,
    rejectWrite = true;
  const store = createAttachmentStore(
    f.database,
    {
      ...f.objects,
      async put(key, bytes, mediaType) {
        const [intent] = await sql<
          { objects: Array<{ key: string }> }[]
        >`SELECT objects FROM factory.attachment WHERE id=${item.file.id}`;
        expect(intent?.objects.some((part) => part.key === key)).toBe(true);
        if (rejectWrite) throw new Error("Owned storage outage");
        await f.objects.put(key, bytes, mediaType);
      },
    },
    async (bytes) => {
      conversions++;
      entered.resolve();
      await release.promise;
      return {
        text: new TextDecoder().decode(bytes),
        previews: [{ name: "Owned preview", mediaType: "image/jpeg", data: new Uint8Array([42]) }],
      };
    },
  );
  const item = f.input("Fenced reference");
  try {
    await store.begin(f.userID, item.file);
    const pending = store.upload(f.userID, item.file.id, item.bytes).then(
      () => null,
      (cause: unknown) => cause,
    );
    await entered.promise;
    await expect(store.upload(f.userID, item.file.id, item.bytes)).rejects.toMatchObject({
      status: 409,
    });
    expect(conversions).toBe(1);
    await sql`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    release.resolve();
    expect(await pending).toMatchObject({ status: 404 });
    expect(f.objects.blobs.size).toBe(0);
    await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${f.projectID},${f.userID},'developer',${f.userID})`;
    await expect(store.upload(f.userID, item.file.id, item.bytes)).rejects.toMatchObject({
      status: 409,
    });
    const [failed] = await sql<
      { objects: unknown[]; text_content: string; upload_token: string | null }[]
    >`SELECT objects,text_content,upload_token FROM factory.attachment WHERE id=${item.file.id}`;
    expect(failed?.objects).toHaveLength(2);
    expect(failed?.upload_token).toBeNull();
    const changed = createAttachmentStore(f.database, f.objects, async () => ({
      text: "Changed conversion",
      previews: [],
    }));
    await expect(changed.upload(f.userID, item.file.id, item.bytes)).rejects.toThrow(
      "different recorded processing result",
    );
    rejectWrite = false;
    expect(await store.upload(f.userID, item.file.id, item.bytes)).toMatchObject({
      state: "ready",
      pages: 1,
    });
    expect(f.objects.blobs.size).toBe(2);
    expect(await (await store.read(f.userID, item.file.id)).text()).toBe("Fenced reference");
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("publication rejects expired or reclaimed upload leases without clearing another publisher's token", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  try {
    for (const mode of ["expired", "reclaimed"] as const) {
      const item = f.input(mode),
        replacement = crypto.randomUUID();
      const store = createAttachmentStore(
        f.database,
        {
          ...f.objects,
          async put(key, bytes, mediaType) {
            await f.objects.put(key, bytes, mediaType);
            if (mode === "expired")
              await sql`UPDATE factory.attachment SET upload_expires_at=clock_timestamp()-interval '1 second' WHERE id=${item.file.id}`;
            else
              await sql`UPDATE factory.attachment SET upload_token=${replacement},upload_expires_at=clock_timestamp()+interval '90 seconds' WHERE id=${item.file.id}`;
          },
        },
        async () => ({ text: "", previews: [] }),
      );
      await store.begin(f.userID, item.file);
      await expect(store.upload(f.userID, item.file.id, item.bytes)).rejects.toThrow(
        "publication is no longer current",
      );
      const [row] =
        await sql`SELECT state,upload_token,completed_at FROM factory.attachment WHERE id=${item.file.id}`;
      expect(row).toMatchObject({
        state: mode === "expired" ? "failed" : "uploading",
        upload_token: mode === "expired" ? null : replacement,
        completed_at: null,
      });
    }
  } finally {
    await f.dispose();
  }
});

test("a protected read rechecks SQL authority after object I/O without holding a revocation lock", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  try {
    const { file } = await f.upload("Recheck after object I/O");
    const store = createAttachmentStore(f.database, {
      ...f.objects,
      async read(key) {
        const bytes = await f.objects.read(key);
        await sql`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
        return bytes;
      },
    });
    await expect(store.read(f.userID, file.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.dispose();
  }
});

test("sweep retains native references, drafts and active leases and accounts uncertain deletion until retry", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  let rejectDelete = true;
  try {
    const retained = await f.upload("Draft"),
      published = await f.upload("Published"),
      deleted = await f.upload("Delete");
    const leased = f.input("Lease");
    await f.store.begin(f.userID, leased.file);
    await f.store.retainDraft(f.userID, f.projectID, crypto.randomUUID(), {
      sequence: 1,
      ids: [retained.file.id],
    });
    await sql`SELECT factory.bind_attachment_references(${f.projectID},${f.userID},'ticket',${f.ticketID},${attachmentMarkdown(published.file)},true)`;
    await sql`UPDATE factory.attachment SET created_at=now()-interval '2 days'`;
    await sql`UPDATE factory.attachment SET upload_token=${crypto.randomUUID()},upload_expires_at=now()+interval '1 day' WHERE id=${leased.file.id}`;
    const store = createAttachmentStore(f.database, {
      ...f.objects,
      async remove(key) {
        if (rejectDelete) throw new Error("Owned uncertain deletion");
        await f.objects.remove(key);
      },
    });
    const before = (await store.usage(f.projectID, f.userID)).usedBytes;
    await expect(store.sweep()).rejects.toThrow("Owned uncertain deletion");
    expect((await store.usage(f.projectID, f.userID)).usedBytes).toBe(before);
    expect(
      await sql`SELECT id FROM factory.attachment WHERE id=${deleted.file.id} AND state='deleting'`,
    ).toHaveLength(1);
    rejectDelete = false;
    await store.sweep();
    expect((await store.usage(f.projectID, f.userID)).usedBytes).toBe(
      before - deleted.bytes.length * 2,
    );
    expect(await store.metadata(f.userID, retained.file.id)).toMatchObject({ state: "ready" });
    expect(await store.metadata(f.userID, published.file.id)).toMatchObject({ state: "ready" });
    expect(await store.metadata(f.userID, leased.file.id)).toMatchObject({ state: "uploading" });
    await expect(store.metadata(f.userID, deleted.file.id)).rejects.toMatchObject({ status: 404 });
    expect(f.objects.blobs.size).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("attachment context pins authored sources to the exact turn and feedback source without sharing private conversation files", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  try {
    const first = await f.upload("First reference"),
      later = await f.upload("Later reference"),
      isolated = await f.upload("Another private context"),
      assistant = await f.upload("Assistant reference");
    const conversationID = crypto.randomUUID(),
      contextID = crypto.randomUUID();
    await sql`INSERT INTO factory.ticket_conversation(id,project_id,created_by) VALUES(${conversationID},${f.projectID},${f.userID})`;
    const record: AgentTurnRecord = {
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      state: "pending",
      ownerToken: null,
      ownerExpiresAt: null,
      outcomeSummary: null,
      command: {
        kind: "project-message",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        createdBy: f.userID,
        ticketId: null,
        conversationId: conversationID,
        contextId: contextID,
        text: `Read the first reference.\n${attachmentMarkdown(first.file)}`,
      },
      authority: {
        mode: "investigate",
        conversationVersion: 1,
        modelId: "no-model-call",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
      },
    };
    await sql`INSERT INTO factory.agent_turn(id,command_id,project_id,conversation_id,created_by,input,input_digest,authority)
      VALUES(${record.id},${record.commandId},${f.projectID},${conversationID},${f.userID},${JSON.stringify(record.command)}::jsonb,${"a".repeat(64)},${JSON.stringify(record.authority)}::jsonb)`;
    await expect(
      sql.begin(async (transaction) => {
        await freezeAttachmentContextIn(transaction, record);
        throw new Error("Owned admission rollback");
      }),
    ).rejects.toThrow("Owned admission rollback");
    expect(
      await sql`SELECT turn_id FROM factory.attachment_turn_context WHERE turn_id=${record.id}`,
    ).toHaveLength(0);
    expect(
      await sql`SELECT attachment_id FROM factory.attachment_reference WHERE reference_id=${record.id}`,
    ).toHaveLength(0);
    await sql.begin((transaction) => freezeAttachmentContextIn(transaction, record));
    const before = await sql.begin((transaction) => attachmentContextIn(transaction, record.id));
    await sql`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
      VALUES(${crypto.randomUUID()},${conversationID},1,'user-message','user','investigate',${attachmentMarkdown(later.file)},${JSON.stringify({ contextId: contextID })}::jsonb,${f.userID})`;
    for (const [ordinal, actor, file, context] of [
      [2, "user", isolated.file, crypto.randomUUID()],
      [3, "project-agent", assistant.file, contextID],
      [4, "user", isolated.file, null],
    ] as const)
      await sql`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
        VALUES(${crypto.randomUUID()},${conversationID},${ordinal},'user-message',${actor},'investigate',
          ${attachmentMarkdown(file)},${JSON.stringify({ contextId: context })}::jsonb,${f.userID})`;
    expect(await sql.begin((transaction) => attachmentContextIn(transaction, record.id))).toBe(
      before,
    );
    expect(before).toContain(first.file.id);
    expect(before).not.toContain(later.file.id);
    if (record.command.kind !== "project-message")
      throw Error("Owned conversation request missing");
    const next: AgentTurnRecord = {
      ...record,
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      command: { ...record.command, text: "Read the selected private context." },
    };
    await sql`UPDATE factory.agent_turn SET state='stopped' WHERE id=${record.id}`;
    await sql`INSERT INTO factory.agent_turn(id,command_id,project_id,conversation_id,created_by,input,input_digest,authority)
      VALUES(${next.id},${next.commandId},${f.projectID},${conversationID},${f.userID},${JSON.stringify(next.command)}::jsonb,${"b".repeat(64)},${JSON.stringify(next.authority)}::jsonb)`;
    await sql.begin((transaction) => freezeAttachmentContextIn(transaction, next));
    const selected = await sql.begin((transaction) => attachmentContextIn(transaction, next.id));
    expect(selected).toContain(later.file.id);
    expect(selected).not.toContain(first.file.id);
    expect(selected).not.toContain(isolated.file.id);
    expect(selected).not.toContain(assistant.file.id);
    expect(await sql`SELECT id FROM factory.agent_turn`).toHaveLength(2);
    expect(
      await sql`SELECT attachment_id FROM factory.attachment_reference WHERE reference_id=${next.id} AND shared`,
    ).toHaveLength(0);
    await expect(f.store.metadata(f.otherID, first.file.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.store.metadata(f.otherID, later.file.id)).rejects.toMatchObject({ status: 404 });
    await sql.begin(async (transaction) => {
      await freezeFeedbackAttachmentsIn(transaction, record.id, f.projectID, f.userID, [
        { body: attachmentMarkdown(later.file) },
      ]);
      await freezeFeedbackAttachmentsIn(transaction, record.id, f.projectID, f.userID, [
        { body: attachmentMarkdown(first.file) },
      ]);
    });
    const [feedback] = await sql<
      { content: string }[]
    >`SELECT content FROM factory.attachment_turn_context WHERE turn_id=${record.id} AND source='feedback'`;
    expect(feedback?.content).toContain(later.file.id);
    expect(feedback?.content).not.toContain(first.file.id);
    await expect(
      sql`UPDATE factory.attachment_turn_context SET content='rewritten' WHERE turn_id=${record.id}`,
    ).rejects.toThrow("immutable");
  } finally {
    await f.dispose();
  }
});

test("Build context reads the approved requirement revision rather than the latest document", async () => {
  const f = await realPostgres();
  const sql = f.database.client;
  try {
    const approved = await f.upload("Approved requirement"),
      newer = await f.upload("Unapproved edit");
    const requirementID = crypto.randomUUID(),
      newerRequirementID = crypto.randomUUID(),
      approvalID = crypto.randomUUID(),
      changeID = crypto.randomUUID();
    for (const [ordinal, id, file] of [
      [1, requirementID, approved.file],
      [2, newerRequirementID, newer.file],
    ] as const) {
      const content = attachmentMarkdown(file);
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${id},${f.ticketID},${ordinal},${content},${attachmentDigest(new TextEncoder().encode(content))},${f.userID})`;
    }
    await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
      VALUES(${approvalID},${f.ticketID},${requirementID},${f.userID})`;
    await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
      VALUES(${changeID},${f.projectID},${f.ticketID},${approvalID},'factory/change-0123456789ab',${"a".repeat(40)},'branch-pending',${f.userID})`;
    const latest = attachmentMarkdown(newer.file);
    await sql`INSERT INTO factory.ticket_document_revision(id,ticket_id,ordinal,title,description,canonical_content,content_digest,input_digest,created_by)
      VALUES(${crypto.randomUUID()},${f.ticketID},1,'Unapproved edit','',${latest},${attachmentDigest(new TextEncoder().encode(latest))},${"b".repeat(64)},${f.userID})`;
    const conversationID = crypto.randomUUID();
    await sql`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by)
      VALUES(${conversationID},${f.projectID},${f.ticketID},${f.userID})`;
    for (const [ordinal, actor, file, payload] of [
      [1, "user", approved.file, {}],
      [2, "user", newer.file, { contextId: crypto.randomUUID() }],
      [3, "project-agent", newer.file, {}],
    ] as const)
      await sql`INSERT INTO factory.conversation_entry(id,conversation_id,ordinal,kind,actor,mode,body,payload,created_by)
        VALUES(${crypto.randomUUID()},${conversationID},${ordinal},'user-message',${actor},'build',
          ${attachmentMarkdown(file)},${JSON.stringify(payload)}::jsonb,${f.userID})`;
    const record: AgentTurnRecord = {
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      state: "pending",
      ownerToken: null,
      ownerExpiresAt: null,
      outcomeSummary: null,
      command: {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        createdBy: f.userID,
        ticketId: f.ticketID,
        conversationId: null,
        changeId: changeID,
        text: "Inspect the pinned requirement and the selected human Ticket chat.",
      },
      authority: {
        mode: "build",
        conversationVersion: null,
        requirementRevisionId: requirementID,
        modelId: "no-model-call",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
      },
    };
    await sql`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority)
      VALUES(${record.id},${record.commandId},${f.projectID},${f.ticketID},${changeID},${f.userID},${JSON.stringify(record.command)}::jsonb,${"a".repeat(64)},${JSON.stringify(record.authority)}::jsonb)`;
    await sql.begin((transaction) => freezeAttachmentContextIn(transaction, record));
    const frozen = await sql.begin((transaction) => attachmentContextIn(transaction, record.id));
    expect(frozen).toContain(approved.file.id);
    expect(frozen).toContain("Human Ticket chat, preserve its meaning");
    expect(frozen).not.toContain(newer.file.id);
    // Stop the undispatched fixture turn through its native transition guard.
    await sql`UPDATE factory.agent_turn SET state='stopped' WHERE id=${record.id}`;
    await expect(sql`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority)
      VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${f.projectID},${f.ticketID},${changeID},${f.userID},${JSON.stringify(record.command)}::jsonb,${"b".repeat(64)},${JSON.stringify({ ...record.authority, requirementRevisionId: newerRequirementID })}::jsonb)`).rejects.toThrow(
      "Agent Turn Change scope mismatch",
    );
    const followup: AgentTurnRecord = {
      ...record,
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      command: {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        createdBy: f.userID,
        ticketId: f.ticketID,
        conversationId: null,
        changeId: changeID,
        text: `Compare the new reference.\n${attachmentMarkdown(newer.file)}`,
      },
    };
    await sql`INSERT INTO factory.agent_turn(id,command_id,project_id,ticket_id,change_id,created_by,input,input_digest,authority)
      VALUES(${followup.id},${followup.commandId},${f.projectID},${f.ticketID},${changeID},${f.userID},${JSON.stringify(followup.command)}::jsonb,${"b".repeat(64)},${JSON.stringify(followup.authority)}::jsonb)`;
    await sql.begin((transaction) => freezeAttachmentContextIn(transaction, followup));
    const continued = await sql.begin((transaction) =>
      attachmentContextIn(transaction, followup.id),
    );
    expect(continued).toContain(approved.file.id);
    expect(continued).toContain(newer.file.id);
    expect(await sql.begin((transaction) => attachmentContextIn(transaction, record.id))).toBe(
      frozen,
    );
  } finally {
    await f.dispose();
  }
});
