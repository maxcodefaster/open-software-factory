import upstream from "../../../upstream.json" with { type: "json" };
import { type ComputeClass, computeReservation } from "../../runtime-domain/src/compute";
import { runtimeNodeSelector } from "./config";

export type { ComputeClass } from "../../runtime-domain/src/compute";

const dockerBootstrap =
  'set -eu\ntest -z "$' +
  "{CODER_AGENT_URL:-}\" || { echo 'CODER_AGENT_URL is forbidden' >&2; exit 1; }\nunset CODER_AGENT_TOKEN CODER_AGENT_SUBSYSTEM CODER_AGENT_URL\n";

function registryCertificatePath(image: string) {
  const authority = image.split("/")[0];
  if (!authority || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(authority) || !image.includes("/"))
    throw new Error("Envbox requires a qualified registry image");
  return `/etc/docker/certs.d/${authority}/ca.crt`;
}

export function renderEnvboxPod(input: {
  readonly namespace: string;
  readonly podName: string;
  readonly hostname: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly runtimeHostImage: string;
  readonly mode: ComputeClass;
  readonly storageNode?: string;
  readonly reserve?: boolean;
}) {
  const mode = input.mode;
  const reservation = computeReservation(mode);
  const certificatePath = registryCertificatePath(input.runtimeHostImage);
  return {
    apiVersion: "v1",
    kind: "Pod" as const,
    metadata: { name: input.podName, namespace: input.namespace, labels: input.labels },
    spec: {
      restartPolicy: "Never",
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      nodeSelector: runtimeNodeSelector(input.storageNode),
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 120,
      containers: [
        {
          name: "envbox",
          image: upstream.envbox.image,
          imagePullPolicy: "IfNotPresent",
          command: ["/envbox", "docker"],
          securityContext: { privileged: true },
          resources: {
            requests: {
              cpu: `${reservation.cpuMilli}m`,
              memory: `${reservation.memoryMiB}Mi`,
              "ephemeral-storage": mode === "staging" ? "512Mi" : "2Gi",
            },
            limits: {
              cpu: mode === "staging" ? "2" : "6",
              memory: mode === "staging" ? "2Gi" : "8Gi",
              "ephemeral-storage": mode === "staging" ? "2Gi" : "8Gi",
            },
          },
          ...(input.reserve
            ? {
                readinessProbe: {
                  exec: { command: ["sh", "-c", "test -f /home/coder/.factory-reserve/ready"] },
                  periodSeconds: 1,
                  timeoutSeconds: 1,
                  failureThreshold: 3,
                },
              }
            : {}),
          env: [
            { name: "CODER_INNER_IMAGE", value: input.runtimeHostImage },
            { name: "CODER_INNER_USERNAME", value: "root" },
            { name: "CODER_INNER_HOSTNAME", value: input.hostname },
            { name: "CODER_AGENT_TOKEN", value: "unused-required-by-envbox" },
            { name: "FACTORY_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } },
            {
              name: "CODER_MOUNTS",
              value:
                "/home/coder:/home/coder,/factory/assignment:/factory/assignment:ro,/factory/registry-ca:/factory/registry-ca:ro",
            },
            {
              name: "CODER_BOOTSTRAP_SCRIPT",
              value:
                dockerBootstrap +
                `mkdir -p ${certificatePath.slice(0, -"/ca.crt".length)}\ncp /factory/registry-ca/ca.crt ${certificatePath}\ndockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock >/var/log/factory-dockerd.log 2>&1 &\n` +
                (input.reserve
                  ? "exec factory-runtime-connector reserve --slot /factory/assignment/slot.json --activation /home/coder/.factory-reserve/activation.json\n"
                  : "cp /factory/assignment/parent-token /run/factory-parent-token\ncp /factory/assignment/child-token /run/factory-child-token\nchmod 0400 /run/factory-parent-token /run/factory-child-token\nexec factory-runtime-connector parent --assignment /factory/assignment/assignment.json --token-file /run/factory-parent-token --child-token-file /run/factory-child-token\n"),
            },
          ],
          volumeMounts: [
            { name: "assignment", mountPath: "/factory/assignment", readOnly: true },
            { name: "registry-ca", mountPath: "/factory/registry-ca", readOnly: true },
            {
              name: "registry-ca",
              mountPath: certificatePath,
              subPath: "ca.crt",
              readOnly: true,
            },
            { name: "runtime-data", mountPath: "/home/coder", subPath: "home" },
            { name: "runtime-data", mountPath: "/var/lib/coder/docker", subPath: "inner-docker" },
            {
              name: "runtime-data",
              mountPath: "/var/lib/coder/containers",
              subPath: "inner-containers",
            },
            { name: "runtime-data", mountPath: "/var/lib/docker", subPath: "outer-docker" },
            { name: "runtime-data", mountPath: "/var/lib/containers", subPath: "outer-containers" },
            { name: "sysbox-state", mountPath: "/var/lib/sysbox" },
            { name: "kernel-modules", mountPath: "/lib/modules", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "assignment", secret: { secretName: "runtime-assignment", defaultMode: 292 } },
        { name: "registry-ca", secret: { secretName: "registry-ca" } },
        { name: "runtime-data", persistentVolumeClaim: { claimName: "runtime-data" } },
        { name: "sysbox-state", emptyDir: {} },
        { name: "kernel-modules", hostPath: { path: "/lib/modules", type: "Directory" } },
      ],
    },
  };
}
