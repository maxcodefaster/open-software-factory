import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import { substrateRepositoryCloneURL } from "../../apps/factory/src/runtime/endpoints";
import { substrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { nativeStarterImages } from "../../apps/factory/src/setup/starter";
import { type RuntimeArtifacts, runtimeImageReference } from "./artifacts";

/** Validate the concrete native installation before changing installation resources. */
export function requireNativeInstallation(
  environment: Record<string, string | undefined> = process.env,
  expected?: { database?: string; editorPrincipal?: string },
) {
  const file = environment["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  if (!file) throw new Error("Factory startup requires FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION");
  const configuration = substrateInstallationConfiguration(JSON.parse(readFileSync(file, "utf8")));
  if (configuration.deployment !== "fresh-workspaces")
    throw new Error("Factory installation requires the normal fresh-workspaces Substrate path");
  nativeRuntimeArchitecture(configuration.runtime);
  const database =
    expected?.database ??
    (environment["DATABASE_URL"]
      ? new URL(environment["DATABASE_URL"]).pathname.slice(1)
      : undefined);
  if (database && configuration.database !== database)
    throw new Error("Substrate installation configuration names a different Factory database");
  if (expected?.editorPrincipal && configuration.editorPrincipal !== expected.editorPrincipal)
    throw new Error("Substrate Editor identity differs from this Factory ServiceAccount");
  return configuration;
}

export function requireNativeForgeOrigin(
  environment: Record<string, string | undefined>,
  configuration: ReturnType<typeof requireNativeInstallation>,
) {
  const origin = environment["FACTORY_FORGEJO_PUBLIC_URL"];
  if (!origin) throw new Error("Native installation requires the Forge HTTPS origin");
  const repository = new URL("/factory/bootstrap.git", origin);
  return new URL(substrateRepositoryCloneURL(repository.href, configuration, environment)).origin;
}

export function requireNativeRuntimeArtifact(
  configuration: ReturnType<typeof requireNativeInstallation>,
  artifacts: RuntimeArtifacts,
) {
  if (configuration.workloadImage !== artifacts["substrate-runtime"])
    throw new Error(
      "Substrate workloadImage differs from the exact Actor image in this Factory artifact generation",
    );
}

export function requireNativeBrowserImage(environment: Record<string, string | undefined>) {
  const image = environment["FACTORY_BROWSER_TOOLS_IMAGE"];
  if (!image) throw new Error("Source publication requires a released FACTORY_BROWSER_TOOLS_IMAGE");
  runtimeImageReference.parse(image);
  const registry = new URL(`https://${image.split("/")[0]}`);
  if (registry.port || isIP(registry.hostname) || !registry.hostname.includes("."))
    throw new Error("Native browser tools require a TLS registry DNS name on port 443");
  return image;
}

export function requireNativeStarterImages(
  environment: Record<string, string | undefined> = process.env,
) {
  const configuration = requireNativeInstallation(environment);
  const raw = environment["FACTORY_STARTER_IMAGES"];
  let catalog: unknown;
  try {
    catalog = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error("FACTORY_STARTER_IMAGES must contain the published native image catalog");
  }
  return nativeStarterImages(`linux/${nativeRuntimeArchitecture(configuration.runtime)}`, catalog);
}
