import { defineConfig } from "@playwright/test";
import { browserFiles, mixedPaidBrowserFiles } from "./scripts/testing/lanes";

const { PLAYWRIGHT_CHROMIUM_EXECUTABLE } = process.env;
const lane = process.env["FACTORY_BROWSER_LANE"] ?? "ui";
if (!["ui", "native", "paid", "manual"].includes(lane))
  throw new Error("Unknown browser test lane");
const files = Object.values(browserFiles).flat();
const ownedFactoryFiles = [
  "start-navigation.spec.ts",
  "inbox-factory.spec.ts",
  "workspace-efficiency.spec.ts",
  "zero-sync.spec.ts",
];
process.env["FACTORY_BROWSER_RUN_ID"] ??= crypto.randomUUID();

export default defineConfig({
  globalSetup: "./test/fixtures/browser-build.ts",
  testDir: "test/browser",
  testMatch:
    lane === "ui"
      ? "**/*.spec.ts"
      : lane === "paid"
        ? [...browserFiles.paid, ...mixedPaidBrowserFiles]
        : browserFiles[lane as keyof typeof browserFiles],
  testIgnore: lane === "ui" ? files.map((name) => `**/${name}`) : [],
  ...(lane === "ui" ? { grepInvert: /@paid\b/ } : {}),
  ...(lane === "ui"
    ? {
        projects: [
          {
            name: "owned-factory-setup",
            testMatch: "**/owned-factory.setup.ts",
            teardown: "owned-factory-teardown",
          },
          { name: "owned-factory-teardown", testMatch: "**/owned-factory.teardown.ts" },
          {
            name: "owned-factory",
            testMatch: ownedFactoryFiles.map((name) => `**/${name}`),
            dependencies: ["owned-factory-setup"],
          },
          { name: "ui", testIgnore: [...files, ...ownedFactoryFiles].map((name) => `**/${name}`) },
        ],
      }
    : {}),
  outputDir: `.factory/test-results/browser-${lane}/${process.env["FACTORY_BROWSER_RUN_ID"]}`,
  timeout: lane === "ui" ? 180_000 : 720_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env["FACTORY_BROWSER_BASE_URL"] ?? "http://127.0.0.1:3000",
    headless: true,
    trace: "retain-on-failure",
    ...(PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  workers: 1,
});
