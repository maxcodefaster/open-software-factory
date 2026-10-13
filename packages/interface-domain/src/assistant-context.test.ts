import { expect, test } from "bun:test";
import { assistantContext } from "./assistant-context";

test("only the open IDE for the exact Ticket Change selects Build", () => {
  expect(assistantContext({ view: "ide", ideChangeId: "change", ticketChangeId: "change" })).toBe(
    "build",
  );
  for (const view of [undefined, "ticket", "knowledge", "preview"])
    expect(assistantContext({ view, ideChangeId: "change", ticketChangeId: "change" })).toBe(
      "investigate",
    );
  expect(assistantContext({ view: "ide", ideChangeId: "other", ticketChangeId: "change" })).toBe(
    "investigate",
  );
  expect(assistantContext({ view: "ide", ideChangeId: undefined, ticketChangeId: undefined })).toBe(
    "plan",
  );
});

test("a Project or unimplemented Ticket can research and conduct its Interview without compute", () => {
  expect(
    assistantContext({ view: undefined, ideChangeId: undefined, ticketChangeId: undefined }),
  ).toBe("plan");
  expect(
    assistantContext({ view: "ticket", ideChangeId: undefined, ticketChangeId: undefined }),
  ).toBe("plan");
});
