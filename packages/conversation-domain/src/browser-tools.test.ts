import { expect, test } from "bun:test";
import { buildBrowserCallInput, buildBrowserInstructions } from "./browser-tools";

test("Build browser instructions distinguish System Contract App IDs from runtime channels", () => {
  const instructions = buildBrowserInstructions("owned-turn");
  expect(instructions).toContain("primaryApp is always the browser channel app");
  expect(instructions).toContain("other declared Apps use app-<App ID>");
  expect(instructions).toContain("primaryApp web must be opened as app, not web");
});

test("native browser guidance uses tools and inline images without the CLI detour", () => {
  const instructions = buildBrowserInstructions("owned-turn");
  expect(instructions).toContain("factory_browser_browser_open");
  expect(instructions).toContain("Inspect the image directly");
  expect(instructions).not.toContain("browser-client");
  expect(instructions).not.toContain("270000");
  expect(instructions).toContain("Never repeat an unconfirmed UI mutation");
});
test("Build browser exposes bounded mobile viewport and keyboard controls", () => {
  for (const call of [
    { name: "browser_resize", arguments: { width: 390, height: 720 } },
    { name: "browser_press_key", arguments: { key: "Tab" } },
    { name: "browser_press_key", arguments: { key: "Shift+Tab" } },
    { name: "browser_press_key", arguments: { key: "Enter" } },
  ])
    expect(buildBrowserCallInput.safeParse(call).success).toBe(true);
  for (const call of [
    { name: "browser_resize", arguments: { width: 319, height: 720 } },
    { name: "browser_resize", arguments: { width: 1281, height: 720 } },
    { name: "browser_resize", arguments: { width: 390, height: 721 } },
    { name: "browser_resize", arguments: { width: 390, height: 0 } },
    { name: "browser_resize", arguments: { width: 390.5, height: 720 } },
    { name: "browser_resize", arguments: { width: 390, height: 720, pageId: 2 } },
    { name: "browser_press_key", arguments: { key: "Control+L" } },
    { name: "browser_press_key", arguments: { key: "Enter", text: "script" } },
  ])
    expect(buildBrowserCallInput.safeParse(call).success).toBe(false);
  const instructions = buildBrowserInstructions("owned-turn");
  expect(instructions).toContain("browser_resize {width,height}");
  expect(instructions).toContain("browser_press_key {key}");
});
