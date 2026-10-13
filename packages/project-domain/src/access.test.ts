import { expect, test } from "bun:test";
import { projectCapabilities } from "./access";

test("Contributor can commission and correct work, but cannot run code or deliver", () => {
  expect(projectCapabilities("product-contributor")).toEqual({
    contribute: true,
    develop: false,
    deliver: false,
    manage: false,
  });
  expect(projectCapabilities(undefined)).toEqual({
    contribute: false,
    develop: false,
    deliver: false,
    manage: false,
  });
});

test("Developer and System Manager retain technical rights, management is independent", () => {
  for (const role of ["developer", "system-manager"] as const) {
    expect(projectCapabilities(role).develop).toBe(true);
    expect(projectCapabilities(role).deliver).toBe(true);
  }
  expect(projectCapabilities("developer").manage).toBe(false);
  expect(projectCapabilities("product-contributor", true)).toEqual({
    contribute: true,
    develop: false,
    deliver: false,
    manage: true,
  });
  expect(projectCapabilities("developer", true).manage).toBe(true);
  expect(projectCapabilities(undefined, true).manage).toBe(false);
});
