import { z } from "zod";

export const projectEnvironment = z.enum(["development", "main-preview"]);
export type ProjectEnvironment = z.output<typeof projectEnvironment>;

const variableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine(
    (name) =>
      !/^(FACTORY_|CODER_|KUBERNETES_|DOCKER_|BAO_|VAULT_)/.test(name) &&
      ![
        "PATH",
        "HOME",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "NODE_OPTIONS",
        "BASH_ENV",
        "ENV",
        "SHELL",
        "IFS",
        "CDPATH",
        "ENV_SUPATH",
      ].includes(name),
    { message: "This variable is reserved for infrastructure" },
  );
const secretValue = z
  .string()
  .max(65_536)
  .refine((value) => !value.includes("\0"));
const grants = z
  .object({
    runtime: z.boolean(),
    verification: z.boolean(),
  })
  .strict();
const variableMetadata = grants.extend({ name: variableName }).strict();

export const environmentManifest = z
  .object({
    variables: z.array(variableMetadata).max(128),
  })
  .strict();
export type EnvironmentManifest = z.output<typeof environmentManifest>;

export const environmentWrite = z
  .object({
    commandID: z.uuid(),
    version: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    variables: z
      .array(variableMetadata.extend({ value: secretValue.optional() }).strict())
      .max(128),
  })
  .strict()
  .superRefine((input, context) => {
    const names = input.variables.map((item) => item.name);
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", path: ["variables"], message: "Entries must be unique" });
  });
export type EnvironmentWrite = z.output<typeof environmentWrite>;
export type EnvironmentWriteInput = z.input<typeof environmentWrite>;

export const environmentBundle = z
  .object({
    variables: z.array(variableMetadata.extend({ value: secretValue }).strict()).max(128),
  })
  .strict();
export type EnvironmentBundle = z.output<typeof environmentBundle>;

export function environmentMetadata(bundle: EnvironmentBundle): EnvironmentManifest {
  return {
    variables: bundle.variables.map(({ value: _value, ...metadata }) => metadata),
  };
}

export function replaceEnvironment(
  input: EnvironmentWrite,
  previous: EnvironmentBundle,
): EnvironmentBundle {
  return environmentBundle.parse({
    variables: input.variables.map((variable) => {
      const value =
        variable.value ?? previous.variables.find((item) => item.name === variable.name)?.value;
      if (value === undefined) throw new Error("A new variable needs a value");
      return { ...variable, value };
    }),
  });
}

export const environmentSettingsView = environmentManifest
  .extend({
    environment: projectEnvironment,
    version: z.number().int().nonnegative(),
    canManage: z.boolean(),
    storeConfigured: z.boolean(),
    pending: z.boolean(),
    pendingCommandID: z.uuid().nullable(),
  })
  .strict();
export type EnvironmentSettingsView = z.output<typeof environmentSettingsView>;

// Import literal values only. Never evaluate shell expansion or silently accept malformed lines.
export function parseEnvironmentPaste(source: string): Array<{ name: string; value: string }> {
  if (source.length > 262_144) throw new Error("Environment paste is too large");
  const entries: Array<{ name: string; value: string }> = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines.at(index)?.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid variable on line ${index + 1}`);
    const name = variableName.parse(match[1]);
    let value = match[2] ?? "";
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      while (value.length < 2 || value.at(-1) !== quote) {
        index += 1;
        if (index >= lines.length) throw new Error("Unclosed quoted value");
        value += `\n${lines[index]}`;
      }
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, "").trimEnd();
    if (entries.some((item) => item.name === name)) throw new Error("Duplicate variable in paste");
    entries.push({ name, value: secretValue.parse(value) });
  }
  if (entries.length > 128) throw new Error("Too many variables");
  return entries;
}
