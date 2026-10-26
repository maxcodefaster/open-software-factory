import { expect, test } from "bun:test";
import {
  factoryboxObsoleteCheckpoints,
  factoryboxObsoleteResumeImages,
} from "./factorybox-retention";

const id = `runtime-${"a".repeat(32)}`;
const owner = "b".repeat(32);
const current = {
  snapshot_id: "c".repeat(32),
  checkpoint_sha256: "d".repeat(64),
  completed_at: "2026-10-26T12:00:00Z",
};
const prior = {
  snapshot_id: "e".repeat(32),
  checkpoint_sha256: "f".repeat(64),
  completed_at: "2026-10-26T11:00:00Z",
  resume: { completed_at: "2026-10-26T11:01:00Z" },
};
const request = (generation: typeof current) => ({
  source_id: id,
  source_owner: owner,
  snapshot_id: generation.snapshot_id,
  checkpoint_sha256: generation.checkpoint_sha256,
});

test("retention preserves the current unresumed Pause and retires only completed resumed history", () => {
  expect(
    factoryboxObsoleteCheckpoints(id, {
      id,
      owner,
      phase: "paused",
      pause: current,
      pause_history: [prior],
    }),
  ).toEqual([request(prior)]);
  expect(
    factoryboxObsoleteCheckpoints(id, {
      id,
      owner,
      phase: "paused",
      pause: current,
    }),
  ).toEqual([]);
});

test("a resumed reserve and repeated assigned cycles retain their exact checkpoint ownership", () => {
  expect(
    factoryboxObsoleteCheckpoints(id, {
      id,
      owner,
      phase: "running",
      pause: { ...current, resume: { completed_at: "2026-10-26T12:01:00Z" } },
      pause_history: [prior],
    }),
  ).toEqual([request(prior), request(current)]);
});

test("confirmed Delete can retire an unresumed Pause, but not incomplete captures", () => {
  expect(
    factoryboxObsoleteCheckpoints(id, {
      id,
      owner,
      phase: "deleted",
      pause: current,
      pause_history: [prior, { snapshot_id: "1".repeat(32) }],
    }),
  ).toEqual([request(prior), request(current)]);
});

test("changed ownership, hashes, unresolved state and conflicting generations refuse retention", () => {
  const record = { id, owner, phase: "deleted", pause: current };
  for (const invalid of [
    { ...record, id: "another-sandbox" },
    { ...record, owner: "not-an-owner" },
    { ...record, phase: "resuming" },
    { ...record, pause: { ...current, checkpoint_sha256: undefined } },
    { ...record, pause_history: [{ ...current, checkpoint_sha256: "1".repeat(64) }] },
  ])
    expect(() => factoryboxObsoleteCheckpoints(id, invalid)).toThrow();
});

test("old Resume images become eligible only after a later complete Pause", () => {
  const record = { id, owner, phase: "paused", pause: current, pause_history: [prior] };
  expect(factoryboxObsoleteResumeImages(id, record)).toEqual([request(prior)]);
  expect(
    factoryboxObsoleteResumeImages(id, {
      ...record,
      phase: "running",
      pause: { ...current, resume: { completed_at: "resumed" } },
    }),
  ).toEqual([request(prior)]);
  expect(
    factoryboxObsoleteResumeImages(id, {
      ...record,
      phase: "running",
      pause: { ...current, completed_at: "" },
    }),
  ).toEqual([]);
});

test("Delete retires the last completed Resume but does not invent images for an unresumed Pause", () => {
  const record = { id, owner, phase: "deleted", pause: current, pause_history: [prior] };
  expect(factoryboxObsoleteResumeImages(id, record)).toEqual([request(prior)]);
  expect(
    factoryboxObsoleteResumeImages(id, {
      ...record,
      pause: { ...current, resume: { completed_at: "resumed" } },
    }),
  ).toEqual([request(prior), request(current)]);
  expect(factoryboxObsoleteResumeImages(id, { id, owner, phase: "running" })).toEqual([]);
});
