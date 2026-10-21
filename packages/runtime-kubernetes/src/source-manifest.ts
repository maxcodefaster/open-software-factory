import type { WorkspaceSourceIdentity } from "../../workspace-domain/src/source";
import { runtimeVolumeClaimSpec } from "./storage";
import { runtimeNodeSelector } from "./config";

export interface WorkspaceSourceManifest {
  readonly identity: WorkspaceSourceIdentity;
  readonly projectID: string;
  readonly namespace: string;
  readonly revision: string;
  readonly repositoryURL: string;
  readonly originURL: string;
  readonly capability: string;
  readonly filesImage: string;
  readonly storageNode: string | null;
}

export function renderWorkspaceSourceResources(input: WorkspaceSourceManifest) {
  for (const image of [input.filesImage]) {
    if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Workspace source artifacts must be pinned by digest");
  }
  const ownerLabels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/project": input.projectID,
    "factory.dev/runtime-owner": input.identity.workspaceID,
  };
  const labels = {
    ...ownerLabels,
    "factory.dev/source-service": input.identity.serviceID,
    "factory.dev/source-epoch": String(input.identity.epoch),
  };
  const assignment = {
    workspaceId: input.identity.workspaceID,
    serviceId: input.identity.serviceID,
    epoch: input.identity.epoch,
    token: input.capability,
  };
  const initialize = {
    workspaceId: input.identity.workspaceID,
    projectId: input.projectID,
    revision: input.revision,
    repositoryUrl: input.repositoryURL,
    originUrl: input.originURL,
  };
  return [
    {
      apiVersion: "v1",
      kind: "Namespace" as const,
      metadata: { name: input.namespace, labels: ownerLabels },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim" as const,
      metadata: { name: "runtime-data", namespace: input.namespace, labels: ownerLabels },
      spec: runtimeVolumeClaimSpec(),
    },
    {
      apiVersion: "v1",
      kind: "Secret" as const,
      metadata: { name: input.identity.secretName, namespace: input.namespace, labels },
      stringData: {
        "access.json": JSON.stringify(assignment),
        "initialize.json": JSON.stringify(initialize),
      },
    },
    {
      apiVersion: "v1",
      kind: "Pod" as const,
      metadata: { name: input.identity.podName, namespace: input.namespace, labels },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        shareProcessNamespace: false,
        nodeSelector: runtimeNodeSelector(input.storageNode ?? undefined),
        securityContext: { seccompProfile: { type: "RuntimeDefault" } },
        initContainers: [],
        containers: [
          {
            name: "source",
            image: input.filesImage,
            imagePullPolicy: "IfNotPresent",
            args: [
              "--root",
              "/data/home/project",
              "--parent",
              "/data/home",
              "--initialize",
              "/assignment/initialize.json",
              "--assignment",
              "/assignment/access.json",
              "--listen",
              "0.0.0.0:4600",
            ],
            resources: {
              requests: { cpu: "50m", memory: "32Mi" },
              limits: { cpu: "1", memory: "256Mi" },
            },
            securityContext: {
              runAsUser: 0,
              runAsGroup: 0,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: {
                drop: ["ALL"],
                add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
              },
            },
            readinessProbe: { tcpSocket: { port: 4600 }, periodSeconds: 1, failureThreshold: 3 },
            volumeMounts: [
              { name: "data", mountPath: "/data/home", subPath: "home" },
              { name: "assignment", mountPath: "/assignment", readOnly: true },
              { name: "temporary", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "runtime-data" } },
          {
            name: "assignment",
            secret: { secretName: input.identity.secretName, defaultMode: 292 },
          },
          { name: "temporary", emptyDir: { sizeLimit: "256Mi" } },
        ],
      },
    },
  ];
}
