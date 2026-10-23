import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { pendingReviewThreads } from "../../packages/conversation-domain/src/visual-review";

test("human feedback is idempotent, scoped, versioned and admits corrections only explicitly", async () => {
  const f = await candidateReviewFixture();
  const controller = createVisualReviewController(f.database);
  try {
    const input = {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "The empty state loses the form.",
    };
    const first = await controller.create(f.changeID, f.userID, input);
    expect(await controller.create(f.changeID, f.userID, input)).toMatchObject(first);
    await expect(
      controller.create(f.changeID, f.userID, { ...input, body: "Changed" }),
    ).rejects.toThrow("changed input");
    const view = await controller.get(f.changeID, f.userID);
    expect(view.feedback).toHaveLength(1);
    expect(view.feedback[0]?.messages[0]?.body).toBe(input.body);
    const [before] = await f.database.client<{ count: number }[]>`SELECT count(*)::int AS count
      FROM factory.agent_turn WHERE change_id=${f.changeID}`;
    expect(before?.count).toBe(1);
    const commandId = crypto.randomUUID();
    const selected = { commandId, feedback: [{ id: first.feedbackId!, version: 1 }] };
    const admit = async (
      sql: Parameters<ReturnType<typeof createChangeAdmission>["admitIn"]>[0],
      text: string,
      id: string,
    ) =>
      (
        await createChangeAdmission(f.database, buildModelID).admitIn(sql, f.changeID, f.userID, {
          kind: "change-prompt",
          commandId: id,
          text,
        })
      ).turn.id;
    const correction = await controller.dispatch(f.changeID, f.userID, selected, admit);
    expect(await controller.dispatch(f.changeID, f.userID, selected, admit)).toMatchObject(
      correction,
    );
    const [intent] = await f.database.client<{ session: string; text: string }[]>`
      SELECT session_id AS session,prompt_text AS text FROM factory.change_agent_turn_intent WHERE turn_id=${correction.turnId!}`;
    expect(intent?.session).toBe(f.sessionID);
    expect(intent?.text).toContain(input.body);
    expect(intent?.text).toContain("Do not resolve Threads");
    await controller.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: first.feedbackId,
      expectedVersion: 1,
      action: "reply",
      body: "Also after reload.",
    });
    await expect(
      controller.update(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        feedbackId: first.feedbackId,
        expectedVersion: 1,
        action: "resolve",
      }),
    ).rejects.toThrow("changed");
    expect((await controller.get(f.changeID, f.userID)).feedback[0]?.state).toBe("open");
    await f.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await expect(controller.get(f.changeID, f.userID)).rejects.toThrow("not found");
    await expect(controller.dispatch(f.changeID, f.userID, selected, admit)).rejects.toThrow(
      "not found",
    );
  } finally {
    await f.dispose();
  }
});

