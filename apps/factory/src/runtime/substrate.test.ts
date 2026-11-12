import { expect, test } from "bun:test";
import { fixtureRuntime } from "../../../../test/fixtures/substrate";
import type { SubstrateConfiguration } from "./substrate";
import { requireDurableROOTFS, requireSubstrateActor } from "./substrate";

const uid = "7337c55b-11e7-4a63-ae8c-71c843037959",
  templateUID = "0c6c6151-3a4b-4533-996a-7fd86515452f",
  snapshotUID = "574de7b7-93a4-4c5a-9514-4f70e0a668b6";
const intent = {
  templateUID,
  runtime: fixtureRuntime,
  actorSelector: { "factory.dev/binding": "owned" },
} as unknown as SubstrateConfiguration & { actorSelector: Record<string, string> };
function original() {
  return {
    metadata: {
      atespace: "owned",
      name: "original",
      uid,
      version: "7",
      createTime: "2026-11-09T12:00:00Z",
    },
    actorTemplate: { atespace: "owned", name: "runtime" },
    status: {
      state: "ACTOR_STATE_SUSPENDED",
      lastAssignedGeneration: 3,
      snapshots: [
        {
          uuid: snapshotUID,
          generation: 3,
          owner: "SNAPSHOT_OWNER_ACTOR",
          fidelity: "SNAPSHOT_FIDELITY_ROOTFS",
          actorTemplateUid: templateUID,
          sandboxRuntime: structuredClone(fixtureRuntime),
          durableSnapshot: {
            state: "SNAPSHOT_STORAGE_STATE_COMPLETED",
            object: {
              snapshotUri: `s3://owned/prefix/atespaces/owned/actors/${uid}/snapshots/${snapshotUID}`,
            },
          },
        },
      ],
    },
  };
}
function snapshot(actor: ReturnType<typeof original>) {
  const value = actor.status.snapshots[0];
  if (!value) throw new Error("Fixture snapshot missing");
  return value;
}
const binding = {
  atespace: "owned",
  actorName: "original",
  actorUID: uid,
  attemptedAt: "2026-11-09T11:59:59Z",
  intent,
};
test("native ROOTFS requires actual latest durable identity, not SUSPENDED or requested fidelity", () => {
  expect(requireDurableROOTFS(original(), binding).generation).toBe(3);
  for (const change of [
    (a: ReturnType<typeof original>) => {
      a.metadata.uid = crypto.randomUUID();
    },
    (a: ReturnType<typeof original>) => {
      a.status.lastAssignedGeneration = 4;
    },
    (a: ReturnType<typeof original>) => {
      snapshot(a).fidelity = "SNAPSHOT_FIDELITY_VOLUMES";
    },
    (a: ReturnType<typeof original>) => {
      snapshot(a).durableSnapshot.state = "SNAPSHOT_STORAGE_STATE_PENDING";
    },
    (a: ReturnType<typeof original>) => {
      snapshot(a).actorTemplateUid = crypto.randomUUID();
    },
    (a: ReturnType<typeof original>) => {
      const attribute = snapshot(a).sandboxRuntime.version.attributes[0];
      if (!attribute) throw new Error("Fixture runtime attribute missing");
      attribute.value = "arm64";
    },
    (a: ReturnType<typeof original>) => {
      snapshot(a).durableSnapshot.object.snapshotUri = "s3://owned/alien";
    },
    (a: ReturnType<typeof original>) => {
      a.status.snapshots = [];
    },
  ]) {
    const actor = original();
    change(actor);
    expect(() => requireDurableROOTFS(actor, binding)).toThrow();
  }
  expect(() =>
    requireDurableROOTFS(original(), binding, { uuid: crypto.randomUUID(), generation: 3 }),
  ).toThrow();
});
test("native Actor rejects recreated UID, changed scope/template and pre-dispatch foreign resource", () => {
  const actor = { ...original(), workerSelector: { matchLabels: intent.actorSelector } };
  expect(requireSubstrateActor(actor, binding).metadata.uid).toBe(uid);
  expect(() =>
    requireSubstrateActor({ ...actor, status: { state: "ACTOR_STATE_RUNNING" } }, binding),
  ).toThrow("runtime/profile");
  expect(() => requireSubstrateActor(original(), binding)).toThrow();
  expect(() =>
    requireSubstrateActor(original(), { ...binding, actorUID: crypto.randomUUID() }),
  ).toThrow();
  expect(() =>
    requireSubstrateActor(original(), { ...binding, attemptedAt: "2026-11-09T12:00:01Z" }),
  ).toThrow();
  expect(() => requireSubstrateActor(original(), { ...binding, atespace: "alien" })).toThrow();
  expect(() => requireSubstrateActor(original(), { ...binding, attemptedAt: null })).toThrow();
});
