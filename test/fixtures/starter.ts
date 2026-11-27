import { readFile } from "node:fs/promises";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";

// Controlled source/controller tests only. These references are not published
// images, and must never be supplied to a live native runtime.
export const controlledStarterInput = {
  platform: "linux/arm64",
  images: {
    platform: "linux/arm64",
    development: `registry.example.invalid/controlled-starter-work@sha256:${"a".repeat(64)}`,
    postgres: `registry.example.invalid/controlled-starter-postgres@sha256:${"b".repeat(64)}`,
  },
};

// Direct controller tests run in this process, not the owned Factory child.
// Install only this test's catalog/selection, then restore both exact old values.
export async function installControlledStarterCatalog(nativeConfiguration: string) {
  const configuration = JSON.parse(await readFile(nativeConfiguration, "utf8"));
  if (configuration.deployment !== "owned-test")
    throw new Error("Controlled Starter images must not be used by a live native installation");
  const platform = `linux/${nativeRuntimeArchitecture(configuration.runtime)}`;
  const catalogKey = "FACTORY_STARTER_IMAGES";
  const configurationKey = "FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION";
  const previous = [process.env[catalogKey], process.env[configurationKey]];
  process.env[catalogKey] = JSON.stringify({ ...controlledStarterInput.images, platform });
  process.env[configurationKey] = nativeConfiguration;
  return () => {
    for (const [index, key] of [catalogKey, configurationKey].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
