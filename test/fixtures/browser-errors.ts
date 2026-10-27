import type { Page } from "@playwright/test";

// Keep native development diagnostics enabled and fail on structural reactivity errors.
const reactivityError =
  /\[(?:STRICT_[A-Z_]+|REACTIVE_WRITE_[A-Z_]+|NO_OWNER_[A-Z_]+|PRIMITIVE_[A-Z_]+|[A-Z_]*CLEANUP[A-Z_]*|REACTIVITY_HALTED|EFFECT_RELAY_TEAR|EFFECT_WRITES_OWN_SOURCE|UNTRACKED_READ_AFTER_AWAIT|UNSTABLE_LIST_IDENTITY)\]/;

export function observeBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (reactivityError.test(message.text())) errors.push(message.text());
  });
  return errors;
}
