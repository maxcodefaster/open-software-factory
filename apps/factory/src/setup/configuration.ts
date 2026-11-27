import { parseDocument } from "yaml";
import { z } from "zod";
import {
  type SetupInspectionOutput,
  setupFile,
  setupInspectionOutput,
} from "#project-domain/setup";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { parseSystemContract } from "#system-contract/system-contract";

export const requiredConfiguration = [
  ".factory/actor-template.json",
  ".factory/system.json",
  ".forgejo/workflows/factory-verification.yml",
];
export const configurationPath = (path: string) => setupFile.shape.path.safeParse(path).success;

const recovery = {
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

function projectTemplate(content: string) {
  const template = parseSubstrateProjectTemplate(content);
  if (
    template.containers.some((container) =>
      container.env?.some(({ value }) => /\$\{|\$\(/.test(value)),
    )
  )
    throw new Error(
      `Project ActorTemplate environment values are literals; \${...} and $(...) interpolation is not supported. Configure Project Environments or use literal values.`,
    );
}

export async function readRequiredEnvironmentVariables(
  configuration: string,
  read: (path: string) => Promise<string>,
): Promise<string[]> {
  if (
    !configuration ||
    configuration.length > 500 ||
    /[$\\:%?#]/.test(configuration) ||
    [...configuration].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    configuration.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "Required environment discovery needs a fixed repository-relative ActorTemplate path",
    );
  const content = await read(configuration);
  if (Buffer.byteLength(content) > 64_000)
    throw new Error("Required environment configuration exceeds its size bound");
  projectTemplate(content);
  // Native environment values are literal. Project Environments supplies credentials;
  // repository files never declare substitutions or additional files to discover.
  return [];
}

function yaml(content: string) {
  const value = parseDocument(content, { uniqueKeys: true });
  if (value.errors.length) throw new Error("Configuration is invalid YAML");
  return value.toJS({ maxAliasCount: 20 });
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
  _paths: readonly string[],
) {
  for (const file of setupInspectionOutput.shape.files.parse(files)) {
    if (file.path === ".factory/actor-template.json") projectTemplate(file.content);
    if (file.path === ".factory/system.json") parseSystemContract(file.content);
    if (file.path === ".forgejo/workflows/factory-verification.yml") workflow(file.content);
  }
}
export function validateSetupProposal(
  output: SetupInspectionOutput,
  existingPaths: readonly string[],
) {
  setupInspectionOutput.parse(output);
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
