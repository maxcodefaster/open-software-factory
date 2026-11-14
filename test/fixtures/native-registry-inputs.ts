import { isIP } from "node:net";
import { z } from "zod";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";

const image = z
  .string()
  .regex(
    /^[a-z0-9.-]+\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/,
  );
const inputs = z.strictObject({
  owner: z.uuid(),
  deployment: z.string().min(1),
  host: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .refine((host) => !isIP(host) && host.includes(".") && !host.endsWith(".localhost")),
  username: z.string().min(1),
  password: z.string().min(1),
  certificate: z
    .string()
    .includes("-----BEGIN CERTIFICATE-----")
    .refine((value) => !value.includes("PRIVATE KEY")),
  developmentImage: image,
  feature: image,
});

// Operator-commissioned private registry in the same explicitly owned native
// fixture. The proof owns only its new Project/publication namespace, not this
// shared fixture's TLS front door or registry service.
export function nativeRegistryInputs(
  value: unknown,
  configuration: SubstrateInstallationConfiguration,
) {
  const parsed = inputs.parse(value);
  const prefix = `${parsed.host}/open-factory/native-fixtures/${parsed.owner}/`;
  if (
    parsed.deployment !== configuration.workerSelector["factory.dev/deployment"] ||
    parsed.host !== configuration.prebuildRegistry ||
    !configuration.egressHosts.includes(parsed.host) ||
    !parsed.developmentImage.startsWith(prefix) ||
    !parsed.feature.startsWith(prefix)
  )
    throw Error("Native registry inputs differ from the commissioned TLS/egress fixture");
  return parsed;
}
