import { expect, test } from "bun:test";
import type { InboxItem } from "./contracts";
import { inboxSectionItems, nextInboxQueueItem, type InboxQueue } from "./navigation";

const item = (id: string, values: Partial<InboxItem> = {}): InboxItem => ({
  id,
  eventId: id,
  projectId: "project-a",
  projectName: "A",
  ticketId: id,
  ticketTitle: id,
  title: "Review",
  preview: "Preview",
  createdAt: "2026-10-26T12:00:00Z",
  needsAction: true,
  archived: false,
  unread: true,
  updates: 1,
  target: "ticket",
  targetId: null,
  contextId: null,
  ...values,
});

test("Inbox sections keep read activity visible and never mix requests with archive", () => {
  const items = [
    item("request"),
    item("read", { needsAction: false, unread: false }),
    item("archived", { needsAction: false, unread: false, archived: true }),
    item("other", { projectId: "project-b" }),
  ];
  expect(
    inboxSectionItems(items, { section: "action", project: "project-a" }).map((item) => item.id),
  ).toEqual(["request"]);
  expect(
    inboxSectionItems(items, { section: "activity", project: "" }).map((item) => item.id),
  ).toEqual(["read"]);
  expect(
    inboxSectionItems(items, { section: "archive", project: "" }).map((item) => item.id),
  ).toEqual(["archived"]);
});

test("next Inbox item preserves chosen order and skips resolved or inaccessible sources", () => {
  const queue: InboxQueue = {
    ids: ["first", "resolved", "next", "last"],
    current: item("first"),
    section: "action",
    project: "",
  };
  const remaining = [item("arrival"), item("last"), item("next")];
  expect(nextInboxQueueItem(queue, remaining)?.id).toBe("next");
  expect(nextInboxQueueItem({ ...queue, current: item("next") }, remaining)?.id).toBe("last");
  expect(nextInboxQueueItem({ ...queue, current: item("last") }, remaining)).toBeUndefined();
  expect(nextInboxQueueItem({ ...queue, current: item("unknown") }, remaining)).toBeUndefined();
});

test("next Inbox item respects the original section and Project without acknowledging anything", () => {
  const queue: InboxQueue = {
    ids: ["first", "archived", "other", "request", "read"],
    current: item("first", { needsAction: false }),
    section: "activity",
    project: "project-a",
  };
  const items = [
    item("archived", { needsAction: false, archived: true }),
    item("other", { needsAction: false, projectId: "project-b" }),
    item("request"),
    item("read", { needsAction: false, unread: false }),
  ];
  const before = JSON.stringify(items);
  expect(nextInboxQueueItem(queue, items)?.id).toBe("read");
  expect(JSON.stringify(items)).toBe(before);
});
