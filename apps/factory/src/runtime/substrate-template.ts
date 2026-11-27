import { readFileSync } from "node:fs";
import {
  type SubstrateProjectTemplate,
  substrateProjectSource,
} from "#runtime-kubernetes/substrate-project-template";
import { substrateResourceReservation } from "./substrate-resources";

type SubstrateBootstrap = {
  assignment: {
    version: number;
    runtimeAttemptId: string;
    generation: number;
    controlUrl: string;
    environmentVersion: number;
    actorTemplatePath: string;
    workspaceFolder: string;
    remoteWorkspaceFolder: string;
    checkoutFolder?: string;
    connectorStateDir?: string;
    [key: string]: unknown;
  };
  source: unknown;
  sourceHandoff?: boolean;
  inputStop?: { version: number; openCodeVersion: string };
  projectTemplate?: { path: string; sha256: string };
  parentToken: string;
  childToken: string;
  factoryCA: string;
  entryTokens: Record<string, string>;
};

export function substrateBootstrapCA(factoryCAFile: string) {
  const publicCA = (file: string) => {
    const pem = readFileSync(file, "utf8");
    if (!pem.includes("-----BEGIN CERTIFICATE-----") || pem.includes("PRIVATE KEY"))
      throw new Error("Native bootstrap trust must contain public certificates only");
    return pem;
  };
  const factoryCA = publicCA(factoryCAFile);
  const registryCAFile = process.env["FACTORY_REGISTRY_CA_FILE"];
  // The chart's default is not extra trust: Substrate already supplies system roots.
  // Keep the original bytes (and template hash) when no additional CA is admitted.
  if (
    !registryCAFile ||
    registryCAFile === "/etc/ssl/certs/ca-certificates.crt" ||
    registryCAFile === factoryCAFile
  )
    return factoryCA;
  const registryCA = publicCA(registryCAFile).trim();
  return factoryCA.includes(registryCA) ? factoryCA : `${factoryCA.trimEnd()}\n${registryCA}\n`;
}

