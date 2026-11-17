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
  expect(readableError(new Error("Patch failed at line 500"))).toBe("Patch failed at line 500");
  expect(readableError({ data: { message: "Checkout is locked" } })).toBe("Checkout is locked");
  expect(readableError(42)).toBe(
    "The agent stopped unexpectedly. Retained work is kept. Retry to continue.",
  );
});

test("provider codes become one plain sentence with a next step", () => {
  const cases: [string, string][] = [
    ["401 Incorrect API key provided: sk-abc", "rejected Factory's credentials"],
    ["insufficient_quota: You exceeded your current quota", "no quota left"],
    ["This model's maximum context length is 128000 tokens", "too long for the model"],
    ["529 overloaded_error", "temporarily unavailable"],
    ["read ECONNRESET", "lost its connection"],
    ["TypeError: fetch failed", "lost its connection"],
  ];
  for (const [raw, expected] of cases) {
    const text = readableError(new Error(raw));
    expect(text).toContain(expected);
    expect(text).not.toContain("sk-abc");
    expect(text).not.toMatch(/ECONN|529|insufficient_quota/);
  }
});

test("the default provider path keeps exact credential, quota, rate and transport guidance", () => {
  const cases: [unknown, string][] = [
    [
      { message: "rate_limit_exceeded: https://provider.invalid/?token=private-token" },
      "The model provider is limiting requests right now. Wait a minute, then retry. Retained work is kept.",
    ],
    [
      new Error("401 Incorrect API key provided: sk-private-key"),
      "The model provider rejected Factory's credentials. Ask a System Manager to check the model connection, then retry. Retained work is kept.",
    ],
    [
      { data: { message: "insufficient_quota: private-account" } },
      "The model provider reports that the account has no quota left. Ask a System Manager to check the provider account, then retry. Retained work is kept.",
    ],
    [
      "TypeError: fetch failed https://user:private-password@provider.invalid",
      "Factory lost its connection to the model provider. Wait a minute, then retry. Retained work is kept.",
    ],
  ];
  for (const [error, expected] of cases) expect(readableError(error)).toBe(expected);
});
