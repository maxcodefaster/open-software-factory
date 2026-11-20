import { expect, test } from "bun:test";
import { languagePreset } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-language";

test("language preset names its supported languages without implying support for syntax-only files", () => {
  for (const language of ["typescript", "typescriptreact", "javascript", "javascriptreact"])
    expect(languagePreset(language)).toBe("typescript");
  expect(languagePreset("python")).toBe("python");
  for (const language of ["json", "yaml", "go", "rust", "plaintext"])
    expect(languagePreset(language)).toBeUndefined();
});
