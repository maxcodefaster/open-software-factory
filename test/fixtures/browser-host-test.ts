import { type BrowserHost, ownedBrowserHost } from "./browser-host";
import { test as browserTest } from "./browser-test";

export const test = browserTest.extend<{ browserHost: BrowserHost }>({
  browserHost: [
    async ({ browser }, use) => {
      if (!browser.isConnected()) throw new Error("Owned browser is disconnected");
      const fixture = await ownedBrowserHost();
      try {
        await use(fixture);
      } finally {
        // Independent of context/database cleanup, including a rejected test body.
        await fixture.dispose();
      }
    },
    { timeout: 120_000 },
  ],
});
