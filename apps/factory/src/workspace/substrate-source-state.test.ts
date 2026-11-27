import { describe, expect, test } from "bun:test";
import {
  classifySourceLease,
  isFrozenLease,
  isLiveServiceLease,
  type SubstrateSourceLeaseRow,
} from "./substrate-source-state";

const workspaceID = "11111111-1111-4111-8111-111111111111";
const projectID = "22222222-2222-4222-8222-222222222222";
const actorUID = "33333333-3333-4333-8333-333333333333";
const seedID = "44444444-4444-4444-8444-444444444444";
const checkpointID = "55555555-5555-4555-8555-555555555555";
const otherCheckpointID = "66666666-6666-4666-8666-666666666666";
const digest = "a".repeat(64);

const seed = {
  version: 1 as const,
  id: seedID,
  workspaceID,
  projectID,
  repositoryURL: "https://example.invalid/repo.git",
  revision: "b".repeat(40),
  branch: "main",
};

const checkpoint = {
  id: checkpointID,
  workspaceID,
  actorUID,
  writerEpoch: 2,
  generation: 1,
  bundle: {
    version: 1 as const,
    bytes: 128,
    sha256: digest,
    chunks: [digest],
  },
};

function baseRow(overrides: Partial<SubstrateSourceLeaseRow> = {}): SubstrateSourceLeaseRow {
  return {
    workspaceID,
    actorUID,
    owner: "actor",
    writerEpoch: 1,
    writable: true,
    generation: 0,
    checkpointID: null,
    checkpoint: null,
    serviceBase: null,
    seed: null,
    seedConfirmedAt: null,
    ...overrides,
  };
}

describe("classifySourceLease", () => {
  test("classifies all 8 source lease phases explicitly", () => {
    const confirmedAt = new Date("2026-01-01T00:00:00Z");

    const seedPending = classifySourceLease(
      baseRow({
        owner: "service",
        actorUID: null,
        writable: true,
        serviceBase: seedID,
        seed,
        seedConfirmedAt: null,
      }),
    );
    expect(seedPending.phase).toBe("seed-pending");
    expect(isLiveServiceLease(seedPending)).toBe(true);
    expect(isFrozenLease(seedPending)).toBe(false);

    const seedReady = classifySourceLease(
      baseRow({
        owner: "service",
        actorUID: null,
        writable: true,
        serviceBase: seedID,
        seed,
        seedConfirmedAt: confirmedAt,
      }),
    );
    expect(seedReady.phase).toBe("seed-ready");
    expect(isLiveServiceLease(seedReady)).toBe(true);

    const serviceLive = classifySourceLease(
      baseRow({
        owner: "service",
        actorUID,
        writable: true,
        generation: 1,
        checkpoint,
        serviceBase: checkpointID,
      }),
    );
    expect(serviceLive.phase).toBe("service-live");
    expect(isLiveServiceLease(serviceLive)).toBe(true);

    const serviceFreezing = classifySourceLease(
      baseRow({
        owner: "service",
        actorUID,
        writable: false,
        generation: 1,
        checkpointID: otherCheckpointID,
        checkpoint,
        serviceBase: checkpointID,
      }),
    );
    expect(serviceFreezing.phase).toBe("service-freezing");
    expect(isLiveServiceLease(serviceFreezing)).toBe(false);
    expect(isFrozenLease(serviceFreezing)).toBe(false);

    const serviceFrozen = classifySourceLease(
      baseRow({
        owner: "service",
        actorUID,
        writable: false,
        generation: 1,
        checkpointID,
        checkpoint,
        serviceBase: seedID,
      }),
    );
    expect(serviceFrozen.phase).toBe("service-frozen");
    expect(isFrozenLease(serviceFrozen)).toBe(true);

    const actorLive = classifySourceLease(baseRow({ owner: "actor", writable: true }));
    expect(actorLive.phase).toBe("actor-live");
    expect(isLiveServiceLease(actorLive)).toBe(false);
    expect(isFrozenLease(actorLive)).toBe(false);

    const actorFreezing = classifySourceLease(
      baseRow({
        owner: "actor",
        writable: false,
        checkpointID: otherCheckpointID,
        checkpoint: null,
      }),
    );
    expect(actorFreezing.phase).toBe("actor-freezing");
    expect(isFrozenLease(actorFreezing)).toBe(false);

    const actorFrozen = classifySourceLease(
      baseRow({
        owner: "actor",
        writable: false,
        generation: 1,
        checkpointID,
        checkpoint,
      }),
    );
    expect(actorFrozen.phase).toBe("actor-frozen");
    expect(isFrozenLease(actorFrozen)).toBe(true);
  });

  test("rejects inconsistent source lease invariants", () => {
    expect(() => classifySourceLease(baseRow({ owner: "service", serviceBase: null }))).toThrow(
      "Independent Source owner is unconfirmed",
    );

    expect(() => classifySourceLease(baseRow({ owner: "actor", actorUID: null }))).toThrow(
      "Source owner changed",
    );

    expect(() =>
      classifySourceLease(baseRow({ owner: "actor", writable: false, checkpointID: null })),
    ).toThrow("Source freeze is unconfirmed");

    expect(() =>
      classifySourceLease(
        baseRow({ owner: "service", serviceBase: seedID, writable: true, checkpointID }),
      ),
    ).toThrow("Source freeze is unconfirmed");
  });
});
