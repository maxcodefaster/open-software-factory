import { expect, test } from "bun:test";
import { appRuntimeOrigin, isolatedRuntimeOrigin } from "./runtime-origins";
import { developerIDEOrigin } from "./developer-ide-origin";

const id = "01994a7d-0000-7000-8000-000000000001";

test("App and editor origins use one DNS label beneath a standard wildcard domain", () => {
  expect(appRuntimeOrigin("https://factory.example.com", id, "app")).toBe(
    "https://01994a7d000070008000000000000001-app.runtime.factory.example.com",
  );
  expect(developerIDEOrigin("https://factory.example.com", id, 1)).toBe(
    "https://01994a7d000070008000000000000001-1-s443-editor.runtime.factory.example.com",
  );
  for (const value of [
    appRuntimeOrigin("https://factory.example.com", id, "app"),
    developerIDEOrigin("https://factory.example.com", id, Number.MAX_SAFE_INTEGER),
  ]) {
    const hostname = new URL(value).hostname;
    expect(hostname.endsWith(".runtime.factory.example.com")).toBe(true);
    expect(hostname.slice(0, -".runtime.factory.example.com".length)).not.toContain(".");
    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
  }
});

test("local acceptance retains loopback DNS and isolates each listener and runtime role", () => {
  expect(appRuntimeOrigin("http://127.0.0.1:58000", id, "app")).toBe(
    "http://01994a7d000070008000000000000001-app.runtime.localhost:58000",
  );
  expect(appRuntimeOrigin("http://127.0.0.1:58000", id, "app")).not.toBe(
    appRuntimeOrigin("http://127.0.0.1:58000", id, "ide"),
  );
  expect(developerIDEOrigin("http://127.0.0.1:58000", id, 1)).not.toBe(
    developerIDEOrigin("http://127.0.0.1:58001", id, 1),
  );
});

test("runtime origin labels cannot add an unrelated host, extra labels or credentials", () => {
  for (const label of ["other.example", "user@host", "-invalid", "a".repeat(64)])
    expect(() => isolatedRuntimeOrigin("https://factory.example", label)).toThrow();
});
