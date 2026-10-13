import { z } from "zod";

function unsafeCharacters(value: string) {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
  );
}

export const projectSetupFields = z
  .object({
    name: z.string().trim().max(200),
    slug: z
      .string()
      .trim()
      .max(63)
      .refine((value) => !value || /^[a-z][a-z0-9-]{1,62}$/.test(value)),
    kind: z.enum(["starter", "import"]),
    sourceURL: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !unsafeCharacters(value)
          );
        } catch {
          return false;
        }
      }, "Use an HTTPS Git URL without credentials or query parameters."),
  })
  .strict();

export const projectSetupSave = projectSetupFields
  .extend({
    id: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();

export const projectSetupCreate = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    commandID: z.uuid(),
    importToken: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => !unsafeCharacters(value))
      .optional(),
  })
  .strict();

export const projectSetupView = projectSetupFields
  .extend({
    id: z.uuid(),
    version: z.number().int().positive(),
    state: z.enum(["draft", "creating", "checking", "created", "failed"]),
    projectID: z.uuid().nullable(),
    commandID: z.uuid().nullable(),
    failure: z.string().nullable(),
  })
  .strict();

export type ProjectSetupFields = z.output<typeof projectSetupFields>;
export type ProjectSetupView = z.output<typeof projectSetupView>;

export const setupTask = z.enum([
  "configuration",
  "development-secrets",
  "preview-secrets",
  "protection",
  "hook",
  "wiki",
  "development",
  "preview-image",
  "main-preview",
]);
export const setupReadiness = z.array(
  z
    .object({
      task: setupTask,
      state: z.enum(["pending", "running", "ready", "failed"]),
      commandID: z.uuid(),
      operationID: z.uuid().nullable(),
      failure: z.string().nullable(),
    })
    .strict(),
);
export type SetupTask = z.output<typeof setupTask>;
export type SetupTaskView = z.output<typeof setupReadiness>[number];

const configurationPath = z
  .string()
  .regex(
    /^(?:\.factory\/system\.json|\.forgejo\/workflows\/factory-verification\.yml|\.devcontainer\/(?:devcontainer\.json|Dockerfile|compose\.ya?ml))$/,
  );
export const setupFile = z
  .object({ path: configurationPath, content: z.string().min(1).max(64000) })
  .strict();
export const setupQuestion = z
  .object({ id: z.string().min(1).max(40), question: z.string().min(1).max(500) })
  .strict();
export const setupInspectionOutput = z
  .object({
    purpose: z.string().min(1).max(1000),
    services: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            description: z.string().max(400),
            port: z.number().int().min(1).max(65535).nullable(),
          })
          .strict(),
      )
      .max(8),
    uncertainty: z.array(z.string().max(500)).max(8),
    questions: z.array(setupQuestion).max(5),
    files: z.array(setupFile).max(6),
  })
  .strict();
export const setupInspectionView = z
  .object({
    id: z.uuid(),
    projectID: z.uuid(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/),
    state: z.enum([
      "inspecting",
      "complete",
      "proposal",
      "failed",
      "confirming",
      "confirmed",
      "superseded",
    ]),
    output: setupInspectionOutput.nullable(),
    failure: z.string().nullable(),
  })
  .strict();
export type SetupInspectionOutput = z.output<typeof setupInspectionOutput>;
export type SetupInspectionView = z.output<typeof setupInspectionView>;
export const setupInspectionCommand = z
  .object({
    id: z.uuid(),
    parentID: z.uuid().optional(),
    answers: z.record(z.string().max(40), z.string().trim().min(1).max(2000)).default({}),
  })
  .strict();

// Restrict import origins, not providers. Enterprise installations can allow
// their own HTTPS forge; embedded credentials never reach its migration API.
export function projectImportOrigins(
  value = "https://github.com,https://gitlab.com,https://codeberg.org",
) {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const url = new URL(part);
          if (
            url.protocol !== "https:" ||
            url.hostname.includes("*") ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            unsafeCharacters(part)
          )
            throw new Error("Git import hosts must be exact HTTPS origins without credentials.");
          return url.origin;
        }),
    ),
  ];
}

export function projectImportURL(value: string, allowedOrigins: readonly string[]) {
  if (unsafeCharacters(value) || /\/(?:\.|\.\.)(?:\/|$)|%2e|%2f|%5c/i.test(value))
    throw new Error("Use an HTTPS Git URL without credentials.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowedOrigins.includes(url.origin) ||
    url.pathname === "/" ||
    url.pathname.split("/").some((part) => [".", ".."].includes(decodeURIComponent(part)))
  )
    throw new Error("Use a Git URL from an approved HTTPS repository host, without credentials.");
  return url.toString();
}