test("one revision atomically takes all pending Threads and excludes notes, sent work and human rechecks", async () => {
  const f = await candidateReviewFixture();
  const controller = createVisualReviewController(f.database);
  const admit = async (
    sql: Parameters<ReturnType<typeof createChangeAdmission>["admitIn"]>[0],
    text: string,
    commandId: string,
  ) =>
    (
      await createChangeAdmission(f.database, buildModelID).admitIn(sql, f.changeID, f.userID, {
        kind: "change-prompt",
        commandId,
        text,
      })
    ).turn.id;
  try {
    const first = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Keep the draft.",
    });
    const second = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Show the validation error.",
    });
    const note = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "comment",
      body: "This is conversation, not another task.",
    });
    const implemented = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Await my recheck.",
    });
    await f.database
      .client`UPDATE factory.review_feedback SET state='implemented',version=2 WHERE id=${implemented.feedbackId!}`;
    const snapshot = {
      commandId: crypto.randomUUID(),
      feedback: [
        { id: first.feedbackId!, version: 1 },
        { id: second.feedbackId!, version: 1 },
      ],
    };
    for (const feedback of [
      [snapshot.feedback[0]],
      [...snapshot.feedback, { id: note.feedbackId!, version: 1 }],
      [...snapshot.feedback, { id: implemented.feedbackId!, version: 2 }],
    ])
      await expect(
        controller.dispatch(
          f.changeID,
          f.userID,
          {
            commandId: crypto.randomUUID(),
            feedback,
          },
          admit,
        ),
      ).rejects.toThrow("Open Threads changed");

    await controller.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: second.feedbackId,
      expectedVersion: 1,
      action: "reply",
      body: "Beside the input.",
    });
    await expect(controller.dispatch(f.changeID, f.userID, snapshot, admit)).rejects.toThrow(
      "changed",
    );
    snapshot.feedback[1]!.version = 2;
    const revision = await controller.dispatch(f.changeID, f.userID, snapshot, admit);
    expect(await controller.dispatch(f.changeID, f.userID, snapshot, admit)).toMatchObject(
      revision,
    );
    expect(
      pendingReviewThreads((await controller.get(f.changeID, f.userID)).feedback),
    ).toHaveLength(0);
    await expect(
      controller.dispatch(
        f.changeID,
        f.userID,
        {
          ...snapshot,
          commandId: crypto.randomUUID(),
        },
        admit,
      ),
    ).rejects.toThrow("changed");
    const [intent] = await f.database.client<{ text: string }[]>`
      SELECT prompt_text AS text FROM factory.change_agent_turn_intent WHERE turn_id=${revision.turnId!}`;
    expect(intent?.text).not.toContain("This is conversation");
    expect(intent?.text).not.toContain("Await my recheck");
    expect(intent?.text).toContain(first.feedbackId!);
    expect(intent?.text).toContain(second.feedbackId!);

    const owner = await f.turns.claimPending(revision.turnId!);
    if (!owner?.ownerToken) throw new Error("Missing revision owner");
    await f.writers.prepareAgent(f.changeID, owner.id);
    await f.database
      .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${owner.id}`;
    await f.database
      .client`UPDATE factory.change_agent_session SET active_turn_id=${owner.id},state='starting' WHERE change_id=${f.changeID}`;
    await f.turns.beginDispatch(owner.id, owner.ownerToken);
    const listed = await controller.call(owner.id, owner.ownerToken, {
      name: "feedback_list",
      arguments: {},
    });
    expect(
      JSON.parse(listed.content[0]!.type === "text" ? listed.content[0]!.text : "null"),
    ).toEqual(snapshot.feedback);
    await f.turns.settle(owner.id, owner.ownerToken, "completed", "Owned revision finished");
    const sent = await controller.get(f.changeID, f.userID);
    expect(sent.feedback.find((item) => item.id === first.feedbackId)?.correctionState).toBe(
      "sent",
    );
    expect(pendingReviewThreads(sent.feedback)).toHaveLength(0);
    await controller.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: implemented.feedbackId,
      expectedVersion: 2,
      action: "reply",
      body: "I am checking this.",
    });
    expect(
      pendingReviewThreads((await controller.get(f.changeID, f.userID)).feedback),
    ).toHaveLength(0);
    await controller.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: implemented.feedbackId,
      expectedVersion: 3,
      action: "reopen",
    });
    expect(
      pendingReviewThreads((await controller.get(f.changeID, f.userID)).feedback).map(
        (item) => item.id,
      ),
    ).toEqual([implemented.feedbackId!]);
  } finally {
    await f.dispose();
  }
});

test("large discussions are read through bounded tools instead of requiring checkbox-sized batches", async () => {
  const f = await candidateReviewFixture();
  const controller = createVisualReviewController(f.database);
  try {
    for (let index = 0; index < 60; index++)
      await controller.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "thread",
        body: `${index}: ${"Long feedback. ".repeat(130)}`,
      });
    const view = await controller.get(f.changeID, f.userID);
    const result = await controller.dispatch(
      f.changeID,
      f.userID,
      {
        commandId: crypto.randomUUID(),
        feedback: pendingReviewThreads(view.feedback).map((item) => ({
          id: item.id,
          version: item.version,
        })),
      },
      async (sql, text, commandId) => {
        expect(text.length).toBeLessThan(10_000);
        expect(text).toContain("Read each complete discussion");
        return (
          await createChangeAdmission(f.database, buildModelID).admitIn(sql, f.changeID, f.userID, {
            kind: "change-prompt",
            commandId,
            text,
          })
        ).turn.id;
      },
    );
    expect(result.turnId).toBeTruthy();
  } finally {
    await f.dispose();
  }
});

test("a failed revision becomes actionable only for another explicit request", async () => {
  const f = await candidateReviewFixture();
  const controller = createVisualReviewController(f.database);
  const admit = async (
    sql: Parameters<ReturnType<typeof createChangeAdmission>["admitIn"]>[0],
    text: string,
    commandId: string,
  ) =>
    (
      await createChangeAdmission(f.database, buildModelID).admitIn(sql, f.changeID, f.userID, {
        kind: "change-prompt",
        commandId,
        text,
      })
    ).turn.id;
  try {
    const thread = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Keep the error visible.",
    });
    const input = {
      commandId: crypto.randomUUID(),
      feedback: [{ id: thread.feedbackId!, version: 1 }],
    };
    const first = await controller.dispatch(f.changeID, f.userID, input, admit);
    const owner = await f.turns.claimPending(first.turnId!);
    if (!owner?.ownerToken) throw new Error("Missing owned revision");
    await f.writers.prepareAgent(f.changeID, owner.id);
    await f.turns.beginDispatch(owner.id, owner.ownerToken);
    await f.turns.settle(owner.id, owner.ownerToken, "failed", "Owned revision failure");
    const pending = pendingReviewThreads((await controller.get(f.changeID, f.userID)).feedback);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.correctionState).toBe("retry");
    // Refresh and replay of the original command cannot create the retry turn.
    expect(await controller.dispatch(f.changeID, f.userID, input, admit)).toMatchObject(first);
    const second = await controller.dispatch(
      f.changeID,
      f.userID,
      {
        ...input,
        commandId: crypto.randomUUID(),
      },
      admit,
    );
    expect(second.turnId).not.toBe(first.turnId);
    expect(
      pendingReviewThreads((await controller.get(f.changeID, f.userID)).feedback),
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("new complete video replaces annotated video but keeps stills; remaining video expires after completion", async () => {
  const f = await candidateReviewFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-review-"));
  const media = createReviewMedia(f.database, directory);
  const controller = createVisualReviewController(f.database);
  try {
    const oldID = crypto.randomUUID(),
      nextID = crypto.randomUUID(),
      stillID = crypto.randomUUID();
    for (const [id, kind] of [
      [oldID, "recording"],
      [stillID, "still"],
    ] as const) {
      await f.database
        .client`INSERT INTO factory.review_media(id,change_id,review_id,created_by,kind,commit_sha,state,source_context)
        VALUES(${id},${f.changeID},${kind === "recording" ? f.reviewID : null},${f.userID},${kind},${f.commit},'intended',
          ${kind === "still" ? JSON.stringify({ source: "recording", recordingId: oldID, timestampMs: 1000 }) : null}::jsonb)`;
    }
    await media.publish(oldID, Buffer.from("old recording"), 2000);
    await media.publish(stillID, Buffer.from("original still"));
    await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "At this frame.",
      annotation: { source: "recording", mediaId: stillID, page: "/form", timestampMs: 1000 },
    });
    await media.sweep();
    expect((await media.read(f.changeID, f.userID, oldID, null)).status).toBe(200);
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,created_by,kind,commit_sha,state)
      VALUES(${nextID},${f.changeID},${f.reviewID},${f.userID},'recording',${f.commit},'intended')`;
    await media.publish(nextID, Buffer.from("new recording"), 2500);
    await media.sweep();
    expect((await media.read(f.changeID, f.userID, oldID, null)).status).toBe(404);
    expect((await media.read(f.changeID, f.userID, stillID, null)).status).toBe(200);
    const ranged = await media.read(f.changeID, f.userID, nextID, "bytes=0-2");
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("new");
    expect((await media.read(f.changeID, f.userID, nextID, "bytes=0-999")).status).toBe(416);
    await f.database
      .client`UPDATE factory.change SET state='delivered',cancel_requested_at=now()-interval '31 days' WHERE id=${f.changeID}`;
    await media.sweep();
    await media.sweep();
    expect((await media.read(f.changeID, f.userID, nextID, null)).status).toBe(404);
    expect(await (await media.read(f.changeID, f.userID, stillID, null)).text()).toBe(
      "original still",
    );
    expect((await controller.get(f.changeID, f.userID)).feedback[0]?.messages[0]?.body).toBe(
      "At this frame.",
    );
    await f.database
      .client`DELETE FROM factory.project_membership WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await expect(media.read(f.changeID, f.userID, stillID, null)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});

test("image-free Preview anchors are idempotent and retain only their own Change's Runtime Attempt", async () => {
  const f = await candidateReviewFixture();
  const controller = createVisualReviewController(f.database);
  try {
    const annotation = {
      source: "preview",
      attemptId: f.attemptID,
      documentId: crypto.randomUUID(),
      selector: "#project-name",
      page: "/projects/new",
      element: "input Project name",
      region: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
    };
    const input = {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Make the name limit visible.",
      annotation,
    };
    const saved = await controller.create(f.changeID, f.userID, input);
    expect(await controller.create(f.changeID, f.userID, input)).toMatchObject(saved);
    const view = await controller.get(f.changeID, f.userID);
    expect(view.feedback).toHaveLength(1);
    expect(view.feedback[0]).toMatchObject({
      commitSha: "a".repeat(40),
      annotation: { ...annotation, representation: "unavailable" },
      state: "open",
    });
    expect(view.feedback[0]?.annotation?.mediaId).toBeUndefined();
    expect(view.currentCommitSha).toBe(f.commit);
    await expect(
      controller.create(f.changeID, f.userID, {
        ...input,
        commandId: crypto.randomUUID(),
        annotation: { ...annotation, attemptId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("does not belong");
    const [turns] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.agent_turn WHERE change_id=${f.changeID}`;
    expect(turns?.count).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("DOM images are labelled reconstructions and cannot replace a recording's original provenance", async () => {
  const f = await candidateReviewFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-preview-context-"));
  const media = createReviewMedia(f.database, directory);
  const controller = createVisualReviewController(f.database);
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1]);
  try {
    const image = await media.still(
      f.changeID,
      f.userID,
      { source: "preview", attemptId: f.attemptID, representation: "dom-reconstruction" },
      jpeg,
    );
    await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "comment",
      body: "Context only.",
      annotation: {
        source: "preview",
        attemptId: f.attemptID,
        mediaId: image.id,
        page: "/form",
        representation: "original",
      },
    });
    expect((await controller.get(f.changeID, f.userID)).feedback[0]?.annotation).toMatchObject({
      representation: "dom-reconstruction",
    });
    await expect(
      controller.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "comment",
        body: "Wrong source.",
        annotation: { source: "recording", mediaId: image.id, page: "/form", timestampMs: 1000 },
      }),
    ).rejects.toThrow("source");
    await expect(
      controller.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "comment",
        body: "Wrong attempt.",
        annotation: {
          source: "preview",
          attemptId: crypto.randomUUID(),
          mediaId: image.id,
          page: "/form",
        },
      }),
    ).rejects.toThrow("changed its Runtime Attempt");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});

