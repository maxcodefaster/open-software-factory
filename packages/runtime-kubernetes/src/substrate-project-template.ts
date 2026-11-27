import { posix } from "node:path";
import { z } from "zod";
import { environmentManifest } from "#project-domain/environment";

// Project-authored subset of the pinned official ActorTemplate wire format.
// Placement, credentials, Factory containers/tools and golden snapshot policy
// belong to Factory's admitted Attempt; Projects may select snapshot fidelity.
const name = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const image = z
  .string()
  .max(512)
  .regex(/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/, "Use an immutable OCI image digest");
const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const argumentsList = z.array(argument).min(1).max(64);
const reservedNames = new Set([
  "factory-control",
  "factory-tools",
  "factory-trust",
  "factory-identity",
  "factory-state",
  "factory-public",
  "factory-skills",
]);
const reservedPaths = [
  "/opt/factory",
  "/opt/factory-tools",
  "/run/factory-public",
  "/run/factory-skills",
  "/run/ate",
  "/proc",
  "/sys",
  "/dev",
];
const mountPath = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value !== "/" &&
      !value.endsWith("/") &&
      posix.isAbsolute(value) &&
      posix.normalize(value) === value &&
      !/[\0\\]/.test(value) &&
      reservedPaths.every(
        (path) => value !== path && !value.startsWith(`${path}/`) && !path.startsWith(`${value}/`),
      ),
    "Use a clean absolute mount path outside Factory and system paths",
  );
const variableName = environmentManifest.shape.variables.element.shape.name.refine(
  (value) =>
    !value.startsWith("ATE_") &&
    ![
      "SSL_CERT_FILE",
      "GIT_SSL_CAINFO",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
    ].includes(value.toUpperCase()),
  "This variable belongs to Factory's native transport",
);
const container = z.strictObject({
  name,
  image,
  command: argumentsList.optional(),
  args: argumentsList.optional(),
  env: z
    .array(
      z.strictObject({
        name: variableName,
        value: z
          .string()
          .max(32768)
          .refine((value) => !value.includes("\0")),
      }),
    )
    .max(32)
    .optional(),
  volumeMounts: z.array(z.strictObject({ name, mountPath })).max(16).optional(),
  wakeupProbe: z
    .strictObject({
      httpGet: z.strictObject({
        path: z
          .string()
          .max(256)
          .refine(
            (value) => value.startsWith("/") && !value.startsWith("//") && !/[?#\0]/.test(value),
          ),
        port: z.number().int().min(1024).max(65535),
      }),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    })
    .optional(),
});

export const substrateProjectTemplate = z
  .strictObject({
    containers: z.array(container).min(1).max(8),
    volumes: z
      .array(z.strictObject({ name, durableDir: z.strictObject({}) }))
      .min(1)
      .max(8),
    snapshotConfig: z
      .strictObject({
        preferredFidelity: z.enum(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"]),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const containerNames = value.containers.map((item) => item.name);
    const volumeNames = value.volumes.map((item) => item.name);
    if (new Set(containerNames).size !== containerNames.length)
      issue(["containers"], "Container names must be unique");
    if (new Set(volumeNames).size !== volumeNames.length)
      issue(["volumes"], "Volume names must be unique");
    if (!containerNames.includes("work"))
      issue(["containers"], "One native work container is required");
    if (!volumeNames.includes("source"))
      issue(["volumes"], "One source durable directory is required");
    const mounted = new Set<string>();
    const ports = new Set<number>();
    const workVolumes = new Set(
      value.containers
        .find((item) => item.name === "work")
        ?.volumeMounts?.map((mount) => mount.name),
    );
    for (const [index, item] of value.containers.entries()) {
      if (reservedNames.has(item.name))
        issue(["containers", index, "name"], "Container name is reserved by Factory");
      if (item.name === "work") {
        if (item.wakeupProbe)
          issue(["containers", index], "Factory owns the work container readiness");
        if (item.args && !item.command)
          issue(
            ["containers", index, "args"],
            "Work arguments require an explicit preparation command",
          );
        if (item.volumeMounts?.filter((mount) => mount.name === "source").length !== 1)
          issue(
            ["containers", index, "volumeMounts"],
            "The work container must mount source exactly once",
          );
      } else if (!item.command) {
        issue(
          ["containers", index, "command"],
          "Native services need an explicit entrypoint command",
        );
      }
      const variables = item.env?.map((variable) => variable.name) ?? [];
      if (new Set(variables).size !== variables.length)
        issue(["containers", index, "env"], "Environment variable names must be unique");
      const paths: string[] = [];
      const mountNames = new Set<string>();
      for (const [mountIndex, mount] of (item.volumeMounts ?? []).entries()) {
        if (item.name !== "work" && workVolumes.has(mount.name))
          issue(
            ["containers", index, "volumeMounts", mountIndex],
            "Source and work directories must not be shared with native services; run source-based Apps in work",
          );
        if (!volumeNames.includes(mount.name))
          issue(
            ["containers", index, "volumeMounts", mountIndex],
            "Mount names an undeclared volume",
          );
        if (mountNames.has(mount.name))
          issue(
            ["containers", index, "volumeMounts", mountIndex],
            "Mount a durable directory once per container",
          );
        if (
          paths.some(
            (path) =>
              path === mount.mountPath ||
              path.startsWith(`${mount.mountPath}/`) ||
              mount.mountPath.startsWith(`${path}/`),
          )
        )
          issue(
            ["containers", index, "volumeMounts", mountIndex],
            "Native volume mounts must not overlap",
          );
        mountNames.add(mount.name);
        mounted.add(mount.name);
        paths.push(mount.mountPath);
      }
      const port = item.wakeupProbe?.httpGet.port;
      if (port !== undefined) {
        if (port === 18081 || port === 18082 || ports.has(port))
          issue(
            ["containers", index, "wakeupProbe"],
            "Readiness port conflicts inside the shared Actor network",
          );
        ports.add(port);
      }
    }
    for (const [index, volume] of value.volumes.entries()) {
      if (reservedNames.has(volume.name))
        issue(["volumes", index, "name"], "Volume name is reserved by Factory");
      if (!mounted.has(volume.name))
        issue(["volumes", index], "Every declared durable directory must be mounted");
    }
  });

export type SubstrateProjectTemplate = z.output<typeof substrateProjectTemplate>;

export class SubstrateProjectTemplateError extends Error {
  override readonly name = "SubstrateProjectTemplateError";
}

export function parseSubstrateProjectTemplate(content: string): SubstrateProjectTemplate {
  if (Buffer.byteLength(content) > 64 * 1024)
    throw new SubstrateProjectTemplateError("Project ActorTemplate exceeds 64 KiB");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new SubstrateProjectTemplateError("Project ActorTemplate must be valid JSON");
  }
  const parsed = substrateProjectTemplate.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SubstrateProjectTemplateError(
      `Project ActorTemplate is invalid at ${issue?.path.join(".") || "template"}: ${issue?.message}`,
    );
  }
  return parsed.data;
}

export function substrateProjectSource(template: SubstrateProjectTemplate) {
  const work = template.containers.find((item) => item.name === "work");
  const source = work?.volumeMounts?.find((item) => item.name === "source");
  if (!source) throw new Error("The native work Source mount is unavailable");
  return source.mountPath;
}
