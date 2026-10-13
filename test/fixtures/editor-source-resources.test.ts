import { expect, test } from "bun:test";
import { finishedPrebuildNamespace } from "./editor-source-resources";

test("background cleanup exemption requires exact terminal producer identity, never Workspace or UID replacement", () => {
  const namespace = { name: "factory-runtime-4a8e2f0c85f5", uid: "owned-namespace-uid" };
  const producer = {
    id: "4a8e2f0c-85f5-5df1-9dfe-bf98c5b7bec1",
    namespace: namespace.name,
    uid: namespace.uid,
    kind: "prebuild",
    state: "failed",
    jobState: "failed",
  };
  expect(finishedPrebuildNamespace(namespace, producer)).toBe(true);
  expect(
    finishedPrebuildNamespace(namespace, { ...producer, state: "stopped", jobState: "succeeded" }),
  ).toBe(true);
  for (const patch of [
    { kind: "staging" },
    { kind: null },
    { state: "stopping" },
    { state: "cleanup-failed" },
    { jobState: "running" },
    { uid: "replacement-uid" },
    { uid: null },
    { namespace: "other-namespace" },
    { id: crypto.randomUUID() },
  ])
    expect(finishedPrebuildNamespace(namespace, { ...producer, ...patch })).toBe(false);
});
