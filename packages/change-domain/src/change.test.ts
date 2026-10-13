import { describe, expect, test } from "bun:test";
import { changeIdentity } from "./change";

describe("Change identity", () => {
  test("is deterministic and produces a stable branch", () => {
    const ticket = crypto.randomUUID();
    const approval = crypto.randomUUID();
    expect(changeIdentity(ticket, approval)).toEqual(changeIdentity(ticket, approval));
    expect(changeIdentity(ticket, approval).branchName).toMatch(/^factory\/change-[0-9a-f]{12}$/);
  });
});