test("only existing Project management may disable recording", async () => {
  const f = await candidateReviewFixture();
  try {
    const controller = createVisualReviewController(f.database);
    await expect(controller.recordingSetting(f.projectID, f.userID, false)).rejects.toThrow(
      "Manager",
    );
    await f.database
      .client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    await controller.recordingSetting(f.projectID, f.userID, false);
    expect((await controller.get(f.changeID, f.userID)).recordingEnabled).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("saved frames retain deleted-video and superseded-Preview context without resurrecting video", async () => {
  const f = await candidateReviewFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-frame-context-"));
  const media = createReviewMedia(f.database, directory);
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1]);
  try {
    const recordingID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,runtime_attempt_id,state)
      VALUES(${recordingID},${f.changeID},${f.reviewID},'recording',${f.commit},${f.attemptID},'intended')`;
    await media.publish(recordingID, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 5000);
    await f.database
      .client`UPDATE factory.review_media SET state='deleted',deleted_at=now() WHERE id=${recordingID}`;
    await media.sweep();
    const uploadID = crypto.randomUUID();
    const frame = await media.still(
      f.changeID,
      f.userID,
      { source: "recording", recordingId: recordingID, timestampMs: 2500 },
      jpeg,
      uploadID,
    );
    expect(
      await media.still(
        f.changeID,
        f.userID,
        { source: "recording", recordingId: recordingID, timestampMs: 2500 },
        jpeg,
        uploadID,
      ),
    ).toEqual(frame);
    const changed = jpeg.slice();
    changed[31] = 1;
    await expect(
      media.still(
        f.changeID,
        f.userID,
        { source: "recording", recordingId: recordingID, timestampMs: 2500 },
        changed,
        uploadID,
      ),
    ).rejects.toThrow("identity changed");
    expect((await media.read(f.changeID, f.userID, recordingID, null)).status).toBe(404);
    const [saved] = await f.database.client<{ commit: string; context: { timestampMs: number } }[]>`
      SELECT commit_sha AS commit,source_context AS context FROM factory.review_media WHERE id=${frame.id}`;
    expect(saved?.commit).toBe(f.commit);
    expect(saved?.context.timestampMs).toBe(2500);
    const review = createVisualReviewController(f.database);
    await expect(
      review.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "comment",
        body: "Original frame",
        annotation: { source: "recording", mediaId: frame.id, page: "/form", timestampMs: 3000 },
      }),
    ).rejects.toThrow("timestamp");
    await f.database
      .client`UPDATE factory.change SET runtime_attempt_id=NULL WHERE id=${f.changeID}`;
    const preview = await media.still(
      f.changeID,
      f.userID,
      { source: "preview", attemptId: f.attemptID },
      jpeg,
    );
    const [basis] = await f.database.client<{ commit: string; attempt: string }[]>`
      SELECT commit_sha AS commit,runtime_attempt_id AS attempt FROM factory.review_media WHERE id=${preview.id}`;
    expect(basis).toEqual({ commit: "a".repeat(40), attempt: f.attemptID });
  } finally {
    await f.database
      .client`UPDATE factory.change SET runtime_attempt_id=${f.attemptID} WHERE id=${f.changeID}`;
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});

test("the correction agent may request rechecking but cannot resolve or silently consume newer replies", async () => {
  const f = await candidateReviewFixture();
  const controller = createVisualReviewController(f.database);
  try {
    const first = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Keep my input after validation fails.",
    });
    const correction = await controller.dispatch(
      f.changeID,
      f.userID,
      { commandId: crypto.randomUUID(), feedback: [{ id: first.feedbackId!, version: 1 }] },
      async (sql, text, commandId) =>
        (
          await createChangeAdmission(f.database, buildModelID).admitIn(sql, f.changeID, f.userID, {
            kind: "change-prompt",
            text,
            commandId,
          })
        ).turn.id,
    );
    const turn = await f.turns.claimPending(correction.turnId!);
    if (!turn?.ownerToken) throw new Error("Missing correction owner");
    await f.writers.prepareAgent(f.changeID, turn.id);
    await f.database
      .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${turn.id}`;
    await f.database
      .client`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},state='starting' WHERE change_id=${f.changeID}`;
    await f.turns.beginDispatch(turn.id, turn.ownerToken);
    const call = { name: "feedback_implemented", arguments: { feedbackId: first.feedbackId } };
    await controller.call(turn.id, turn.ownerToken, call);
    await controller.call(turn.id, turn.ownerToken, call);
    expect((await controller.get(f.changeID, f.userID)).feedback[0]).toMatchObject({
      state: "implemented",
      version: 2,
    });
    await controller.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: first.feedbackId,
      expectedVersion: 2,
      action: "reply",
      body: "Please also keep the chosen option.",
    });
    await expect(controller.call(turn.id, turn.ownerToken, call)).rejects.toThrow("changed");
    await expect(
      controller.call(turn.id, turn.ownerToken, {
        name: "feedback_resolve",
        arguments: { feedbackId: first.feedbackId },
      }),
    ).rejects.toThrow();
    expect((await controller.get(f.changeID, f.userID)).feedback[0]?.state).toBe("implemented");
  } finally {
    await f.dispose();
  }
});

