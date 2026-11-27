import { isIP } from "node:net";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { runtimeArtifactsSchema } from "../../scripts/factory/artifacts";
import { requireNativeRuntimeArtifact } from "../../scripts/factory/native-installation";

// Reuse the published native Starter image, not a separately commissioned
// private-registry fixture. Image identity, TLS origin and installation egress
// remain explicit gates; Environment saves cannot commission image pulls.
export function nativeEnvironmentImage(
  value: unknown,
  configuration: SubstrateInstallationConfiguration,
) {
  const artifacts = runtimeArtifactsSchema.parse(value);
  requireNativeRuntimeArtifact(configuration, artifacts);
  const image = artifacts["starter-work"];
  const registry = new URL(`https://${image.split("/")[0]}`);
  if (
    registry.port ||
    isIP(registry.hostname) ||
    !registry.hostname.includes(".") ||
    registry.hostname.endsWith(".localhost") ||
    !configuration.egressHosts.includes(registry.host)
  )
    throw Error("Native Environment image requires an admitted TLS registry origin");
  return image;
}
