import { posix } from "node:path";
import { type ParseError, parse as parseJSONC } from "jsonc-parser";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { SetupInspectionOutput } from "../../../../packages/project-domain/src/setup";
import { parseSystemContract } from "../../../../packages/system-contract/src/system-contract";

export const requiredConfiguration = [
  ".devcontainer/devcontainer.json",
  ".factory/system.json",
  ".forgejo/workflows/factory-verification.yml",
];
export const configurationPath = (path: string) =>
  /^(?:\.devcontainer\/(?:devcontainer\.json|Dockerfile|compose\.ya?ml)|\.factory\/system\.json|\.forgejo\/workflows\/factory-verification\.yml)$/.test(
    path,
  );

const recovery = {
  recipe:
    "The proposal omitted a required recipe file. Retry to request a complete proposal. Answers and source are unchanged.",
  compose:
    "The proposal did not select its Compose stack. Retry to request a connected stack. Answers and source are unchanged.",
  required:
    "The proposal omitted required configuration. Retry to request all missing files. Answers and source are unchanged.",
} as const;

export class SetupConfigurationError extends Error {
  readonly recovery: string;
  constructor(kind: keyof typeof recovery, message: string) {
    super(message);
    this.name = "SetupConfigurationError";
    this.recovery = recovery[kind];
  }
}

export function setupConfigurationFeedback(failure: string | null) {
  return Object.values(recovery).some((message) => message === failure)
    ? (failure ?? undefined)
    : undefined;
}

// Required Compose/Dev Container substitutions are declared by the repository.
// Optional defaults do not require a Factory secret and values are never read here.
export function requiredEnvironmentVariables(contents: readonly string[]) {
  const devContainerSubstitutions = new Set([
    "localWorkspaceFolder",
    "localWorkspaceFolderBasename",
    "containerWorkspaceFolder",
    "containerWorkspaceFolderBasename",
    "devcontainerId",
  ]);
  const names = new Set<string>();
  for (const content of contents) {
    for (const match of content.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^}]*)?\}/g))
      if (match[1] && !devContainerSubstitutions.has(match[1])) names.add(match[1]);
    for (const match of content.matchAll(/\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g))
      if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

export async function readRequiredEnvironmentVariables(
  configuration: string,
  read: (path: string) => Promise<string>,
) {
  const selected = posix.normalize(configuration);
  if (
    posix.isAbsolute(selected) ||
    selected === ".." ||
    selected.startsWith("../") ||
    /[$\\]/.test(configuration)
  )
    throw new Error(
      "Required environment discovery needs a fixed repository-relative configuration",
    );
  const contents: string[] = [];
  const pending = [selected];
  const seen = new Set<string>();
  function reference(from: string, value: string) {
    const path = posix.normalize(posix.join(posix.dirname(from), value));
    if (posix.isAbsolute(value) || path === ".." || path.startsWith("../") || value.includes("$"))
      throw new Error(
        "Required environment discovery needs a fixed repository-relative configuration",
      );
    pending.push(path);
  }
  while (pending.length) {
    const path = pending.shift();
    if (!path || seen.has(path)) continue;
    if (seen.size >= 32)
      throw new Error("Required environment configuration exceeds its read bound");
    seen.add(path);
    const content = await read(path);
    if (Buffer.byteLength(content) > 64_000)
      throw new Error("Required environment configuration exceeds its size bound");
    contents.push(content);
    if (path === selected) {
      const errors: ParseError[] = [];
      const value: unknown = parseJSONC(content, errors, { allowTrailingComma: true });
      if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Dev Container configuration is invalid JSONC");
      const compose = Reflect.get(value, "dockerComposeFile") as unknown;
      if (compose !== undefined && typeof compose !== "string" && !Array.isArray(compose))
        throw new Error("Dev Container Compose reference is invalid");
      for (const item of typeof compose === "string"
        ? [compose]
        : Array.isArray(compose)
          ? compose
          : []) {
        if (typeof item !== "string") throw new Error("Dev Container Compose reference is invalid");
        reference(path, item);
      }
    } else {
      const value: unknown = yaml(content);
      if (!value || typeof value !== "object") throw new Error("Compose configuration is invalid");
      const includes: unknown = Reflect.get(value, "include");
      for (const item of Array.isArray(includes) ? includes : includes ? [includes] : []) {
        const paths: unknown =
          typeof item === "string"
            ? item
            : item && typeof item === "object"
              ? Reflect.get(item, "path")
              : undefined;
        for (const included of typeof paths === "string"
          ? [paths]
          : Array.isArray(paths)
            ? paths
            : []) {
          if (typeof included !== "string") throw new Error("Compose include reference is invalid");
          reference(path, included);
        }
      }
      const services: unknown = Reflect.get(value, "services");
      if (services && typeof services === "object")
        for (const service of Object.values(services)) {
          const extended: unknown =
            service && typeof service === "object" ? Reflect.get(service, "extends") : undefined;
          const file: unknown =
            extended && typeof extended === "object" ? Reflect.get(extended, "file") : undefined;
          if (typeof file === "string") reference(path, file);
        }
    }
  }
  return requiredEnvironmentVariables(contents);
}

