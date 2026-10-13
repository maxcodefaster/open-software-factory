import { expect, test } from "bun:test";
import { factoryTheme } from "../../../deploy/theia-ide/factory-ide-extension/src/browser/factory-theme";
import { luminance } from "../../../test/support/visual-contrast";

test("Factory's light IDE gives active and inactive navigation icons readable contrast", () => {
  const colors: Readonly<Record<string, string>> = factoryTheme.json.colors;
  const light = (key: string) => {
    const value = colors[key];
    expect(value).toMatch(/^#[a-f0-9]{6}$/i);
    if (!value) throw new Error(`Missing IDE color ${key}`);
    return luminance([1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)));
  };
  const background = light("activityBar.background");
  for (const key of ["activityBar.foreground", "activityBar.inactiveForeground"]) {
    const foreground = light(key);
    expect(
      (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
    ).toBeGreaterThanOrEqual(3);
  }
});
