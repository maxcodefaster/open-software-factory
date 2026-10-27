import type { DeveloperIDEIdentity } from "../../workspace-domain/src/developer-ide";
import { runtimeNodeSelector } from "./config";

export interface DeveloperIDEResources {
  readonly identity: DeveloperIDEIdentity;
  readonly image: string;
  readonly namespaceUID: string | null;
  readonly podUID: string | null;
}

export function renderDeveloperIDEResources(input: DeveloperIDEResources) {
  if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(input.image))
    throw new Error("Developer IDE image must be pinned by digest");
  const owner = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/runtime-owner": input.identity.userID,
  };
  const labels = {
    ...owner,
    "factory.dev/editor-service": input.identity.serviceID,
    "factory.dev/editor-epoch": String(input.identity.epoch),
  };
  return [
    {
      apiVersion: "v1",
      kind: "Namespace" as const,
      metadata: { name: input.identity.namespace, labels: owner },
    },
    {
      apiVersion: "v1",
      kind: "Pod" as const,
      metadata: { name: input.identity.podName, namespace: input.identity.namespace, labels },
      spec: {
        nodeSelector: runtimeNodeSelector(),
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        shareProcessNamespace: false,
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "editor",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "50m", memory: "256Mi" },
              limits: { cpu: "1", memory: "768Mi" },
            },
            readinessProbe: {
              httpGet: { path: "/", port: 4400 },
              periodSeconds: 1,
              failureThreshold: 3,
            },
            volumeMounts: [
              { name: "home", mountPath: "/home/node" },
              { name: "temporary", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "home", emptyDir: { sizeLimit: "256Mi" } },
          { name: "temporary", emptyDir: { sizeLimit: "256Mi" } },
        ],
      },
    },
  ];
}
