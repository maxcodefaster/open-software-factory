import { expect, test } from "bun:test";
import {
  assignTicketEpicInput,
  createEpicInput,
  epicFamilyIds,
  epicParentWouldCycle,
  updateEpicInput,
} from "./epic";

test("Epic identity and membership edits are strict and versioned", () => {
  const id = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  expect(createEpicInput.parse({ id, projectId, title: "  Release onboarding  " })).toMatchObject({
    title: "Release onboarding",
    parentId: null,
    description: "",
  });
  expect(() => createEpicInput.parse({ id, projectId, title: "Epic", parentId: id })).toThrow(
    "own parent",
  );
  expect(() => updateEpicInput.parse({ projectId, epicId: id, expectedVersion: 1 })).toThrow(
    "planning field",
  );
  expect(() =>
    updateEpicInput.parse({ projectId, epicId: id, expectedVersion: 1, state: "done" }),
  ).toThrow();
  expect(
    assignTicketEpicInput.parse({ projectId, ticketId: id, expectedVersion: 1, epicId: null })
      .epicId,
  ).toBeNull();
  expect(() =>
    assignTicketEpicInput.parse({ projectId, ticketId: id, expectedVersion: 0, epicId: null }),
  ).toThrow();
});

test("optimistic hierarchy checks reject cycles without looping on invalid cached trees", () => {
  const epics = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "leaf", parentId: "child" },
  ];
  expect(epicParentWouldCycle(epics, "root", "leaf")).toBe(true);
  expect(epicParentWouldCycle(epics, "leaf", "root")).toBe(false);
  expect(epicParentWouldCycle(epics, "root", null)).toBe(false);
  expect(epicParentWouldCycle([{ id: "a", parentId: "a" }], "other", "a")).toBe(true);
});

test("Epic scope includes descendants once, not adjacent groups", () => {
  const epics = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "leaf", parentId: "child" },
    { id: "other", parentId: null },
  ];
  expect([...epicFamilyIds(epics, "root")].sort()).toEqual(["child", "leaf", "root"]);
  expect([...epicFamilyIds(epics, "child")].sort()).toEqual(["child", "leaf"]);
});
