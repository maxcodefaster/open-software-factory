import { expect, test } from "bun:test";
import { readableError } from "./native-errors";

test("a provider rate limit becomes a plain retry hint", () => {
  expect(
    readableError({
      message:
        "rate_limit_exceeded: Your requests to gpt-5.6-terra in swedencentral have exceeded token rate limit.",
    }),
  ).toContain("limiting requests");
  expect(readableError(new Error("HTTP 429 Too Many Requests"))).toContain("limiting requests");
});

test("other failures keep their own words", () => {
  expect(readableError(new Error("Model not found"))).toBe("Model not found");
  expect(readableError({ data: { message: "Checkout is locked" } })).toBe("Checkout is locked");
  expect(readableError(42)).toBe("OpenCode run failed");
});
