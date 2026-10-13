import { defineConfig } from "@playwright/test";

const { PLAYWRIGHT_CHROMIUM_EXECUTABLE } = process.env;

export default defineConfig({
  testDir: "test/browser",
  timeout: 360_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  workers: 1,
});
