import { describe, expect, test } from "bun:test";
import {
  hashConnectorToken,
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimeModelToken,
  runtimeBuildBrowserToken,
} from "./identity";

describe("Runtime Attempt identity", () => {
  test("is stable for one Project generation", () => {
    const identity = runtimeIdentity("20e65e28-8bad-4c05-a063-3b629808d549", 3);
    expect(identity).toEqual(runtimeIdentity("20e65e28-8bad-4c05-a063-3b629808d549", 3));
    expect(identity.attemptID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(identity.podName).toBe("runtime-3");
  });

  test("changes with the generation", () => {
    expect(runtimeIdentity("20e65e28-8bad-4c05-a063-3b629808d549", 3)).not.toEqual(
      runtimeIdentity("20e65e28-8bad-4c05-a063-3b629808d549", 4),
    );
  });

  test("stores only a one-way connector token digest", () => {
    expect(hashConnectorToken("short-lived-token")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConnectorToken("short-lived-token")).not.toContain("short-lived-token");
  });

  test("can reconstruct distinct attempt-scoped connector capabilities", () => {
    const tokens = runtimeConnectorTokens("factory-secret", "attempt-id", 2);
    expect(tokens).toEqual(runtimeConnectorTokens("factory-secret", "attempt-id", 2));
    expect(tokens.parent).not.toBe(tokens.child);
    expect(tokens).not.toEqual(runtimeConnectorTokens("factory-secret", "attempt-id", 3));
    expect(tokens).not.toEqual(runtimeConnectorTokens("other-secret", "attempt-id", 2));
  });

  test("can reconstruct a generation-bound model relay capability", () => {
    const token = runtimeModelToken("factory-secret", "attempt-id", 2);
    expect(token).toBe(runtimeModelToken("factory-secret", "attempt-id", 2));
    expect(token).not.toBe(runtimeModelToken("factory-secret", "attempt-id", 3));
    expect(token).not.toContain("factory-secret");
  });

  test("browser authority is separate from inference and Connector roles", () => {
    const token = runtimeBuildBrowserToken("factory-secret", "attempt-id", 2);
    expect(token).toBe(runtimeBuildBrowserToken("factory-secret", "attempt-id", 2));
    expect(token).not.toBe(runtimeBuildBrowserToken("factory-secret", "attempt-id", 3));
    expect(token).not.toBe(runtimeBuildBrowserToken("factory-secret", "other-attempt", 2));
    expect(token).not.toBe(runtimeModelToken("factory-secret", "attempt-id", 2));
    expect(Object.values(runtimeConnectorTokens("factory-secret", "attempt-id", 2))).not.toContain(
      token,
    );
  });
});