function yaml(content: string) {
  const value = parseDocument(content, { uniqueKeys: true });
  if (value.errors.length) throw new Error("Configuration is invalid YAML");
  return value.toJS({ maxAliasCount: 20 });
}
function reference(path: string, existingPaths: readonly string[]) {
  const resolved = posix.normalize(posix.join(".devcontainer", path));
  if (!existingPaths.includes(resolved) || resolved.startsWith("../") || posix.isAbsolute(path))
    throw new SetupConfigurationError(
      "recipe",
      "Dev Container references an unavailable repository file",
    );
}
function devContainer(content: string, existingPaths: readonly string[]) {
  const errors: ParseError[] = [];
  const input = parseJSONC(content, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Dev Container configuration is invalid JSONC");
  const value = z
    .object({
      image: z.string().min(1).optional(),
      build: z
        .object({ dockerfile: z.string().min(1) })
        .loose()
        .optional(),
      dockerComposeFile: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
      service: z.string().optional(),
      overrideCommand: z.boolean().optional(),
      workspaceFolder: z.string().min(1).optional(),
    })
    .loose()
    .refine((value) =>
      Boolean(value.image || value.build || (value.dockerComposeFile && value.service)),
    )
    .parse(input);
  if (value.build) reference(value.build.dockerfile, existingPaths);
  for (const path of typeof value.dockerComposeFile === "string"
    ? [value.dockerComposeFile]
    : (value.dockerComposeFile ?? []))
    reference(path, existingPaths);
  return value;
}
function workflow(content: string) {
  const value = z
    .object({
      on: z.union([
        z.literal("pull_request"),
        z.array(z.string()),
        z.record(z.string(), z.unknown()),
      ]),
      jobs: z.record(
        z.string(),
        z
          .object({
            "runs-on": z.literal("factory-verification"),
            steps: z.array(z.object({ run: z.string().min(1) }).loose()).min(1),
          })
          .loose(),
      ),
    })
    .loose()
    .parse(yaml(content));
  const pullRequest =
    typeof value.on === "string"
      ? true
      : Array.isArray(value.on)
        ? value.on.includes("pull_request")
        : "pull_request" in value.on;
  if (!pullRequest || Object.keys(value.jobs).length !== 1)
    throw new Error("Verification needs one assigned runner job on pull requests");
}
export function validateConfiguration(
  files: readonly { path: string; content: string }[],
  paths: readonly string[],
) {
  const recipe = files.find((file) => file.path === ".devcontainer/devcontainer.json");
  if (recipe) {
    const value = devContainer(recipe.content, paths);
    const composePaths = new Set(
      (typeof value.dockerComposeFile === "string"
        ? [value.dockerComposeFile]
        : (value.dockerComposeFile ?? [])
      ).map((path) => posix.normalize(posix.join(".devcontainer", path))),
    );
    if (
      files.some(
        (file) =>
          /^\.devcontainer\/compose\.ya?ml$/.test(file.path) && !composePaths.has(file.path),
      )
    )
      throw new SetupConfigurationError(
        "compose",
        "Proposed Compose files must be referenced by devcontainer.json",
      );
    const composePath =
      typeof value.dockerComposeFile === "string"
        ? posix.normalize(posix.join(".devcontainer", value.dockerComposeFile))
        : undefined;
    const compose = files.find((file) => file.path === composePath);
    // Check the proposed single-file stack. Existing or layered Compose stacks
    // remain subject to upstream resolution, not an incomplete custom merger.
    if (compose) {
      const { services } = z
        .object({
          services: z.record(z.string(), z.record(z.string(), z.unknown())),
        })
        .parse(yaml(compose.content));
      const contract = files.find((file) => file.path === ".factory/system.json");
      const command = services[value.service ?? ""]?.["command"];
      if (
        !value.overrideCommand &&
        contract &&
        parseSystemContract(contract.content).apps.some((app) =>
          Array.isArray(command)
            ? JSON.stringify(command) === JSON.stringify(app.command)
            : typeof command === "string" && command === app.command.join(" "),
        )
      )
        throw new Error(
          "Factory starts App commands after Dev Container hooks. Keep the primary service idle or set overrideCommand:true.",
        );
      const volumes = services[value.service ?? ""]?.["volumes"];
      const workspaceFolder = value.workspaceFolder;
      const repositoryTarget = (target: string) => {
        if (!posix.isAbsolute(target)) return false;
        if (workspaceFolder === undefined) return true;
        const relative = posix.relative(target, workspaceFolder);
        return relative !== ".." && !relative.startsWith("../");
      };
      const mounted =
        Array.isArray(volumes) &&
        volumes.some((volume: unknown) => {
          if (typeof volume === "string") {
            const [source, target, options] = volume.split(":");
            return (
              source !== undefined &&
              posix.normalize(source).replace(/\/$/, "") === ".." &&
              target !== undefined &&
              repositoryTarget(target) &&
              !options?.split(",").includes("ro")
            );
          }
          const binding = z
            .object({
              type: z.literal("bind"),
              source: z.string(),
              target: z.string(),
              read_only: z.boolean().optional(),
            })
            .safeParse(volume);
          return (
            binding.success &&
            posix.normalize(binding.data.source).replace(/\/$/, "") === ".." &&
            repositoryTarget(binding.data.target) &&
            binding.data.read_only !== true
          );
        });
      if (!mounted)
        throw new Error("Compose primary service must mount the repository into its workspace");
    }
  }
  for (const file of files) {
    if (file.path === ".factory/system.json") parseSystemContract(file.content);
    if (file.path === ".forgejo/workflows/factory-verification.yml") workflow(file.content);
    if (/^\.devcontainer\/compose\.ya?ml$/.test(file.path)) {
      const value = z
        .object({ services: z.record(z.string(), z.record(z.string(), z.unknown())) })
        .parse(yaml(file.content));
      if (!Object.keys(value.services).length)
        throw new Error("Compose needs an application service");
    }
  }
}
export function validateSetupProposal(
  output: SetupInspectionOutput,
  existingPaths: readonly string[],
) {
  const paths = output.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || paths.some((path) => existingPaths.includes(path)))
    throw new Error("Setup cannot overwrite existing files");
  if (output.questions.length && output.files.length)
    throw new Error("Resolve open questions before proposing configuration files");
  validateConfiguration(output.files, [...existingPaths, ...paths]);
  if (
    !output.questions.length &&
    requiredConfiguration.some((path) => !existingPaths.includes(path) && !paths.includes(path))
  )
    throw new SetupConfigurationError(
      "required",
      "Setup proposal does not contain the missing required files",
    );
}
