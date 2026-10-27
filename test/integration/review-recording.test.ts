import { expect, test } from "bun:test";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { observe } from "../fixtures/pinned-opencode";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { fixtureValue } from "../fixtures/value";

test("native review settlement publishes every recording chunk before closing its browser", async () => {
  const f = await candidateReviewFixture();
  const media = createReviewMedia(f.database, memoryPrivateObjects());
  const browser = createBuildBrowserController(f.database, f.hub, "owned-finish-secret", media);
  const controller = createAgentController(
    f.database,
    f.hub,
    { startPersisted: async () => null },
    browser,
    f.writers,
  );
  const data = Buffer.alloc(100_003, 7);
  data.writeUInt32BE(0x1a45dfa3);
  const operations: string[] = [];
  const offsets: number[] = [];
  const parent = f.hub.parentOperation.bind(f.hub);
  f.hub.parentOperation = async (attempt, operation, authorize) => {
    if (!operation.action.startsWith("browser-")) return parent(attempt, operation, authorize);
    await authorize?.(() => {});
    operations.push(operation.action);
    const scope = JSON.parse(String(operation["data"]));
    if (operation.action === "browser-call")
      return {
        data: JSON.stringify({
          content: [{ type: "text", text: "Owned App observation" }],
          structuredContent: {
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            runtimeAttemptId: f.attemptID,
            generation: 1,
            app: "app",
            headCommit: f.commit,
            workingTreeModified: false,
            observedAt: new Date().toISOString(),
          },
        }),
      };
    if (operation.action === "browser-recording-start")
      return { data: JSON.stringify({ startedAt: new Date().toISOString() }) };
    if (operation.action === "browser-recording-finish")
      return {
        data: JSON.stringify(
          operations.filter((action) => action === "browser-recording-finish").length < 3
            ? { state: "pending" }
            : { bytes: data.length, durationMs: 12_000 },
        ),
      };
    if (operation.action === "browser-recording-chunk") {
      const offset = scope.call.arguments.offset as number;
      offsets.push(offset);
      return {
        data: JSON.stringify({
          offset,
          data: data.subarray(offset, offset + 49_152).toString("base64"),
        }),
      };
    }
    return {};
  };
  try {
    await controller.review(f.changeID, f.reviewID, f.userID);
    await f.requested;
    f.acceptResponse();
    f.release();
    await observe(
      () => f.review(),
      (review) => review?.state === "running",
    );
    const [turn] = await f.database.client<{ id: string; token: string }[]>`
      SELECT id,owner_token AS token FROM factory.agent_turn WHERE command_id=${f.reviewID}`;
    if (!turn) throw new Error("Missing owned review turn");
    const grant = await browser.prepare(turn.id, turn.token);
    const authority = await browser.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
    if (!authority) throw new Error("Missing owned browser authority");
    await browser.call(
      authority.session,
      turn.token,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    f.finish("Independent review finished without a report.");
    await observe(
      () => f.review(),
      (review) => review?.state === "incomplete",
    );
    await observe(
      async () =>
        (
          await f.database.client<{ state: string }[]>`
        SELECT state FROM factory.build_browser_session WHERE id=${grant.sessionID}`
        )[0]?.state,
      (state) => state === "closed",
    );
    const response = await media.read(f.changeID, f.userID, grant.sessionID, null);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(offsets).toEqual([0, 49_152, 98_304]);
    expect(operations.filter((action) => action === "browser-recording-finish")).toHaveLength(3);
    expect(operations.at(-1)).toBe("browser-close");
    expect(f.requests()).toBe(1);
    expect(f.commitCalls).toEqual([]);
  } finally {
    f.acceptResponse();
    f.release();
    await controller.shutdown();
    await f.dispose();
  }
});

test.each(["abort", "stop"] as const)(
  "%s fences a pending recording without replaying App actions or exporting chunks",
  async (ending) => {
    const f = await candidateReviewFixture();
    const media = createReviewMedia(f.database, memoryPrivateObjects());
    const browser = createBuildBrowserController(f.database, f.hub, "owned-pending-secret", media);
    const pending = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const actions: string[] = [];
    let finishing: Promise<void> | undefined;
    try {
      const turn = await f.activeReview();
      f.hub.parentOperation = async (_attempt, operation, authorize) => {
        await authorize?.(() => {});
        actions.push(operation.action);
        const scope = JSON.parse(String(operation["data"]));
        if (operation.action === "browser-call")
          return {
            data: JSON.stringify({
              content: [{ type: "text", text: "Owned App observation" }],
              structuredContent: {
                sessionId: scope.sessionId,
                turnId: turn.id,
                runtimeAttemptId: f.attemptID,
                generation: 1,
                app: "app",
                headCommit: f.commit,
                workingTreeModified: false,
                observedAt: new Date().toISOString(),
              },
            }),
          };
        if (operation.action === "browser-recording-start")
          return { data: JSON.stringify({ startedAt: new Date().toISOString() }) };
        if (operation.action === "browser-recording-finish") {
          pending.resolve();
          return { data: JSON.stringify({ state: "pending" }) };
        }
        return {};
      };
      const grant = await browser.prepare(turn.id, turn.ownerToken);
      const authority = await browser.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
      if (!authority) throw new Error("Missing owned browser authority");
      await browser.call(
        authority.session,
        turn.ownerToken,
        { name: "browser_open", arguments: { app: "app" } },
        1,
      );
      finishing = browser.finishTurnRecording(turn.id, turn.ownerToken, cancellation.signal);
      await pending.promise;
      if (ending === "abort") cancellation.abort();
      else await browser.closeTurn(turn.id);
      await finishing;
      expect((await media.read(f.changeID, f.userID, grant.sessionID, null)).status).toBe(404);
      expect(actions.filter((action) => action === "browser-call")).toHaveLength(1);
      expect(actions.filter((action) => action === "browser-recording-finish")).toHaveLength(1);
      expect(actions).not.toContain("browser-recording-chunk");
      await browser.closeTurn(turn.id);
    } finally {
      cancellation.abort();
      await finishing?.catch(() => {});
      await f.dispose();
    }
  },
);

test("object storage I/O does not hold the turn lease lock and Stop fences a staged recording", async () => {
  const f = await candidateReviewFixture();
  const objects = memoryPrivateObjects();
  const media = createReviewMedia(f.database, objects);
  const staged = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const originalStage = media.stage;
  media.stage = async (...args) => {
    const proof = await originalStage(...args);
    staged.resolve();
    await release.promise;
    return proof;
  };
  let finishing: Promise<void> | undefined;
  try {
    const turn = await f.activeReview();
    const data = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    f.hub.parentOperation = async (_attempt, operation, authorize) => {
      await authorize?.(() => {});
      const scope = JSON.parse(String(operation["data"]));
      if (operation.action === "browser-call")
        return {
          data: JSON.stringify({
            content: [{ type: "text", text: "Observed App" }],
            structuredContent: {
              sessionId: scope.sessionId,
              turnId: turn.id,
              runtimeAttemptId: f.attemptID,
              generation: 1,
              app: "app",
              headCommit: f.commit,
              workingTreeModified: false,
              observedAt: new Date().toISOString(),
            },
          }),
        };
      if (operation.action === "browser-recording-start")
        return { data: JSON.stringify({ startedAt: new Date().toISOString() }) };
      if (operation.action === "browser-recording-finish")
        return { data: JSON.stringify({ bytes: data.length, durationMs: 1000 }) };
      if (operation.action === "browser-recording-chunk")
        return { data: JSON.stringify({ offset: 0, data: data.toString("base64") }) };
      return {};
    };
    const browser = createBuildBrowserController(f.database, f.hub, "owned-stage-secret", media);
    const grant = await browser.prepare(turn.id, turn.ownerToken);
    const authority = await browser.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
    if (!authority) throw new Error("Missing browser");
    await browser.call(
      authority.session,
      turn.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    finishing = browser.finishTurnRecording(turn.id, turn.ownerToken);
    await Promise.race([
      staged.promise,
      finishing.then(() => {
        throw new Error("Recording did not reach staged publication");
      }),
    ]);
    expect(await f.turns.renew(turn.id, turn.ownerToken)).toBe(true);
    await browser.closeTurn(turn.id);
    release.resolve();
    await finishing;
    expect((await media.read(f.changeID, f.userID, grant.sessionID, null)).status).toBe(404);
    await media.sweep();
    expect([...objects.blobs.keys()].some((key) => key.endsWith(`/${grant.sessionID}`))).toBe(
      false,
    );
  } finally {
    release.resolve();
    await finishing?.catch(() => {});
    await f.dispose();
  }
});

test("encoder failure is distinct from successful App observations and never replays the browser action", async () => {
  const f = await candidateReviewFixture();
  const actions: string[] = [];
  try {
    const turn = await f.activeReview();
    f.hub.parentOperation = async (_attempt, operation, authorize) => {
      await authorize?.(() => {});
      actions.push(operation.action);
      const scope = JSON.parse(String(operation["data"]));
      if (operation.action === "browser-recording-start")
        throw new Error("Owned encoder fault, not an App failure");
      if (operation.action === "browser-call")
        return {
          data: JSON.stringify({
            content: [{ type: "text", text: "Observed the declared App" }],
            structuredContent: {
              sessionId: scope.sessionId,
              turnId: turn.id,
              runtimeAttemptId: f.attemptID,
              generation: 1,
              app: "app",
              headCommit: f.commit,
              workingTreeModified: false,
              observedAt: new Date().toISOString(),
            },
          }),
        };
      return {};
    };
    const browser = createBuildBrowserController(
      f.database,
      f.hub,
      "owned-review-recording-secret",
    );
    const grant = await browser.prepare(turn.id, turn.ownerToken);
    const authorized = await browser.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
    if (!authorized) throw new Error("Missing owned review browser authority");
    const result = await browser.call(
      authorized.session,
      turn.ownerToken,
      { name: "browser_open", arguments: { app: "app", path: "/" } },
      1,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.headCommit).toBe(f.commit);
    expect(actions).toEqual(["browser-call", "browser-recording-start"]);
    const [recording] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.review_media WHERE browser_session_id=${grant.sessionID}`;
    expect(recording?.state).toBe("unavailable");
    const [session] = await f.database.client<{ state: string }[]>`
      SELECT state FROM factory.build_browser_session WHERE id=${grant.sessionID}`;
    expect(session?.state).toBe("active");
    await browser.finishTurnRecording(turn.id, turn.ownerToken);
    expect(actions).toEqual(["browser-call", "browser-recording-start"]);
    await browser.closeTurn(turn.id);
  } finally {
    await f.dispose();
  }
});

test("a Project preserves earlier review evidence and automatically records its next QA browser", async () => {
  const f = await candidateReviewFixture();
  const media = createReviewMedia(f.database, memoryPrivateObjects());
  const review = createVisualReviewController(f.database);
  const previousID = crypto.randomUUID();
  const previousVideo = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
  try {
    await f.database.client`INSERT INTO factory.review_media(
      id,change_id,review_id,kind,commit_sha,runtime_attempt_id,state)
      VALUES(${previousID},${f.changeID},${f.reviewID},'recording',${f.commit},${f.attemptID},'intended')`;
    await media.publish(previousID, previousVideo, 1000);
    const comment = await review.create(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      kind: "comment",
      body: "Keep this review discussion.",
    });
    expect(
      await f.database.client`SELECT column_name FROM information_schema.columns
        WHERE table_schema='factory' AND table_name='project' AND column_name='qa_recording_enabled'`,
    ).toHaveLength(0);
    const previous = await media.read(f.changeID, f.userID, previousID, null);
    expect(previous.status).toBe(200);
    expect(new Uint8Array(await previous.arrayBuffer())).toEqual(previousVideo);
    expect((await review.get(f.changeID, f.userID)).feedback[0]?.id).toBe(
      fixtureValue(comment.feedbackId, "comment.feedbackId"),
    );

    const turn = await f.activeReview();
    const actions: string[] = [];
    f.hub.parentOperation = async (_attempt, operation, authorize) => {
      await authorize?.(() => {});
      actions.push(operation.action);
      const scope = JSON.parse(String(operation["data"]));
      if (operation.action === "browser-recording-start")
        return { data: JSON.stringify({ startedAt: new Date().toISOString() }) };
      return operation.action !== "browser-call"
        ? {}
        : {
            data: JSON.stringify({
              content: [{ type: "text", text: "Actual App observation" }],
              structuredContent: {
                sessionId: scope.sessionId,
                turnId: turn.id,
                runtimeAttemptId: f.attemptID,
                generation: 1,
                app: "app",
                headCommit: f.commit,
                workingTreeModified: false,
                observedAt: new Date().toISOString(),
              },
            }),
          };
    };
    const browser = createBuildBrowserController(
      f.database,
      f.hub,
      "owned-automatic-recording-secret",
      media,
    );
    const grant = await browser.prepare(turn.id, turn.ownerToken);
    const authorized = await browser.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
    if (!authorized) throw new Error("Missing browser");
    await browser.call(
      authorized.session,
      turn.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    expect(actions).toEqual(["browser-call", "browser-recording-start"]);
    const [recording] = await f.database.client<{ state: string; commit: string }[]>`
      SELECT state,commit_sha AS commit FROM factory.review_media WHERE id=${grant.sessionID}`;
    expect(recording).toEqual({ state: "recording", commit: f.commit });
    await browser.renewTurn(turn.id, turn.ownerToken);
    expect(actions).toEqual(["browser-call", "browser-recording-start", "browser-renew"]);
    await browser.closeTurn(turn.id);
  } finally {
    await f.dispose();
  }
});

test("recording publication is scoped to the current owner, indexed manifest and exact candidate", async () => {
  const f = await candidateReviewFixture();
  const media = createReviewMedia(f.database, memoryPrivateObjects());
  const data = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  try {
    const turn = await f.activeReview();
    f.hub.parentOperation = async (_attempt, operation, authorize) => {
      await authorize?.(() => {});
      const scope = JSON.parse(String(operation["data"]));
      if (operation.action === "browser-call")
        return {
          data: JSON.stringify({
            content: [{ type: "text", text: "Observed App" }],
            structuredContent: {
              sessionId: scope.sessionId,
              turnId: turn.id,
              runtimeAttemptId: f.attemptID,
              generation: 1,
              app: "app",
              headCommit: f.commit,
              workingTreeModified: false,
              observedAt: new Date().toISOString(),
            },
          }),
        };
      if (operation.action === "browser-recording-start")
        return { data: JSON.stringify({ startedAt: new Date().toISOString() }) };
      if (operation.action === "browser-recording-finish")
        return { data: JSON.stringify({ bytes: data.byteLength, durationMs: 1000 }) };
      if (operation.action === "browser-recording-chunk")
        return { data: JSON.stringify({ offset: 0, data: data.toString("base64") }) };
      return {};
    };
    const browser = createBuildBrowserController(
      f.database,
      f.hub,
      "owned-publication-secret",
      media,
    );
    const grant = await browser.prepare(turn.id, turn.ownerToken);
    const authorized = await browser.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
    if (!authorized) throw new Error("Missing scoped browser");
    await browser.call(
      authorized.session,
      turn.ownerToken,
      { name: "browser_open", arguments: { app: "app" } },
      1,
    );
    await browser.finishTurnRecording(turn.id, "not-the-owner");
    expect((await media.read(f.changeID, f.userID, grant.sessionID, null)).status).toBe(404);
    await browser.finishTurnRecording(turn.id, turn.ownerToken);
    const response = await media.read(f.changeID, f.userID, grant.sessionID, null);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    const [recording] = await f.database.client<
      { sha: string; state: string }[]
    >`SELECT commit_sha AS sha,state
      FROM factory.review_media WHERE id=${grant.sessionID}`;
    expect(recording).toEqual({ sha: f.commit, state: "complete" });
    await browser.closeTurn(turn.id);
    expect((await media.read(f.changeID, f.userID, grant.sessionID, null)).status).toBe(200);
  } finally {
    await f.dispose();
  }
});
