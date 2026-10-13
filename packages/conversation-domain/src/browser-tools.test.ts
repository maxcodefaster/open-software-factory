import { expect, test } from "bun:test";
import { buildBrowserInstructions } from "./browser-tools";

test("Build browser instructions distinguish System Contract App IDs from runtime channels", () => {
  const instructions = buildBrowserInstructions("owned-turn");
  expect(instructions).toContain("primaryApp is always the browser channel app");
  expect(instructions).toContain("other declared Apps use app-<App ID>");
  expect(instructions).toContain("primaryApp web must be opened as app, not web");
});
