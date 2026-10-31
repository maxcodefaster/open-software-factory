import { expect, test } from "bun:test";
import { developerIDEOrigin } from "./developer-ide-origin";
import { appRuntimeOrigin, isolatedRuntimeOrigin, runtimeAppOriginRoute } from "./runtime-origins";

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

test("each declared App has its own complete listener-bound origin within DNS limits", () => {
  const factory = "https://factory.example:8443";
  for (const channel of ["app", "app-forms-api", "app-forms-admin", `app-${"a".repeat(27)}`]) {
    const url = new URL(appRuntimeOrigin(factory, id, channel));
    expect(url.hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(runtimeAppOriginRoute(factory, url)).toEqual({ attemptID: id, channel });
    const otherPort = new URL(url);
    otherPort.port = "9443";
    expect(runtimeAppOriginRoute(factory, otherPort)).toBeUndefined();
    const foreign = new URL(url);
    foreign.hostname += ".foreign.example";
    expect(runtimeAppOriginRoute(factory, foreign)).toBeUndefined();
  }
  expect(appRuntimeOrigin(factory, id, "app-forms-api")).not.toBe(
    appRuntimeOrigin(factory, id, "app-forms-admin"),
  );
  expect(() => appRuntimeOrigin(factory, id, "app-other.example")).toThrow();
  expect(() => appRuntimeOrigin(factory, "not-an-attempt", "app")).toThrow();
});
