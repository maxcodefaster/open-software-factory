import { z } from "zod";

export const releaseVersion = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/,
    "Use a stable version such as 1.4.0",
  );
export const releaseSHA = z.string().regex(/^[a-f0-9]{40}$/);
const packageName = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
  .max(100);
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
export const releaseContract = z
  .object({
    schemaVersion: z.literal(1),
    images: z.array(packageName).max(16).default([]),
    chart: packageName.optional(),
    files: z
      .array(z.object({ name: packageName, filename: fileName }).strict())
      .max(16)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const names = [
      ...value.images,
      ...(value.chart ? [value.chart] : []),
      ...value.files.map((file) => file.name),
    ];
    if (!names.length)
      context.addIssue({
        code: "custom",
        message:
          "Declare at least one artifact or omit the release contract for source-only publication",
      });
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", message: "Release package names must be unique" });
  });
export type ReleaseContract = z.output<typeof releaseContract>;
export const publishRelease = z
  .object({
    commandID: z.uuid(),
    commitSHA: releaseSHA,
    version: releaseVersion,
    notes: z.string().trim().max(10_000),
  })
  .strict();
export const releaseArtifact = z
  .object({
    kind: z.enum(["image", "chart", "file"]),
    name: packageName,
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    filename: fileName.optional(),
  })
  .strict();
export type ReleaseArtifact = z.output<typeof releaseArtifact>;
export const releaseState = z.enum([
  "pending",
  "dispatching",
  "running",
  "checking",
  "publishing",
  "published",
  "failed",
  "uncertain",
]);
export const releaseView = z
  .object({
    id: z.uuid(),
    version: releaseVersion,
    commitSHA: releaseSHA,
    state: releaseState,
    notes: z.string(),
    createdAt: z.string(),
    publishedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    runURL: z.string().nullable(),
    releaseURL: z.string().nullable(),
    failure: z.string().nullable(),
    artifacts: z.array(releaseArtifact),
  })
  .strict();
export const externalAccessInput = z
  .object({
    commandID: z.uuid(),
    name: z.string().trim().min(1).max(100),
    scope: z.enum(["git", "packages"]),
  })
  .strict();
export const releaseSettingsView = z
  .object({
    canPublish: z.boolean(),
    canManageAccess: z.boolean(),
    configured: z.boolean(),
    candidateSHA: releaseSHA.nullable(),
    lastVersion: releaseVersion.nullable(),
    suggestions: z.object({ patch: releaseVersion, minor: releaseVersion, major: releaseVersion }),
    repositoryURL: z.string(),
    registryURL: z.string(),
    packageOwner: z.string(),
    contract: releaseContract.nullable(),
    configurationError: z.string().nullable(),
    releases: z.array(releaseView),
    access: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          scope: z.enum(["git", "packages"]),
          state: z.enum(["pending", "active", "revoking", "revoked", "uncertain"]),
          createdAt: z.string(),
          username: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type ReleaseSettingsView = z.output<typeof releaseSettingsView>;

export function versionSuggestions(previous: string | null) {
  const [major, minor, patch] = (previous ?? "0.0.0").split(".").map(Number) as [
    number,
    number,
    number,
  ];
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}
export function releasePackageOwner(projectID: string) {
  return `frp-${z.uuid().parse(projectID).replaceAll("-", "")}`;
}
