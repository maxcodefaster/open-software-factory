import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createReviewAdmission } from "../../apps/factory/src/agent/review-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import {
  type AttachmentObjects,
  attachmentDigest,
} from "../../apps/factory/src/attachments/objects";
import {
  attachmentContextIn,
  createAttachmentStore,
} from "../../apps/factory/src/attachments/store";
import { createAttachmentTools } from "../../apps/factory/src/attachments/tools";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { attachmentMarkdown } from "../../packages/conversation-domain/src/attachments";
import { ownedBrowserJPEG } from "../fixtures/browser-image";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import { createAttachmentRoutes } from "../../apps/factory/src/attachments/routes";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

function memoryObjects() {
  const blobs = new Map<string, Uint8Array>();
  const objects: AttachmentObjects = {
    async put(key, bytes) {
      blobs.set(key, new Uint8Array(bytes));
    },
    async read(key) {
      const bytes = blobs.get(key);
      if (!bytes) throw new Error("Owned object absent");
      return bytes;
    },
    async remove(key) {
      blobs.delete(key);
    },
  };
  return { blobs, objects };
}

test("native Attachment functions preserve private upload identity, draft sequence, publication and current SQL authority", async () => {
  const f = await fixture();
  const other = crypto.randomUUID(),
    draft = crypto.randomUUID(),
    id = crypto.randomUUID();
  const bytes = new TextEncoder().encode("Native private reference");
  const memory = memoryObjects();
  const store = createAttachmentStore(f.database, memory.objects, async (data) => ({
    text: new TextDecoder().decode(data),
    previews: [],
  }));
  const origin = "https://owned-attachments.test";
  const endpoint = await compiledFactoryEndpoint({
    origin,
    services: { attachments: store } as unknown as FactoryServices,
    session: async (request) => {
      const actor = request.headers.get("x-owned-actor");
      return actor === other || actor === f.userID ? { user: { id: actor } } : null;
    },
    maintenance: async () => false,
    requireFresh: async () => {},
  });
  async function native(name: string, args: unknown[], actor = f.userID) {
    const response = await endpoint(
      await factoryFunctionRequest(origin, name, args, { "x-owned-actor": actor }),
    );
    const result = await decodeResponse<ServerResult<unknown>>(response);
    if (!result) throw new Error("Owned Attachment function returned no result");
    return serverCall(Promise.resolve(result));
  }
  try {
    await f.database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${other},'Other attachment reader',${`${other}@owned-attachment.test`},true)`;
    await f.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${f.projectID},${other},'product-contributor',${f.userID})`;
    const input = {
      id,
      projectId: f.projectID,
      draftId: draft,
      name: "native.txt",
      mediaType: "text/plain",
      bytes: bytes.byteLength,
      sha256: attachmentDigest(bytes),
    };
    expect(await native("beginAttachment", [input])).toMatchObject({ id, state: "uploading" });
    expect(await native("beginAttachment", [input])).toMatchObject({ id, sha256: input.sha256 });
    await expect(
      native("beginAttachment", [{ ...input, name: "changed.txt" }]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(native("getAttachmentMetadata", [id], other)).rejects.toMatchObject({
      status: 404,
    });
    const upload = await createAttachmentRoutes(store)(
      new Request(`${origin}/api/attachments/${id}`, {
        method: "PUT",
        body: bytes,
      }),
      f.userID,
    );
    expect(await fixtureValue(upload, "upload").json()).toMatchObject({ id, state: "ready" });
    await native("retainAttachmentDraft", [f.projectID, draft, { sequence: 3, ids: [id] }]);
    await native("retainAttachmentDraft", [f.projectID, draft, { sequence: 2, ids: [] }]);
    const [retained] = await f.database.client<{ sequence: number; ids: string[] }[]>`
      SELECT sequence::float8 AS sequence,attachment_ids AS ids FROM factory.attachment_draft
      WHERE id=${draft} AND owner_id=${f.userID}`;
    expect(retained).toEqual({ sequence: 3, ids: [id] });
    expect(await native("getAttachmentUsage", [f.projectID])).toMatchObject({
      usedBytes: bytes.byteLength * 2,
    });
    await f.database.client`SELECT factory.bind_attachment_references(
      ${f.projectID},${f.userID},'ticket',${f.ticketID},${attachmentMarkdown(input)},true)`;
    expect(await native("getAttachmentMetadata", [id], other)).toMatchObject({
      id,
      state: "ready",
    });
    await f.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${other}`;
    await expect(native("getAttachmentMetadata", [id], other)).rejects.toMatchObject({
      status: 404,
    });
    await expect(native("getAttachmentUsage", [f.projectID], other)).rejects.toMatchObject({
      status: 404,
    });
    expect(await native("getAttachmentMetadata", [id])).toMatchObject({ id, sha256: input.sha256 });
  } finally {
    await f.dispose();
  }
});

test("private uploads, publication, exact Build snapshots and retained history use real PostgreSQL", async () => {
  const owned = await fixture();
  const bytes = new TextEncoder().encode("The required confirmation code is 7319.");
  const blobs = new Map<string, Uint8Array>();
  const objects: AttachmentObjects = {
    async put(key, data) {
      blobs.set(key, new Uint8Array(data));
    },
    async read(key) {
      const data = blobs.get(key);
      if (!data) throw new Error("Missing owned test object");
      return data;
    },
    async remove(key) {
      blobs.delete(key);
    },
  };
  const store = createAttachmentStore(owned.database, objects, async (data) => ({
    text: new TextDecoder().decode(data),
    previews: [],
  }));
  const otherUser = crypto.randomUUID();
  try {
    await owned.database
      .client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${otherUser},'Other contributor',${`${otherUser}@factory.local`},true)`;
    await owned.database
      .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${owned.projectID},${otherUser},'product-contributor',${owned.userID})`;
    const input = {
      id: crypto.randomUUID(),
      projectId: owned.projectID,
      name: "reference.txt",
      mediaType: "text/plain" as const,
      bytes: bytes.byteLength,
      sha256: attachmentDigest(bytes),
    };
    await store.begin(owned.userID, input);
    await owned.database.client`SELECT factory.bind_attachment_references(
      ${owned.projectID},${owned.userID},'ticket',${owned.ticketID},
      ${`\`/api/attachments/${input.id}\`\n\n\`\`\`md\n![Example](/api/attachments/${crypto.randomUUID()})\n\`\`\``},true)`;
    await expect(store.metadata(otherUser, input.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      store.begin(owned.userID, { ...input, sha256: "f".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(store.upload(owned.userID, input.id, new Uint8Array([1]))).rejects.toMatchObject({
      status: 409,
    });
    expect((await store.upload(owned.userID, input.id, bytes)).state).toBe("ready");
    expect((await store.upload(owned.userID, input.id, bytes)).sha256).toBe(input.sha256);
    await expect(store.read(otherUser, input.id)).rejects.toMatchObject({ status: 404 });
    const url = attachmentMarkdown({ ...input });
    await owned.database.client.begin(async (sql) => {
      await sql`SELECT factory.bind_attachment_references(${owned.projectID},${owned.userID},'ticket',${owned.ticketID},${url},true)`;
      await sql`UPDATE factory.ticket SET description=${url} WHERE id=${owned.ticketID}`;
    });
    expect(await (await store.read(otherUser, input.id)).text()).toContain("7319");
    const chatInput = { ...input, id: crypto.randomUUID(), name: "chat-reference.txt" };
    await store.begin(owned.userID, chatInput);
    await store.upload(owned.userID, chatInput.id, bytes);
    await expect(store.read(otherUser, chatInput.id)).rejects.toMatchObject({ status: 404 });
    const admission = createChangeAdmission(owned.database, buildModelID);
    const command = {
      kind: "change-prompt" as const,
      commandId: crypto.randomUUID(),
      text: `Explain the reference without changing source.\n\n${attachmentMarkdown(chatInput)}`,
    };
    const admitted = await admission.admit(owned.changeID, owned.userID, command);
    expect(await (await store.read(otherUser, chatInput.id)).text()).toContain("7319");
    const context = await owned.database.client.begin((sql) =>
      attachmentContextIn(sql, admitted.turn.id),
    );
    expect(context).toContain(input.sha256);
    expect(context).toContain(input.id);
    expect(context).toContain(chatInput.id);
    const intent = await admission.intent(admitted.turn.id);
    expect(intent.text).toContain("attachment_read");
    await owned.database
      .client`UPDATE factory.ticket SET description='' WHERE id=${owned.ticketID}`;
    expect((await admission.admit(owned.changeID, owned.userID, command)).replayed).toBe(true);
    expect((await admission.intent(admitted.turn.id)).text).toBe(intent.text);
    const turns = createAgentTurnStore(owned.database);
    const owner = await turns.claimPending(admitted.turn.id);
    if (!owner?.ownerToken) throw new Error("Owned attachment turn lease missing");
    await owned.writers.prepareAgent(owned.changeID, owner.id);
    await turns.beginDispatch(owner.id, owner.ownerToken);
    await turns.settle(owner.id, owner.ownerToken, "completed", "Owned reference inspection");
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${owned.changeID}`;
    const followup = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Continue with the same reference.",
    });
    const continuedContext = await owned.database.client.begin((sql) =>
      attachmentContextIn(sql, followup.turn.id),
    );
    expect(continuedContext).toContain(input.id);
    expect(continuedContext).toContain(chatInput.id);
    expect(continuedContext).toContain("Explain the reference without changing source.");
    expect(await (await store.read(otherUser, input.id)).text()).toContain("7319");
    await expect(
      Promise.resolve(
        owned.database
          .client`UPDATE factory.attachment SET sha256=${"f".repeat(64)} WHERE id=${input.id}`,
      ),
    ).rejects.toThrow("immutable");
    await owned.database
      .client`UPDATE factory.attachment SET created_at=now()-interval '2 days' WHERE id=${input.id}`;
    await store.sweep();
    expect((await store.metadata(owned.userID, input.id)).state).toBe("ready");
    expect((await store.usage(owned.projectID, owned.userID)).usedBytes).toBe(bytes.byteLength * 4);
    const originalLimit = process.env["FACTORY_ATTACHMENT_FILE_BYTES"];
    try {
      process.env["FACTORY_ATTACHMENT_FILE_BYTES"] = "1";
      const reduced = createAttachmentStore(owned.database, objects);
      expect(await (await reduced.read(otherUser, input.id)).text()).toContain("7319");
      await expect(
        reduced.begin(owned.userID, { ...input, id: crypto.randomUUID() }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await reduced.metadata(owned.userID, input.id)).state).toBe("ready");
    } finally {
      if (originalLimit === undefined) delete process.env["FACTORY_ATTACHMENT_FILE_BYTES"];
      else process.env["FACTORY_ATTACHMENT_FILE_BYTES"] = originalLimit;
    }
    await owned.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${owned.projectID} AND user_id=${otherUser}`;
    await expect(store.read(otherUser, input.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    await owned.dispose();
  }
});

test("feedback files and their human meaning reach only the selected correction and its independent review", async () => {
  const f = await candidateReviewFixture();
  const memory = memoryObjects();
  const jpeg = new Uint8Array(Buffer.from(ownedBrowserJPEG, "base64"));
  const store = createAttachmentStore(f.database, memory.objects, async () => ({
    text: "",
    previews: [{ name: "Image", mediaType: "image/jpeg", data: jpeg }],
  }));
  try {
    const input = {
      id: crypto.randomUUID(),
      projectId: f.projectID,
      name: "negative-example.jpg",
      mediaType: "image/jpeg" as const,
      bytes: jpeg.length,
      sha256: attachmentDigest(jpeg),
    };
    await store.begin(f.userID, input);
    await store.upload(f.userID, input.id, jpeg);
    const review = createVisualReviewController(f.database);
    const thread = await review.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: `Do NOT copy this negative example.\n\n${attachmentMarkdown(input)}`,
    });
    const view = await review.get(f.changeID, f.userID);
    const admission = createChangeAdmission(f.database, buildModelID);
    const correction = await review.dispatch(
      f.changeID,
      f.userID,
      {
        commandId: crypto.randomUUID(),
        feedback: [
          {
            id: fixtureValue(thread.feedbackId, "thread.feedbackId"),
            version: fixtureValue(view.feedback[0], "view.feedback[0]").version,
          },
        ],
      },
      async (sql, text, commandId) =>
        (
          await admission.admitIn(sql, f.changeID, f.userID, {
            kind: "change-prompt",
            commandId,
            text,
          })
        ).turn.id,
    );
    const owner = await f.turns.claimPending(fixtureValue(correction.turnId, "correction.turnId"));
    if (!owner?.ownerToken) throw new Error("Owned correction lease missing");
    await f.writers.prepareAgent(f.changeID, owner.id);
    await f.database
      .client`UPDATE factory.change_agent_session SET active_turn_id=${owner.id},state='starting' WHERE change_id=${f.changeID}`;
    await f.turns.beginDispatch(owner.id, owner.ownerToken);
    const tools = createAttachmentTools(f.database, store);
    const listed = await tools.call(owner.id, owner.ownerToken, {
      name: "attachment_list",
      arguments: {},
    });
    expect(
      listed.content[0]?.type === "text" ? JSON.parse(listed.content[0].text).context : "",
    ).toContain("Do NOT copy this negative example.");
    const result = await tools.call(owner.id, owner.ownerToken, {
      name: "attachment_read",
      arguments: { id: input.id },
    });
    expect(
      result.content.some((part) => part.type === "image" && part.data === ownedBrowserJPEG),
    ).toBe(true);
    expect((await admission.intent(owner.id)).text).toContain("Do NOT copy this negative example.");
    await expect(
      tools.call(owner.id, owner.ownerToken, {
        name: "attachment_read",
        arguments: { id: crypto.randomUUID() },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await f.turns.settle(
      owner.id,
      owner.ownerToken,
      "completed",
      "Owned correction reference inspection",
    );
    await f.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    const followup = await admission.admit(f.changeID, f.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: "Finish the same correction without changing the reference.",
    });
    const producer = await f.turns.claimPending(followup.turn.id);
    if (!producer?.ownerToken) throw new Error("Owned correction follow-up lease missing");
    await f.writers.prepareAgent(f.changeID, producer.id);
    await f.turns.beginDispatch(producer.id, producer.ownerToken);
    expect((await admission.intent(producer.id)).text).toContain(
      "Do NOT copy this negative example.",
    );
    expect(
      (
        await tools.call(producer.id, producer.ownerToken, {
          name: "attachment_read",
          arguments: { id: input.id },
        })
      ).content.some((part) => part.type === "image"),
    ).toBe(true);
    await f.turns.settle(
      producer.id,
      producer.ownerToken,
      "completed",
      "Owned correction follow-up completed",
    );
    await f.database
      .client`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
    const commit = "e".repeat(40),
      verificationID = crypto.randomUUID(),
      reviewID = crypto.randomUUID();
    await f.database.client`INSERT INTO factory.change_commit_operation(
      id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,commit_sha,observed_remote_sha,
      commit_message,idempotency_key,state,created_by,completed_at)
      SELECT ${producer.id},id,runtime_attempt_id,2,branch_name,${f.commit},${commit},${commit},
        'Owned corrected candidate',${crypto.randomUUID()},'succeeded',created_by,now()
      FROM factory.change WHERE id=${f.changeID}`;
    await f.database
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,
      action_run_id,created_by,state,summary,completed_at)
      VALUES(${verificationID},${f.changeID},${commit},2,'owned-attachment-review',2,${f.userID},'succeeded','Owned exact CI',now())`;
    await f.database
      .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by)
      VALUES(${reviewID},${verificationID},${f.changeID},${commit},${"a".repeat(40)},${f.userID})`;
    const later = { ...input, id: crypto.randomUUID(), name: "later-uncommissioned-reference.jpg" };
    await store.begin(f.userID, later);
    await store.upload(f.userID, later.id, jpeg);
    const laterBody = attachmentMarkdown(later);
    await f.database.client.begin(async (sql) => {
      await sql`SELECT factory.bind_attachment_references(${f.projectID},${f.userID},'ticket',${f.ticketID},${laterBody},true)`;
      await sql`UPDATE factory.ticket SET description=${laterBody} WHERE id=${f.ticketID}`;
    });
    const reviewTurn = await createReviewAdmission(f.database)(f.changeID, reviewID, f.userID);
    const independent = await f.turns.claimPending(reviewTurn.turn.id);
    if (!independent?.ownerToken) throw new Error("Owned independent attachment lease missing");
    await f.writers.prepareAgent(f.changeID, independent.id);
    await f.turns.beginDispatch(independent.id, independent.ownerToken);
    expect((await admission.intent(independent.id)).text).toContain(
      "Do NOT copy this negative example.",
    );
    expect(
      (
        await tools.call(independent.id, independent.ownerToken, {
          name: "attachment_read",
          arguments: { id: input.id },
        })
      ).content.some((part) => part.type === "image"),
    ).toBe(true);
    expect((await admission.intent(independent.id)).text).not.toContain(later.id);
    await expect(
      tools.call(independent.id, independent.ownerToken, {
        name: "attachment_read",
        arguments: { id: later.id },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await f.turns.settle(
      independent.id,
      independent.ownerToken,
      "completed",
      "Owned read-only attachment inspection",
    );
    await expect(
      tools.call(independent.id, independent.ownerToken, {
        name: "attachment_list",
        arguments: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await f.dispose();
  }
});

test("cumulative storage does not block concurrent uploads and cleanup retains drafts and uncertain bytes", async () => {
  const f = await fixture();
  const memory = memoryObjects();
  let failDelete = false;
  const store = createAttachmentStore(
    f.database,
    {
      ...memory.objects,
      async remove(key) {
        if (failDelete) throw new Error("Injected uncertain deletion");
        await memory.objects.remove(key);
      },
    },
    async () => ({ text: "", previews: [] }),
  );
  const make = (size: number) => {
    const bytes = new Uint8Array(size).fill(65);
    return {
      bytes,
      input: {
        id: crypto.randomUUID(),
        projectId: f.projectID,
        name: "reference.txt",
        mediaType: "text/plain" as const,
        bytes: size,
        sha256: attachmentDigest(bytes),
      },
    };
  };
  try {
    // Existing, unexpired upload intents exceed both former cumulative caps
    // without allocating gigabytes or writing objects that this fixture does not own.
    const historicalBytes = 256 * store.limits.fileBytes;
    await f.database.client`INSERT INTO factory.attachment(
      id,project_id,owner_id,name,media_type,sha256,byte_length,reserved_bytes,state)
      SELECT gen_random_uuid(),${f.projectID},${f.userID},'existing-upload.txt','text/plain',
        ${"a".repeat(64)},${store.limits.fileBytes},${store.limits.fileBytes},'uploading'
      FROM generate_series(1,256)`;
    const retained = make(60);
    await store.begin(f.userID, retained.input);
    await store.upload(f.userID, retained.input.id, retained.bytes);
    const draft = crypto.randomUUID();
    await store.retainDraft(f.userID, f.projectID, draft, {
      sequence: 2,
      ids: [retained.input.id],
    });
    await store.retainDraft(f.userID, f.projectID, draft, { sequence: 1, ids: [] });
    const contenders = [make(30), make(30)];
    const outcomes = await Promise.allSettled(
      contenders.map((item) => store.begin(f.userID, item.input)),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect((await store.usage(f.projectID, f.userID)).usedBytes).toBe(historicalBytes + 120);
    await f.database.client`UPDATE factory.attachment SET created_at=now()-interval '2 days'
        WHERE id IN ${f.database.client([retained.input.id, ...contenders.map((item) => item.input.id)])}`;
    await store.sweep();
    expect((await store.usage(f.projectID, f.userID)).usedBytes).toBe(historicalBytes + 60);
    expect((await store.metadata(f.userID, retained.input.id)).state).toBe("ready");
    await store.retainDraft(f.userID, f.projectID, draft, { sequence: 3, ids: [] });
    failDelete = true;
    await expect(store.sweep()).rejects.toThrow("uncertain deletion");
    expect((await store.usage(f.projectID, f.userID)).usedBytes).toBe(historicalBytes + 60);
    failDelete = false;
    await store.sweep();
    expect((await store.usage(f.projectID, f.userID)).usedBytes).toBe(historicalBytes);
  } finally {
    await f.dispose();
  }
});

test("concurrent upload claims serialize and authority loss fences both external writes and completed reads", async () => {
  const f = await fixture();
  const memory = memoryObjects();
  const processing = Promise.withResolvers<void>(),
    processed = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>(),
    read = Promise.withResolvers<void>();
  let conversions = 0,
    blockRead = false;
  const bytes = new TextEncoder().encode("Fenced human reference");
  const input = {
    id: crypto.randomUUID(),
    projectId: f.projectID,
    name: "reference.txt",
    mediaType: "text/plain" as const,
    bytes: bytes.length,
    sha256: attachmentDigest(bytes),
  };
  const store = createAttachmentStore(
    f.database,
    {
      ...memory.objects,
      async read(key) {
        if (blockRead) {
          reading.resolve();
          await read.promise;
        }
        return memory.objects.read(key);
      },
    },
    async (data) => {
      conversions++;
      processing.resolve();
      await processed.promise;
      return { text: new TextDecoder().decode(data), previews: [] };
    },
  );
  const revoke = () =>
    f.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
  const restore = () => f.database
    .client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
    VALUES(${f.projectID},${f.userID},'developer',${f.userID}) ON CONFLICT DO NOTHING`;
  try {
    await store.begin(f.userID, input);
    const first = store.upload(f.userID, input.id, bytes);
    // Attach rejection handling before the deliberate authority change.
    const rejected = first.then(
      () => null,
      (cause: unknown) => cause,
    );
    await processing.promise;
    await expect(store.upload(f.userID, input.id, bytes)).rejects.toMatchObject({ status: 409 });
    expect(conversions).toBe(1);
    await revoke();
    processed.resolve();
    expect(await rejected).toMatchObject({ status: 404 });
    expect(memory.blobs.size).toBe(0);
    await restore();
    expect((await store.upload(f.userID, input.id, bytes)).state).toBe("ready");
    expect(memory.blobs.size).toBe(1);
    blockRead = true;
    const pendingRead = store.read(f.userID, input.id).then(
      () => null,
      (cause: unknown) => cause,
    );
    await reading.promise;
    await revoke();
    read.resolve();
    expect(await pendingRead).toMatchObject({ status: 404 });
  } finally {
    processed.resolve();
    read.resolve();
    await restore();
    await f.dispose();
  }
});

test("feedback enforces the per-message attachment limit on the server, not the cumulative Thread", async () => {
  const f = await candidateReviewFixture();
  const previous = process.env["FACTORY_ATTACHMENT_MESSAGE_BYTES"];
  const memory = memoryObjects();
  const store = createAttachmentStore(f.database, memory.objects, async () => ({
    text: "",
    previews: [],
  }));
  const review = createVisualReviewController(f.database);
  try {
    const files = [];
    for (const name of ["First.txt", "Second.txt"]) {
      const bytes = new TextEncoder().encode("AB");
      const file = {
        id: crypto.randomUUID(),
        projectId: f.projectID,
        name,
        mediaType: "text/plain" as const,
        bytes: bytes.length,
        sha256: attachmentDigest(bytes),
      };
      await store.begin(f.userID, file);
      await store.upload(f.userID, file.id, bytes);
      files.push(attachmentMarkdown(file));
    }
    process.env["FACTORY_ATTACHMENT_MESSAGE_BYTES"] = "3";
    await expect(
      review.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "thread",
        body: files.join("\n\n"),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await review.get(f.changeID, f.userID)).feedback).toHaveLength(0);
    const created = await review.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: files[0],
    });
    const thread = fixtureValue(
      (await review.get(f.changeID, f.userID)).feedback[0],
      "(await review.get(f.changeID, f.userID)).feedback[0]",
    );
    await expect(
      review.update(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        feedbackId: created.feedbackId,
        expectedVersion: thread.version,
        action: "reply",
        body: files.join("\n\n"),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      fixtureValue(
        (await review.get(f.changeID, f.userID)).feedback[0],
        "(await review.get(f.changeID, f.userID)).feedback[0]",
      ).messages,
    ).toHaveLength(1);
    await review.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: created.feedbackId,
      expectedVersion: thread.version,
      action: "reply",
      body: files[1],
    });
    expect(
      fixtureValue(
        (await review.get(f.changeID, f.userID)).feedback[0],
        "(await review.get(f.changeID, f.userID)).feedback[0]",
      ).messages,
    ).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env["FACTORY_ATTACHMENT_MESSAGE_BYTES"];
    else process.env["FACTORY_ATTACHMENT_MESSAGE_BYTES"] = previous;
    await f.dispose();
  }
});
