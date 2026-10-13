import { expect, test } from "bun:test";
import { draftFrom, draftDirty, reconcileDraft, readDraft } from "./draft";

test("revisioned drafts adopt clean updates, merge disjoint edits and retain conflicting text", () => {
  const base = { id: "page", version: 1, title: "Guide", body: "First.\nLast." };
  const clean = draftFrom(base);
  expect(draftDirty(clean)).toBe(false);
  const next = { ...base, version: 2, body: "First.\nRemote." };
  expect(reconcileDraft(clean, next).body).toBe(next.body);
  const dirty = { ...clean, body: "Local.\nLast." };
  const merged = reconcileDraft(dirty, next);
  expect(merged.body).toBe("Local.\nRemote.");
  expect(merged.base.version).toBe(2);
  const conflict = reconcileDraft(dirty, { ...next, body: "Remote.\nLast." });
  expect(conflict.conflict).toBe(true);
  expect(conflict.body).toBe(dirty.body);
  expect(conflict.base.version).toBe(1);
  expect(reconcileDraft(merged, base)).toBe(merged);
  expect(readDraft("page", { getItem: () => "broken" })).toBeUndefined();
  expect(readDraft("page", { getItem: () => JSON.stringify(dirty) })).toEqual(dirty);
});
