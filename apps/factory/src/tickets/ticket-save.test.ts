import { describe, expect, test } from "bun:test";
import { saveTicketEdits } from "./ticket-save";

describe("saveTicketEdits", () => {
  test("does not save the specification after planning fails", async () => {
    const calls: string[] = [];

    const saved = await saveTicketEdits(
      { planning: "planning", specification: "specification" },
      {
        savePlanning: () => {
          calls.push("planning");
          return false;
        },
        saveSpecification: () => {
          calls.push("specification");
          return true;
        },
      },
    );

    expect(saved).toBe(false);
    expect(calls).toEqual(["planning"]);
  });

  test("only reports completion after every requested save succeeds", async () => {
    const calls: string[] = [];

    const saved = await saveTicketEdits(
      { planning: "planning", specification: "specification" },
      {
        savePlanning: async () => {
          calls.push("planning");
          return true;
        },
        saveSpecification: async () => {
          calls.push("specification");
          return true;
        },
      },
    );

    expect(saved).toBe(true);
    expect(calls).toEqual(["planning", "specification"]);
  });

  test("reports failure when the specification save fails", async () => {
    const saved = await saveTicketEdits(
      { specification: "specification" },
      {
        savePlanning: () => true,
        saveSpecification: () => false,
      },
    );

    expect(saved).toBe(false);
  });
});
