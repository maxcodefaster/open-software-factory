import { afterEach, expect, test } from "bun:test";
import { sameFactoryOrigin } from "./http";

const base = process.env["FACTORY_BASE_URL"];
afterEach(() => {
  if (base === undefined) delete process.env["FACTORY_BASE_URL"];
  else process.env["FACTORY_BASE_URL"] = base;
});

test("only the exact Factory origin passes, and a malformed origin is refused without throwing", () => {
  process.env["FACTORY_BASE_URL"] = "https://factory.example.com/";
  const request = (origin?: string) =>
    new Request("https://factory.example.com/x", origin ? { headers: { origin } } : {});
  expect(sameFactoryOrigin(request("https://factory.example.com"))).toBe(true);
  expect(sameFactoryOrigin(request("https://evil.example.com"))).toBe(false);
  expect(sameFactoryOrigin(request("null"))).toBe(false);
  expect(sameFactoryOrigin(request())).toBe(false);
});
