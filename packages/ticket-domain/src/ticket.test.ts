import { describe, expect, test } from "bun:test";
import { canPlanTicket, createTicketInput, moveTicketInput, updateTicketInput } from "./ticket";

describe("Ticket planning", () => {
  test("normalizes creation and validates versioned edits", () => {
    expect(
      createTicketInput.parse({
        id: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        title: "  Add audit export  ",
      }).title,
    ).toBe("Add audit export");
    expect(() =>
      updateTicketInput.parse({
        projectId: crypto.randomUUID(),
        ticketId: crypto.randomUUID(),
        expectedVersion: 1,
      }),
    ).toThrow("planning field");
  });

  test("keeps lifecycle-only state outside planning authority", () => {
    expect(canPlanTicket("inbox", "ready")).toBe(true);
    expect(canPlanTicket("cancelled", "inbox")).toBe(true);
    expect(canPlanTicket("in-progress", "ready")).toBe(false);
    expect(() =>
      moveTicketInput.parse({
        projectId: crypto.randomUUID(),
        ticketId: crypto.randomUUID(),
        expectedVersion: 1,
        state: "in-progress",
      }),
    ).toThrow();
  });
});
