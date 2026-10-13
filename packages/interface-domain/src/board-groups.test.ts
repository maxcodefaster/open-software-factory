import { expect, test } from "bun:test";
import { boardGroups } from "./board-groups";

test("stacks Epic members without dropping ungrouped or unavailable-Epic Tickets", () => {
  const tickets = [
    { id: "one", epicId: "release" },
    { id: "solo", epicId: null },
    { id: "two", epicId: "release" },
    { id: "unknown", epicId: "hidden" },
  ] as const;
  expect(boardGroups(tickets, [{ id: "release", title: "Release" }])).toEqual([
    { kind: "epic", epic: { id: "release", title: "Release" }, tickets: [tickets[0], tickets[2]] },
    { kind: "ticket", ticket: tickets[1] },
    { kind: "ticket", ticket: tickets[3] },
  ]);
  expect(tickets.map((ticket) => ticket.id)).toEqual(["one", "solo", "two", "unknown"]);
});

test("stage-local grouping does not combine different Epics or manufacture empty stacks", () => {
  expect(boardGroups([], [{ id: "release", title: "Release" }])).toEqual([]);
  expect(
    boardGroups(
      [
        { id: "one", epicId: "a" },
        { id: "two", epicId: "b" },
      ],
      [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    ).map((group) => group.kind),
  ).toEqual(["epic", "epic"]);
});
