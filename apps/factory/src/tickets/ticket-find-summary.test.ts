import { expect, test } from "bun:test";
import { ticketFindSummary } from "./ticket-find-summary";

test("quick find never presents a partial count as the final one", () => {
  expect(ticketFindSummary({ loading: true, count: 0, query: "epic" })).toBe("Finding Tickets…");
  expect(ticketFindSummary({ loading: true, count: 2, query: "epic" })).toBe(
    "Still searching. 2 Tickets found so far.",
  );
  expect(ticketFindSummary({ loading: true, count: 1, query: "epic" })).toBe(
    "Still searching. 1 Ticket found so far.",
  );
  expect(ticketFindSummary({ count: 3, query: "epic" })).toBe("3 Tickets in this Project");
  expect(ticketFindSummary({ count: 1, query: "epic" })).toBe("1 Ticket in this Project");
});

test("quick find explains an empty, capped and failed search", () => {
  expect(ticketFindSummary({ count: 0, query: "zzz" })).toBe(
    "No matching Tickets. Try another title or reference.",
  );
  expect(ticketFindSummary({ count: 0, query: " " })).toBe("No Tickets in this Project yet.");
  expect(ticketFindSummary({ count: 80, query: "a" })).toBe(
    "50 Tickets shown. Refine your search for more.",
  );
  expect(ticketFindSummary({ failed: true, loading: true, count: 4, query: "a" })).toContain(
    "could not load",
  );
});
