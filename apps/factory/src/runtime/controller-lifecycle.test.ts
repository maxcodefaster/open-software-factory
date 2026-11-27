import { describe, expect, test } from "bun:test";
import { selectRuntimeOwner } from "./controller-lifecycle";

describe("selectRuntimeOwner", () => {
  test("dispatches directly in O(1) by isolatedKind", () => {
    const owners = {
      isolated: "isolated-owner",
      verification: "verification-owner",
      workspaces: "workspaces-owner",
    };
    expect(selectRuntimeOwner(owners, "staging")).toBe("isolated-owner");
    expect(selectRuntimeOwner(owners, "publication")).toBe("isolated-owner");
    expect(selectRuntimeOwner(owners, "verification")).toBe("verification-owner");
    expect(selectRuntimeOwner(owners, null)).toBe("workspaces-owner");
  });
});
