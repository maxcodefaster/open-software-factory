import { z } from "zod";

export const skillRoleInput = z.enum(["planning", "build"]);
export type SkillRole = z.infer<typeof skillRoleInput>;

export const skillInvocationViewInput = z.object({
  skills: z
    .array(
      z.object({
        id: z.uuid(),
        key: z.string(),
        name: z.string(),
        description: z.string(),
      }),
    )
    .max(16),
  conflicts: z.array(z.string()).max(16),
});

export const skillRevisionIDsInput = z
  .array(z.uuid())
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate Skill revision");

const referencePath = z
  .string()
  .max(200)
  .regex(/^references\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.(?:md|txt)$/);

export const skillContentInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    roles: z.array(skillRoleInput).min(1).max(2),
    instructions: z.string().trim().min(1).max(24_000),
    references: z
      .array(z.object({ path: referencePath, body: z.string().min(1).max(16_000) }).strict())
      .max(8),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(240)
              .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/)
              .refine(
                (path) =>
                  !path.split("/").some((part) => part === "." || part === "..") &&
                  path !== "SKILL.md",
              ),
            body: z.string().max(1_000_000),
            encoding: z.enum(["utf8", "base64"]),
            executable: z.boolean().optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    sourceSkill: z.string().max(100_000).optional(),
    manualOnly: z.boolean().optional(),
    origin: z
      .object({
        repository: z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
          );
        }, "Use a credential-free HTTPS repository URL"),
        commit: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/),
        path: z
          .string()
          .min(1)
          .max(240)
          .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/SKILL\.md$/),
        licence: z.string().trim().min(1).max(100),
        licenceText: z.string().trim().min(1).max(16_000),
      })
      .strict()
      .optional(),
    review: z
      .object({
        trigger: z.string().trim().min(1).max(1_000),
        adaptations: z.string().trim().min(1).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_000_000)
      context.addIssue({ code: "custom", message: "Skill package exceeds 2000000 bytes" });
    const { files: _files, sourceSkill: _source, ...instructions } = value;
    if (new TextEncoder().encode(JSON.stringify(instructions)).byteLength > 100_000)
      context.addIssue({ code: "custom", message: "Skill instruction text exceeds 100000 bytes" });
    if (
      value.files?.some(
        (file) =>
          file.encoding === "base64" &&
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.body),
      )
    )
      context.addIssue({ code: "custom", message: "Binary resources need valid base64" });
    const paths = [
      ...value.references.map((file) => file.path),
      ...(value.files ?? []).map((file) => file.path),
    ];
    if (new Set(paths).size !== paths.length)
      context.addIssue({ code: "custom", message: "Duplicate package path" });
    if (
      value.roles.includes("planning") &&
      value.files?.some((file) => file.executable || file.path.startsWith("scripts/"))
    )
      context.addIssue({ code: "custom", message: "Skills requiring scripts are Build-only" });
    if (new Set(value.roles).size !== value.roles.length)
      context.addIssue({ code: "custom", message: "Duplicate role", path: ["roles"] });
    if (
      new Set(value.references.map((reference) => reference.path)).size !== value.references.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate reference path",
        path: ["references"],
      });
    if (
      value.instructions.length +
        value.references.reduce((size, ref) => size + ref.body.length, 0) >
      48_000
    )
      context.addIssue({
        code: "custom",
        message: "Skill instructions and references exceed 48000 characters",
      });
  });
export type SkillContent = z.infer<typeof skillContentInput>;

export const skillPublishInput = z
  .object({
    revisionId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    content: skillContentInput,
  })
  .strict();
export type SkillPublish = z.infer<typeof skillPublishInput>;

export const skillRevisionInput = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  content: skillContentInput,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  published: z.boolean(),
});
export type SkillRevision = z.infer<typeof skillRevisionInput>;

export const skillRoleSettingsInput = z
  .object({
    required: skillRevisionIDsInput,
    optional: skillRevisionIDsInput,
    selected: skillRevisionIDsInput,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.required.some((id) => value.optional.includes(id)))
      context.addIssue({ code: "custom", message: "A Skill cannot be both required and optional" });
    if (value.selected.some((id) => !value.optional.includes(id)))
      context.addIssue({
        code: "custom",
        message: "Selected Skills must be permitted optional revisions",
      });
    if (value.required.length + value.optional.length > 16)
      context.addIssue({ code: "custom", message: "At most 16 Skills per role" });
  });
export type SkillRoleSettings = z.infer<typeof skillRoleSettingsInput>;

export const systemSkillSettingsInput = z
  .object({
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    planning: skillRoleSettingsInput,
    build: skillRoleSettingsInput,
  })
  .strict();
export type SystemSkillSettings = z.infer<typeof systemSkillSettingsInput>;

export function skillInstructionText(revisions: SkillRevision[]) {
  return revisions
    .map((revision) =>
      [
        `Approved Skill: ${revision.content.name}, revision ${revision.revision}, identity ${revision.id}.`,
        revision.content.instructions,
        ...revision.content.references.map(
          (reference) => `Reference ${reference.path}:\n${reference.body}`,
        ),
      ].join("\n\n"),
    )
    .join("\n\n");
}
