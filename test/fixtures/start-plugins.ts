import { tanstackStart } from "@tanstack/solid-start/plugin/vite";

// Component fixtures compile the same Start functions as the application.
// Their explicit .html entry still owns the rendered component under test.
// Builds select that page in the client environment, not Start's document entry.
export function factoryFixtureStart(entry?: string) {
  return [
    tanstackStart({
      srcDirectory: "../../apps/factory/src",
      server: { entry: "./start-server.ts" },
      serverFns: { base: "/_server" },
      vite: { installDevServerMiddleware: false },
    }),
    {
      name: "factory-owned-component-pages",
      enforce: "post" as const,
      config() {
        return { appType: "mpa" as const };
      },
      configEnvironment(name: string) {
        if (entry && name === "client") return { build: { rolldownOptions: { input: entry } } };
        return undefined;
      },
    },
  ];
}
