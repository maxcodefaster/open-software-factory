import { describe, expect, test } from "bun:test";
import {
  hashConnectorToken,
  runtimeBuildBrowserToken,
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimeModelToken,
  runtimeProjectEntryToken,
  runtimePublicationToken,
} from "./identity";

describe("Runtime Attempt identity", () => {
  test("is stable for one Project generation", () => {
    const identity = runtimeIdentity("20e65e28-8bad-4c05-a063-3b629808d549", 3);
    expect(identity).toEqual(runtimeIdentity("20e65e28-8bad-4c05-a063-3b629808d549", 3));
    expect(identity.attemptID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Object.keys(identity)).toEqual(["attemptID"]);
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

  test("native Project entry is bound to the secret, Attempt, generation and container", () => {
    const token = runtimeProjectEntryToken("factory-secret", "attempt-id", 2, "work");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(runtimeProjectEntryToken("factory-secret", "attempt-id", 2, "work"));
    for (const other of [
      runtimeProjectEntryToken("other-secret", "attempt-id", 2, "work"),
      runtimeProjectEntryToken("factory-secret", "other-attempt", 2, "work"),
      runtimeProjectEntryToken("factory-secret", "attempt-id", 3, "work"),
      runtimeProjectEntryToken("factory-secret", "attempt-id", 2, "database"),
      ...Object.values(runtimeConnectorTokens("factory-secret", "attempt-id", 2)),
      runtimeModelToken("factory-secret", "attempt-id", 2),
      runtimeBuildBrowserToken("factory-secret", "attempt-id", 2),
      runtimePublicationToken("factory-secret", "attempt-id"),
    ])
      expect(token).not.toBe(other);
    const derived = runtimeConnectorTokens(token, "attempt-id", 2);
    const connector = runtimeConnectorTokens("factory-secret", "attempt-id", 2);
    expect(derived.parent).not.toBe(connector.parent);
    expect(derived.child).not.toBe(connector.child);
    expect(token).not.toContain("factory-secret");
  });

  test("native Project entry rejects invalid generations, container names and missing secrets", () => {
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
      expect(() => runtimeProjectEntryToken("secret", "attempt", generation, "work")).toThrow(
        "Generation",
      );
    for (const container of [
      "",
      "Work",
      "0work",
      "-work",
      "work_other",
      "work:parent",
      "work/child",
      "work\n",
      "a".repeat(64),
    ])
      expect(() => runtimeProjectEntryToken("secret", "attempt", 1, container)).toThrow(
        "container",
      );
    for (const container of ["a", "work-1", "work-", "a".repeat(63)])
      expect(runtimeProjectEntryToken("secret", "attempt", 1, container)).toHaveLength(43);
    expect(() => runtimeProjectEntryToken("", "attempt", 1, "work")).toThrow("secret");
  });
});
