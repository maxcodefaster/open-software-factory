import { expect, test } from "bun:test";
import {
  cancelComposer,
  cancelVideoMarking,
  createReviewSessionTracker,
  dismissComposer,
  initialComposerPhase,
  initialMediaState,
  isCommandBusy,
  isCommandLocked,
  isSendingRevision,
  markMediaFailed,
  markMediaLoaded,
  markReviewLoadFailed,
  openComposerAt,
  openComposerWithCapture,
  pendingRetryCommand,
  resetComposerAfterSave,
  resetMediaForRecording,
  restoreComposerPhase,
  reviewViewOf,
  selectVideoFramePoint,
  setMediaPaused,
  setMediaPlayhead,
  startVideoMarking,
  updateMediaMetadata,
} from "./panel-machine";
import type { PanelReviewCapture } from "./panel-state";

const recordingCapture: PanelReviewCapture = {
  id: "cap-1",
  context: { source: "recording", recordingId: "rec-1", timestampMs: 1200 },
  timestampMs: 1200,
  page: "QA abcdef12",
};

test("composer phase transitions make video marking, open, dismissed, and cancelled states explicit", () => {
  const closed = initialComposerPhase(false);
  expect(closed.kind).toBe("closed");

  const marking = startVideoMarking(closed, recordingCapture);
  expect(marking.kind).toBe("marking");
  expect(marking.capture?.id).toBe("cap-1");

  const cancelledMarking = cancelVideoMarking(marking);
  expect(cancelledMarking.kind).toBe("closed");
  expect(cancelledMarking.capture).toBeUndefined();

  const selected = selectVideoFramePoint(marking, 0.25, 0.75, { x: 40, y: 80 });
  expect(selected.kind).toBe("open");
  expect(selected.position).toEqual({ x: 40, y: 80 });
  expect(selected.capture?.region).toEqual({ x: 0.25, y: 0.75, width: 0.001, height: 0.001 });

  const dismissed = dismissComposer(selected);
  expect(dismissed.kind).toBe("closed");
  expect(dismissed.capture?.id).toBe("cap-1");

  const cancelled = cancelComposer(dismissed);
  expect(cancelled.kind).toBe("closed");
  expect(cancelled.capture).toBeUndefined();

  const openedWithCapture = openComposerWithCapture(cancelled, recordingCapture);
  expect(openedWithCapture.kind).toBe("open");
  expect(resetComposerAfterSave(openedWithCapture, true)).toEqual({
    kind: "open",
    position: { x: 40, y: 80 },
  });
  expect(openComposerAt(openedWithCapture, { x: 100, y: 12 }, false).capture).toBeUndefined();
  expect(
    restoreComposerPhase({
      body: "",
      kind: "comment",
      capture: recordingCapture,
      time: 1,
      scenario: "",
      composing: false,
      marking: true,
      position: { x: 20, y: 30 },
      replies: {},
    }).kind,
  ).toBe("marking");
});

test("media state transitions track loading, ready, paused, playhead, and failed phases", () => {
  const initial = initialMediaState();
  expect(initial).toEqual({ kind: "loading", playhead: 0, duration: 0, ratio: 16 / 9 });

  const withMeta = updateMediaMetadata(initial, 12.5, 4 / 3);
  expect(withMeta.duration).toBe(12.5);
  expect(withMeta.ratio).toBe(4 / 3);

  const ready = markMediaLoaded(withMeta, 1.5, 12.5, undefined);
  expect(ready).toEqual({
    kind: "ready",
    paused: true,
    playhead: 1.5,
    duration: 12.5,
    ratio: 4 / 3,
  });

  const playing = setMediaPaused(ready, false);
  expect(playing.kind === "ready" && playing.paused).toBe(false);

  const scrubbed = setMediaPlayhead(playing, 4.2);
  expect(scrubbed.playhead).toBe(4.2);

  const failed = markMediaFailed(scrubbed);
  expect(failed.kind).toBe("failed");

  const retried = resetMediaForRecording(failed);
  expect(retried).toEqual({ kind: "loading", playhead: 4.2, duration: 0, ratio: 4 / 3 });
});

test("review command state helpers and session tracker guard concurrent reads and epochs", async () => {
  expect(reviewViewOf({ kind: "loading" })).toBeUndefined();
  expect(markReviewLoadFailed({ kind: "loading" })).toEqual({ kind: "failed" });

  expect(isCommandBusy({ kind: "idle" })).toBe(false);
  expect(isCommandBusy({ kind: "uploading" })).toBe(true);
  expect(isCommandLocked({ kind: "idle" })).toBe(false);

  const sendCommand = {
    action: "send" as const,
    input: { commandId: "11111111-1111-4111-8111-111111111111", feedback: [] },
  };
  expect(isSendingRevision({ kind: "submitting", command: sendCommand })).toBe(true);
  expect(pendingRetryCommand({ kind: "unconfirmed", command: sendCommand })).toEqual(sendCommand);

  const tracker = createReviewSessionTracker();
  const epoch = tracker.advanceScope();
  expect(tracker.isCurrent(epoch)).toBe(true);
  expect(tracker.beginFlight()).toBe(true);
  expect(tracker.beginFlight()).toBe(false);
  tracker.endFlight(epoch);
  expect(tracker.isInFlight()).toBe(false);

  let published = 0;
  const firstDeferred = Promise.withResolvers<never>();
  const stale = tracker.runRead(
    false,
    () => firstDeferred.promise,
    () => {
      published++;
    },
    () => {},
  );
  tracker.advanceScope();
  firstDeferred.reject(new Error("stale"));
  await stale.catch(() => {});
  expect(published).toBe(0);
});
