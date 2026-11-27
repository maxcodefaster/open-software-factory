import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { nativeRuntime, substrateConnection } from "#runtime-kubernetes/substrate-control";
import { substrateResources } from "./substrate-resources";

const installationConfiguration = z.strictObject({
  deployment: z.enum(["owned-test", "fresh-workspaces"]),
  database: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  connection: substrateConnection,
  provisioner: substrateConnection,
  editorPrincipal: z.string().regex(/^user:system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/),
  connectorURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/internal/runtime-connect"
    );
  }),
  factoryCAFile: z.string().startsWith("/"),
  workloadImage: z.string().regex(/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/),
  resources: substrateResources.optional(),
  profile: z.literal("nightly-20261109-975fb172241c"),
  runtime: nativeRuntime,
  workerSelector: z
    .record(z.string(), z.string())
    .refine(
      (labels) =>
        labels["factory.runtime/profile"] === "nightly-20261109-975fb172241c" &&
        Boolean(labels["factory.dev/deployment"]),
    ),
  egressHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
});
const workspaceConfiguration = installationConfiguration.extend({ projectID: z.uuid() });

export type SubstrateInstallationConfiguration = z.infer<typeof installationConfiguration>;
export type SubstrateWorkspaceConfiguration = z.infer<typeof workspaceConfiguration>;

export function substrateInstallationConfiguration(
  input: unknown,
): SubstrateInstallationConfiguration {
  const parsed = installationConfiguration.parse(input);
  // Freeze current defaults before creating a new owner. Persisted configuration
  // without resources keeps its original implicit limits during continuation.
  return { ...parsed, resources: parsed.resources ?? { cpuMilli: 1500, memoryMiB: 3072 } };
}

export function substrateWorkspaceConfiguration(input: unknown) {
  return workspaceConfiguration.parse(input);
}

export function retainedSubstrateConfiguration(
  desired: SubstrateWorkspaceConfiguration,
  value: unknown,
) {
  const retained = workspaceConfiguration.parse(value);
  const selected = { ...desired, workloadImage: retained.workloadImage };
  // An operator may admit another download host for fresh generations. Keep
  // this owner's exact original policy; never add hosts to a retained Actor.
  // A removed admission still invalidates continuation rather than ignoring it.
  if (retained.egressHosts.every((host) => desired.egressHosts.includes(host)))
    selected.egressHosts = retained.egressHosts;
  if (retained.resources) selected.resources = retained.resources;
  else delete selected.resources;
  if (!isDeepStrictEqual(retained, selected))
    throw new Error("Native provisioning configuration differs from immutable intent");
  return retained;
}

export function configuredSubstrateInstallation() {
  const file = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  return file
    ? substrateInstallationConfiguration(JSON.parse(readFileSync(file, "utf8")))
    : undefined;
}