test("revision tools retain the complete discussion when its supplementary saved image is missing", async () => {
  const f = await candidateReviewFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-revision-media-"));
  const media = createReviewMedia(f.database, directory);
  const controller = createVisualReviewController(f.database, media.bytes);
  const jpeg = new Uint8Array(32);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1]);
  try {
    const frame = await media.still(
      f.changeID,
      f.userID,
      { source: "preview", attemptId: f.attemptID, representation: "dom-reconstruction" },
      jpeg,
    );
    const thread = await controller.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Clear the stale validation error after a successful rename.",
      annotation: {
        source: "preview",
        attemptId: f.attemptID,
        mediaId: frame.id,
        page: "/tasks",
        element: "alert Enter a task title.",
      },
    });
    await controller.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: thread.feedbackId,
      expectedVersion: 1,
      action: "reply",
      body: "Also prevent an older failure from replacing a newer success.",
    });
    const correction = await controller.dispatch(
      f.changeID,
      f.userID,
      { commandId: crypto.randomUUID(), feedback: [{ id: thread.feedbackId!, version: 2 }] },
      async (sql, text, commandId) =>
        (
          await createChangeAdmission(f.database, buildModelID).admitIn(sql, f.changeID, f.userID, {
            kind: "change-prompt",
            text,
            commandId,
          })
        ).turn.id,
    );
    const turn = await f.turns.claimPending(correction.turnId!);
    if (!turn?.ownerToken) throw new Error("Missing correction owner");
    await f.writers.prepareAgent(f.changeID, turn.id);
    await f.database
      .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${turn.id}`;
    await f.database
      .client`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},state='starting' WHERE change_id=${f.changeID}`;
    await f.turns.beginDispatch(turn.id, turn.ownerToken);
    const call = { name: "feedback_read", arguments: { feedbackId: thread.feedbackId } };
    const complete = await controller.call(turn.id, turn.ownerToken, call);
    expect(complete.isError).not.toBe(true);
    expect(complete.content[1]).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: Buffer.from(jpeg).toString("base64"),
    });
    await rm(join(directory, "review-media", frame.id));
    const withoutImage = await controller.call(turn.id, turn.ownerToken, call);
    expect(withoutImage.isError).not.toBe(true);
    expect(withoutImage.content[0]).toEqual(complete.content[0]);
    expect(withoutImage.content).toContainEqual({
      type: "text",
      text: "Saved feedback image is unavailable. The complete discussion and saved source context are included; inspect the current App before claiming a fix.",
    });
    const discussion = withoutImage.content[0];
    if (discussion?.type !== "text") throw new Error("Missing complete discussion");
    expect(JSON.parse(discussion.text)).toMatchObject({
      id: thread.feedbackId,
      messages: [
        "Clear the stale validation error after a successful rename.",
        "Also prevent an older failure from replacing a newer success.",
      ],
    });
    expect((await controller.get(f.changeID, f.userID)).feedback[0]).toMatchObject({
      state: "open",
      version: 2,
    });
    await expect(
      controller.call(turn.id, turn.ownerToken, {
        name: "feedback_read",
        arguments: { feedbackId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("not in this revision batch");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});
