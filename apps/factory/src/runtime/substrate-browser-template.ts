import { z } from "zod";

export const substrateBrowserResources = { cpuMilli: 1000, memoryMiB: 1536 } as const;

const browserInput = z.strictObject({
  atespace: z.string().regex(/^fa-[a-f0-9]{32}$/),
  image: z.string().regex(/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/),
  workerSelector: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0),
  runtimeAttemptId: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: z.uuid(),
  turnId: z.uuid(),
  agentSessionId: z.string().startsWith("ses").max(200),
  ownerId: z.string().regex(/^[a-f0-9]{64}$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  apps: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        kind: z.literal("app"),
        target: z.string().url(),
        healthPath: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
});

// A Browser has no Project checkout, global credentials or Project containers.
// Placement and lifecycle remain ordinary pinned native Substrate operations.
export function renderSubstrateBrowserTemplate(input: z.infer<typeof browserInput>) {
  const value = browserInput.parse(input);
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const app of value.apps) {
    const target = new URL(app.target);
    if (
      target.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(target.hostname) ||
      !target.port ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      target.pathname !== "/" ||
      names.has(app.name) ||
      targets.has(target.port)
    )
      throw new Error("Native Browser requires unique declared local Apps");
    names.add(app.name);
    targets.add(target.port);
  }
  const bootstrap = {
    version: 1,
    runtimeAttemptId: value.runtimeAttemptId,
    generation: value.generation,
    scope: {
      sessionId: value.sessionId,
      turnId: value.turnId,
      agentSessionId: value.agentSessionId,
      ownerId: value.ownerId,
    },
    apps: value.apps,
    token: value.token,
  };
  return {
    metadata: {
      atespace: value.atespace,
      name: `browser-${value.sessionId.replaceAll("-", "")}`,
    },
    workerSelector: { matchLabels: { ...value.workerSelector } },
    resources: {
      limits: {
        cpuMillicores: String(substrateBrowserResources.cpuMilli),
        memoryBytes: String(substrateBrowserResources.memoryMiB * 1024 ** 2),
      },
    },
    // Browser state is ephemeral per execution owner. Factory deletes this
    // Actor; it never promises to resume cookies or replay a Browser operation.
    snapshotConfig: {
      preferredFidelity: "SNAPSHOT_FIDELITY_ROOTFS",
      goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
    },
    containers: [
      {
        name: "browser",
        image: value.image,
        command: ["/usr/local/bin/factory-native-browser"],
        env: [{ name: "FACTORY_NATIVE_BROWSER_BOOTSTRAP", value: JSON.stringify(bootstrap) }],
        securityContext: {
          capabilities: {
            drop: ["ALL"],
            add: ["SETUID", "SETGID", "CHOWN", "KILL", "NET_BIND_SERVICE"],
          },
        },
        wakeupProbe: { httpGet: { path: "/readyz", port: 80 }, timeoutSeconds: 120 },
        volumeMounts: [{ name: "identity", mountPath: "/run/ate/identity" }],
      },
    ],
    volumes: [
      {
        name: "identity",
        systemInfo: {
          dataSources: [
            { actorMetadata: { items: [{ field: "ACTOR_METADATA_FIELD_UID", path: "uid" }] } },
          ],
        },
      },
    ],
  };
}
