import { expect, test } from "bun:test";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("state-volume I/O does not hold the turn lease lock and Stop fences a staged recording", async () => {
  const f = await candidateReviewFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-recording-stage-"));
  const media = createReviewMedia(f.database, directory);
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
    expect(await Bun.file(join(directory, "review-media", grant.sessionID)).exists()).toBe(false);
  } finally {
    release.resolve();
    await finishing?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
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

test("recording disabled uses the same browser without ever starting an encoder", async () => {
  const f = await candidateReviewFixture();
  try {
    await f.database
      .client`UPDATE factory.project SET qa_recording_enabled=false WHERE id=${f.projectID}`;
    const turn = await f.activeReview();
    const actions: string[] = [];
    f.hub.parentOperation = async (_attempt, operation, authorize) => {
      await authorize?.(() => {});
      actions.push(operation.action);
      const scope = JSON.parse(String(operation["data"]));
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
      "owned-disabled-recording-secret",
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
    expect(actions).toEqual(["browser-call"]);
    await browser.closeTurn(turn.id);
  } finally {
    await f.dispose();
  }
});

test("recording publication is scoped to the current owner, indexed manifest and exact candidate", async () => {
  const f = await candidateReviewFixture();
  const directory = await mkdtemp(join(tmpdir(), "factory-recording-publication-"));
  const media = createReviewMedia(f.database, directory);
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
    await rm(directory, { recursive: true, force: true });
    await f.dispose();
  }
});