// The trusted control and direct Project containers share Source, not control
// state or Parent authority. The Project fragment has already passed admission.
export function renderSubstrateTemplate(
  atespace: string,
  config: {
    workloadImage: string;
    workerSelector: Record<string, string>;
    resources?: { cpuMilli: number; memoryMiB: number } | undefined;
  },
  bootstrap: SubstrateBootstrap,
  projectTemplate: SubstrateProjectTemplate,
) {
  const resources = substrateResourceReservation(config);
  const project = structuredClone(projectTemplate);
  if (
    project.volumes.some(
      (volume) =>
        volume.name === "factory-state" ||
        volume.name === "factory-public" ||
        volume.name === "factory-skills",
    )
  )
    throw new Error("Factory state and public trust volumes belong to Factory control");
  const toolsPath = "/opt/factory-tools";
  const publicTrustPath = "/run/factory-public";
  const skillsPath = "/run/factory-skills";
  const projectTransportEnv = ["SSL_CERT_FILE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"].map(
    (name) => ({ name, value: `${publicTrustPath}/trust.pem` }),
  );
  const reservedEnv = new Set([
    "FACTORY_NATIVE_PROJECT",
    ...projectTransportEnv.map(({ name }) => name),
  ]);
  const nativeMounts = [
    { name: "factory-public", mountPath: publicTrustPath },
    { name: "factory-trust", mountPath: "/run/ate/egress-trust-bundle" },
    { name: "factory-identity", mountPath: "/run/ate/identity" },
  ];
  const controlCheckout = "/var/lib/factory/source/project";
  const projectCheckout = `${substrateProjectSource(project)}/project`;
  const { entryTokens, ...controlBootstrap } = structuredClone(bootstrap);
  const assignmentAt = (checkout: string, connectorStateDir: string) => ({
    ...structuredClone(bootstrap.assignment),
    workspaceFolder: checkout,
    remoteWorkspaceFolder: checkout,
    ...(bootstrap.assignment.checkoutFolder === undefined ? {} : { checkoutFolder: checkout }),
    connectorStateDir,
  });
  controlBootstrap.assignment = assignmentAt(controlCheckout, "/var/lib/factory/control");
  const containers = project.containers.map(
    ({ command, args, env, volumeMounts, ...container }) => {
      const entryToken = entryTokens[container.name];
      if (!entryToken) throw new Error(`Native Project entry token is missing: ${container.name}`);
      if (
        volumeMounts?.some(({ mountPath }) =>
          [toolsPath, publicTrustPath, skillsPath].some(
            (path) =>
              mountPath === path ||
              mountPath.startsWith(`${path}/`) ||
              path.startsWith(`${mountPath}/`),
          ),
        )
      )
        throw new Error("Project volumes must not overlap Factory tools, public trust or Skills");
      const work = container.name === "work";
      const argv = [...(command ?? []), ...(args ?? [])];
      const nativeProject = {
        container: container.name,
        entryToken,
        factoryCA: bootstrap.factoryCA,
        assignment: work
          ? assignmentAt(projectCheckout, "/tmp/factory-connector")
          : {
              version: bootstrap.assignment.version,
              runtimeAttemptId: bootstrap.assignment.runtimeAttemptId,
              generation: bootstrap.assignment.generation,
              controlUrl: bootstrap.assignment.controlUrl,
              environmentVersion: bootstrap.assignment.environmentVersion,
            },
        ...(work
          ? {
              childToken: bootstrap.childToken,
              ...(command ? { preparation: { command: argv } } : {}),
            }
          : { command: argv }),
      };
      return {
        ...container,
        command: [`${toolsPath}/usr/local/bin/factory-runtime-connector`, "native-project"],
        env: [
          ...(env ?? []).filter(({ name }) => !reservedEnv.has(name)),
          { name: "FACTORY_NATIVE_PROJECT", value: JSON.stringify(nativeProject) },
          ...structuredClone(projectTransportEnv),
        ],
        securityContext: { capabilities: { drop: ["ALL"] } },
        volumeMounts: [
          ...(volumeMounts ?? []),
          { name: "factory-tools", mountPath: toolsPath },
          ...(work ? [{ name: "factory-skills", mountPath: skillsPath }] : []),
          ...structuredClone(nativeMounts),
        ],
      };
    },
  );
  return {
    metadata: { atespace, name: "runtime" },
    containers: [
      {
        name: "factory-control",
        image: config.workloadImage,
        command: ["/usr/local/bin/factory-runtime-connector", "native-parent"],
        env: [{ name: "FACTORY_SUBSTRATE_BOOTSTRAP", value: JSON.stringify(controlBootstrap) }],
        securityContext: {
          capabilities: {
            drop: ["ALL"],
            add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"],
          },
        },
        volumeMounts: [
          { name: "source", mountPath: "/var/lib/factory/source" },
          { name: "factory-state", mountPath: "/var/lib/factory/control" },
          { name: "factory-skills", mountPath: "/var/lib/factory/skills" },
          ...structuredClone(nativeMounts),
        ],
        wakeupProbe: { httpGet: { path: "/readyz", port: 18081 }, timeoutSeconds: 300 },
      },
      ...containers,
    ],
    resources: {
      limits: {
        cpuMillicores: String(resources.cpuMilli),
        memoryBytes: String(resources.memoryMiB * 1024 ** 2),
      },
    },
    snapshotConfig: {
      preferredFidelity: project.snapshotConfig?.preferredFidelity ?? "SNAPSHOT_FIDELITY_MEMORY",
      goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
    },
    volumes: [
      ...project.volumes,
      { name: "factory-state", durableDir: {} },
      { name: "factory-public", durableDir: {} },
      { name: "factory-skills", durableDir: {} },
      { name: "factory-tools", image: { reference: config.workloadImage } },
      {
        name: "factory-trust",
        systemInfo: {
          dataSources: [
            {
              trustBundle: {
                names: ["egress-mitm.ate.dev", "system-roots.ate.dev"],
                path: "trust-bundle.pem",
              },
            },
          ],
        },
      },
      {
        name: "factory-identity",
        systemInfo: {
          dataSources: [
            { actorMetadata: { items: [{ field: "ACTOR_METADATA_FIELD_UID", path: "uid" }] } },
          ],
        },
      },
    ],
    workerSelector: { matchLabels: { ...config.workerSelector } },
  };
}
