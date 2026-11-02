import { expect, test } from "bun:test";
import { unattemptedFactoryboxResume } from "./factorybox-resume";

const id = "runtime-owned";
const snapshot = "a".repeat(32);
const owner = "b".repeat(32);
const start = { id, owner, inputSHA256: "c".repeat(64) };
const pause = { ...start, phase: "paused", snapshotID: snapshot, checkpointSHA256: "d".repeat(64) };
const native = () => ({
  record: {
    version: 1,
    id,
    owner,
    runtime_id: `fbx-${owner}`,
    input_sha256: start.inputSHA256,
    phase: "resuming",
    pause: {
      snapshot_id: snapshot,
      checkpoint_sha256: pause.checkpointSHA256,
      completed_at: "2026-11-02T05:42:36Z",
      resume: {
        requested_at: "2026-11-02T05:43:07Z",
        attempted: false as boolean,
        completed_at: undefined as string | undefined,
      } as { requested_at?: string; attempted?: boolean; completed_at?: string } | undefined,
    },
  },
  runtime: { status: "stopped", pid: 0 },
});

test("only an exact committed Pause and an explicitly unattempted native restore may continue", () => {
  expect(unattemptedFactoryboxResume(native(), id, snapshot, start, pause)).toBe(true);
  const untouched = native();
  untouched.record.phase = "paused";
  untouched.record.pause.resume = undefined;
  expect(unattemptedFactoryboxResume(untouched, id, snapshot, start, pause)).toBe(true);
});

test("missing, changed or already attempted native outcomes never authorize Resume", () => {
  const changes: Array<(value: ReturnType<typeof native>) => void> = [
    (v) => {
      v.record.version = 2;
    },
    (v) => {
      v.record.id = "runtime-foreign";
    },
    (v) => {
      v.record.owner = "e".repeat(32);
    },
    (v) => {
      v.record.runtime_id = "fbx-foreign";
    },
    (v) => {
      v.record.input_sha256 = "e".repeat(64);
    },
    (v) => {
      v.record.phase = "running";
    },
    (v) => {
      v.record.phase = "deleted";
    },
    (v) => {
      v.record.pause.snapshot_id = "e".repeat(32);
    },
    (v) => {
      v.record.pause.checkpoint_sha256 = "e".repeat(64);
    },
    (v) => {
      v.record.pause.completed_at = "";
    },
    (v) => {
      v.record.pause.resume = undefined;
    },
    (v) => {
      v.record.pause.resume = {};
    },
    (v) => {
      v.record.pause.resume = { requested_at: "2026-11-02T05:43:07Z" };
    },
    (v) => {
      v.record.pause.resume = { requested_at: "2026-11-02T05:43:07Z", attempted: true };
    },
    (v) => {
      v.record.pause.resume = {
        requested_at: "2026-11-02T05:43:07Z",
        attempted: false,
        completed_at: "2026-11-02T05:44:00Z",
      };
    },
    (v) => {
      v.record.phase = "paused";
    },
    (v) => {
      v.runtime.status = "running";
    },
    (v) => {
      v.runtime.pid = 123;
    },
  ];
  for (const change of changes) {
    const value = native();
    change(value);
    expect(unattemptedFactoryboxResume(value, id, snapshot, start, pause)).toBe(false);
  }
  for (const saved of [
    { ...pause, owner: "e".repeat(32) },
    { ...pause, inputSHA256: "e".repeat(64) },
    { ...pause, snapshotID: "e".repeat(32) },
    { ...pause, phase: "resuming" },
  ]) {
    expect(() => unattemptedFactoryboxResume(native(), id, snapshot, start, saved)).toThrow();
  }
});
