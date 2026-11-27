import { describe, expect, test } from "bun:test";
import { canTransitionForgeClient } from "./oidc-mcp";

describe("forge OAuth client provisioning state machine", () => {
  test("transitions strictly create-intended -> ready", () => {
    expect(canTransitionForgeClient("create-intended", "ready")).toBe(true);
    expect(canTransitionForgeClient("create-intended", "create-intended")).toBe(false);
    expect(canTransitionForgeClient("ready", "create-intended")).toBe(false);
    expect(canTransitionForgeClient("ready", "ready")).toBe(false);
  });
});
