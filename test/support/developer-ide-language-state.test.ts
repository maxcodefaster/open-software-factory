import { expect, test } from "bun:test";
import {
  FactoryLanguageState,
  languagePreset,
} from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-language-state";

test("language preset names its supported languages without implying support for syntax-only files", () => {
  for (const language of ["typescript", "typescriptreact", "javascript", "javascriptreact"])
    expect(languagePreset(language)).toBe("typescript");
  expect(languagePreset("python")).toBe("python");
  for (const language of ["json", "yaml", "go", "rust", "plaintext"])
    expect(languagePreset(language)).toBeUndefined();
});

test("project diagnostics replace syntax-only diagnostics only for the exact connected Workspace and language", () => {
  const state = new FactoryLanguageState();
  let changes = 0;
  const subscription = state.subscribe(() => changes++);
  state.set("workspace-a", "typescript", true);
  state.set("workspace-a", "typescript", true);
  expect(changes).toBe(1);
  expect(state.has("workspace-a", "typescript")).toBe(true);
  expect(state.has("workspace-b", "typescript")).toBe(false);
  expect(state.has("workspace-a", "python")).toBe(false);
  state.set("workspace-a", "typescript", false);
  expect(state.has("workspace-a", "typescript")).toBe(false);
  subscription.dispose();
  state.set("workspace-b", "python", true);
  expect(changes).toBe(2);
});
