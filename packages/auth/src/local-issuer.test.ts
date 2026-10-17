import { expect, test } from "bun:test";
import { requireLocalForgeIssuer } from "./local-issuer";

test("only the installation's exact internal host and local development listener can override Forge issuer", () => {
  const base = "http://127.0.0.1:3000";
  expect(() =>
    requireLocalForgeIssuer(base, "http://host.orb.internal:3000/api/auth", true),
  ).not.toThrow();
  expect(() =>
    requireLocalForgeIssuer(base, "http://10.0.0.4:3000/api/auth", true, "10.0.0.4"),
  ).not.toThrow();
  for (const issuer of [
    "http://10.0.0.5:3000/api/auth",
    "http://10.0.0.4:3001/api/auth",
    "https://10.0.0.4:3000/api/auth",
    "http://10.0.0.4:3000/api/auth?redirect=other",
    "http://user:pass@10.0.0.4:3000/api/auth",
  ])
    expect(() => requireLocalForgeIssuer(base, issuer, true, "10.0.0.4")).toThrow();
  expect(() =>
    requireLocalForgeIssuer(base, "http://10.0.0.4:3000/api/auth", false, "10.0.0.4"),
  ).toThrow();
  expect(() =>
    requireLocalForgeIssuer(
      "https://factory.example",
      "http://10.0.0.4/api/auth",
      true,
      "10.0.0.4",
    ),
  ).toThrow();
});
