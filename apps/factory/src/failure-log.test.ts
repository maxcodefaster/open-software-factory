import { expect, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { describeFailure, reportFailure } from "./failure-log";

test("failure descriptions keep the cause chain and drop credentials", () => {
  const cause = new Error("upstream said no", {
    cause: new Error("GET https://u:hunter2@forge/x?factory-grant=abc123&ok=1"),
  });
  const text = describeFailure(cause);
  expect(text).toContain("upstream said no");
  expect(text).toContain("caused by Error");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("abc123");
  expect(text).toContain("ok=1");
  expect(describeFailure("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain(
    "abcdefghij",
  );
  expect(describeFailure("x".repeat(5000)).length).toBeLessThan(2100);
});

test("reported failures reach the log with their context", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    reportFailure("release reconcile")(new Error("boom"));
    expect(String(log.mock.calls[0]?.[0])).toContain("release reconcile: Error: boom");
  } finally {
    log.mockRestore();
  }
});

test("database failure logs retain SQLSTATE and stack without query text or parameter values", () => {
  const cause = Object.assign(new Error("private-error-detail"), { code: "40P01" });
  const failure = new DrizzleQueryError(
    'select "owner_token" from "factory"."agent_turn" where "owner_token" = $1',
    ["private-lease", "private-provider-key"],
    cause,
  );
  const text = describeFailure(failure);
  expect(text).toContain("40P01");
  expect(text).toContain("at ");
  expect(text).not.toContain("private-");
  expect(text).not.toContain("owner_token");
});
