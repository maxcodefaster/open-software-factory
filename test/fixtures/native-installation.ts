import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import pins from "../../deploy/substrate/pins.json";

/** Configuration data only. This fixture creates no native resources. */
export function nativeInstallationFixture(): SubstrateInstallationConfiguration {
  const connection: SubstrateInstallationConfiguration["connection"] = {
    bridge: "/usr/local/bin/factory-substrate-control",
    endpoint: "api.ate-system.svc:443",
    serverName: "api.ate-system.svc",
    caFile: "/run/factory/substrate-control/ca.pem",
    tokenFile: "/run/factory/substrate-control/token",
  };
  return {
    deployment: "fresh-workspaces",
    database: "factory",
    connection,
    provisioner: { ...connection, tokenFile: "/run/factory/substrate-provisioner/token" },
    editorPrincipal: "user:system:serviceaccount:factory:factory",
    connectorURL: "wss://factory.example/internal/runtime-connect",
    factoryCAFile: "/run/factory/substrate-configuration/factory-ca.pem",
    workloadImage: `registry.example/factory-runtime@sha256:${"a".repeat(64)}`,
    resources: { cpuMilli: 2000, memoryMiB: 4096 },
    profile: pins.gvisor.version as SubstrateInstallationConfiguration["profile"],
    runtime: {
      sandboxClass: "gvisor",
      version: {
        schemaVersion: "v1",
        attributes: [
          { key: "architecture", value: "amd64" },
          { key: "sandbox_bundle_hash", value: `sha256:${"b".repeat(64)}` },
        ],
      },
    },
    workerSelector: {
      "factory.runtime/profile": pins.gvisor.version,
      "factory.dev/deployment": "native-proof",
    },
    egressHosts: ["git.example"],
  };
}
