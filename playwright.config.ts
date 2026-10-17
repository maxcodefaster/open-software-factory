import { defineConfig } from "@playwright/test";
import { browserFiles, mixedPaidBrowserFiles } from "./scripts/testing/lanes";

const { PLAYWRIGHT_CHROMIUM_EXECUTABLE } = process.env;
const lane = process.env["FACTORY_BROWSER_LANE"] ?? "ui";
if (!["ui", "native", "paid", "manual"].includes(lane))
  throw new Error("Unknown browser test lane");
const files = Object.values(browserFiles).flat();

export default defineConfig({
  testDir: "test/browser",
  testMatch:
    lane === "ui"
      ? "**/*.spec.ts"
      : lane === "paid"
        ? [...browserFiles.paid, ...mixedPaidBrowserFiles]
        : browserFiles[lane as keyof typeof browserFiles],
  testIgnore: lane === "ui" ? files.map((name) => `**/${name}`) : [],
  ...(lane === "ui" ? { grepInvert: /@paid\b/ } : {}),
  outputDir: `.factory/test-results/browser-${lane}`,
  timeout: lane === "ui" ? 180_000 : 720_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    trace: "retain-on-failure",
    ...(PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  workers: 1,
});
