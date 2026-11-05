import { expect, test } from "bun:test";
import { createAgentFollower, firstChangedLine } from "./follow-agent";

const edit = (
  id: string,
  path: string,
  status: "running" | "completed" | "error" = "completed",
  diff?: string,
  name = "edit",
) => ({
  id,
  activity: { name, status, navigation: { path, ...(diff ? { diff } : {}) } },
});

test("firstChangedLine reads the first added line of the new file", () => {
  expect(firstChangedLine("@@ -1,3 +1,4 @@\n a\n b\n+c\n d")).toBe(3);
  expect(firstChangedLine("@@ -10,2 +12,2 @@\n-old\n+new\n tail")).toBe(12);
  expect(firstChangedLine("@@ -1,2 +1,1 @@\n a\n-b")).toBeUndefined();
  expect(firstChangedLine("-before\n+after")).toBeUndefined();
  expect(firstChangedLine(undefined)).toBeUndefined();
});

test("the first look records history and never replays it", () => {
  const follower = createAgentFollower();
  expect(follower.next("change", [edit("1", "a.ts")])).toBeUndefined();
  expect(follower.next("change", [edit("1", "a.ts")])).toBeUndefined();
});

test("a new edit is offered once and a burst moves the editor only to the newest", () => {
  const follower = createAgentFollower();
  const first = edit("1", "a.ts");
  follower.next("change", [first]);
  const burst = [first, edit("2", "b.ts"), edit("3", "c.ts", "running")];
  expect(follower.next("change", burst)).toEqual({ path: "c.ts" });
  expect(follower.next("change", burst)).toBeUndefined();
});

test("a running edit that later gains a diff is offered again with its line", () => {
  const follower = createAgentFollower();
  follower.next("change", []);
  expect(follower.next("change", [edit("1", "a.ts", "running")])).toEqual({ path: "a.ts" });
  const done = edit("1", "a.ts", "completed", "@@ -1,1 +5,2 @@\n+x\n y");
  expect(follower.next("change", [done])).toEqual({ path: "a.ts", line: 5 });
});

test("errors, reads and other tools are ignored, and a new change starts fresh", () => {
  const follower = createAgentFollower();
  follower.next("change", []);
  expect(follower.next("change", [edit("1", "a.ts", "error")])).toBeUndefined();
  expect(
    follower.next("change", [edit("2", "b.ts", "completed", undefined, "read")]),
  ).toBeUndefined();
  expect(follower.next("other", [edit("3", "c.ts")])).toBeUndefined();
  expect(follower.next("other", [edit("3", "c.ts"), edit("4", "d.ts")])).toEqual({ path: "d.ts" });
});
