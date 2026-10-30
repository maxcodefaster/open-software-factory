import { expect, test } from "bun:test";
import { factoryWriterLabel } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-writer-label";

test("writer labels distinguish the human holder from the Agent commissioner and handoff requester", () => {
  const actor = { user: { id: "anna", name: "Anna" }, delegated: false };
  expect(factoryWriterLabel({ state: "human", canWrite: false, actor })).toBe(
    "Anna is editing. Files remain available to read.",
  );
  expect(factoryWriterLabel({ state: "agent", canWrite: false, actor })).toBe(
    "Agent working · requested by Anna. Observation mode.",
  );
  expect(
    factoryWriterLabel({
      state: "handoff",
      canWrite: false,
      actor,
      requester: { id: "ben", name: "Ben" },
    }),
  ).toBe("Transferring editing to Ben. Existing files are preserved.");
  expect(factoryWriterLabel({ state: "human", canWrite: true, actor })).toBe(
    "You are editing this implementation.",
  );
});

test("missing identity never invents an owner or changes writing authority", () => {
  expect(factoryWriterLabel({ state: "human", canWrite: false, actor: {} })).toContain(
    "Another developer",
  );
  expect(factoryWriterLabel({ state: "agent", canWrite: false })).toBe(
    "Agent working. Observation mode.",
  );
  expect(factoryWriterLabel({ state: "unassigned", canWrite: false })).toBe(
    "Editing is available.",
  );
  expect(
    factoryWriterLabel({
      state: "agent",
      canWrite: false,
      actor: { user: { name: "Anna" }, delegated: true },
    }),
  ).toBe("Agent working · delegated by Anna. Observation mode.");
  expect(
    factoryWriterLabel({
      state: "agent",
      canWrite: false,
      actor: { user: { name: "Anna" }, workState: "uncertain" },
    }),
  ).toBe("Agent outcome unconfirmed · requested by Anna. Observation mode.");
});

test("a stopped Turn with unconfirmed Agent Stop is not presented as settled editing", () => {
  expect(
    factoryWriterLabel({
      state: "agent",
      canWrite: false,
      stopPending: true,
      actor: { user: { name: "Anna" }, workState: "stopped" },
    }),
  ).toBe("Agent Stop unconfirmed. Check Stop in this Ticket. Files remain available to read.");
});
