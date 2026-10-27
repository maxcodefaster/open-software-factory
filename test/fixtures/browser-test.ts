import { expect, test as base } from "@playwright/test";
import { observeBrowserErrors } from "./browser-errors";

export const test = base.extend<{ solidDiagnostics: undefined }>({
  solidDiagnostics: [
    async ({ context }, use) => {
      const errors: string[][] = [];
      for (const page of context.pages()) errors.push(observeBrowserErrors(page));
      context.on("page", (page) => errors.push(observeBrowserErrors(page)));
      await use(undefined);
      expect(
        errors.flat(),
        "Structural Solid diagnostics must not be hidden by passing UI assertions",
      ).toEqual([]);
    },
    { auto: true },
  ],
});
