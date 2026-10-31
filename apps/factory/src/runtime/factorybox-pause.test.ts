import { expect, test } from "bun:test";
import { rejectedFactoryboxPause } from "./factorybox-pause";

const id = "runtime-owned";
const snapshot = "a".repeat(32);
const owner = "b".repeat(32);
const start = { id, owner, inputSHA256: "c".repeat(64) };
type Entry = {
  snapshot_id: string;
  source_pid: number;
  rejected_at?: string;
  error?: string;
  completed_at?: string;
  checkpoint_sha256?: string;
  resume?: Record<string, never>;
};
type Native = {
  record: {
    version: number;
    id: string;
    owner: string;
    runtime_id: string;
    input_sha256: string;
    phase: string;
    pause?: { snapshot_id: string };
    pause_history: [Entry, ...Entry[]];
  };
  runtime: { status: string; pid: number };
};
const native = (): Native => ({
  record: {
    version: 1,
    id,
    owner,
    runtime_id: `fbx-${owner}`,
    input_sha256: start.inputSHA256,
    phase: "running",
    pause_history: [
      {
        snapshot_id: snapshot,
        source_pid: 123,
        rejected_at: "2026-10-31T10:00:00Z",
        error: "admission refused",
      },
    ],
  },
  runtime: { status: "running", pid: 123 },
});

test("only the original live source and exact rejected snapshot prove Pause rollback", () => {
  expect(rejectedFactoryboxPause(native(), id, snapshot, start)).toMatchObject({
    id,
    owner,
    snapshotID: snapshot,
    phase: "running",
    sourcePID: 123,
    rejected: true,
  });
  const mutations: Array<(value: Native) => void> = [
    (v) => {
      v.record.owner = "d".repeat(32);
    },
    (v) => {
      v.record.input_sha256 = "d".repeat(64);
    },
    (v) => {
      v.record.runtime_id = "foreign";
    },
    (v) => {
      v.record.phase = "pausing";
    },
    (v) => {
      v.runtime.status = "paused";
    },
    (v) => {
      v.runtime.pid = 999;
    },
    (v) => {
      v.record.pause = { snapshot_id: snapshot };
    },
    (v) => {
      v.record.pause_history[0].snapshot_id = "e".repeat(32);
    },
    (v) => {
      v.record.pause_history.push({ ...v.record.pause_history[0] });
    },
    (v) => {
      delete v.record.pause_history[0].rejected_at;
    },
    (v) => {
      delete v.record.pause_history[0].error;
    },
    (v) => {
      v.record.pause_history[0].completed_at = "2026-10-31T10:00:00Z";
    },
    (v) => {
      v.record.pause_history[0].checkpoint_sha256 = "f".repeat(64);
    },
    (v) => {
      v.record.pause_history[0].resume = {};
    },
  ];
  for (const change of mutations) {
    const value = native();
    change(value);
    const proof = () => {
      try {
        return rejectedFactoryboxPause(value, id, snapshot, start);
      } catch {
        return undefined;
      }
    };
    expect(proof()).toBeUndefined();
  }
});
