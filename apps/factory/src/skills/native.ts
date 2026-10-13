import { createHash } from "node:crypto";
import { z } from "zod";
import type { SkillRevision } from "../../../../packages/conversation-domain/src/skills";

export const nativeSkillId = (revision: SkillRevision) => `factory-${revision.id}`;
export function invokedSkills(prompt: string, revisions: SkillRevision[]) {
  const keys = [...prompt.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]{1,63})(?=\s|$|[.,!?])/g)].map(
    (match) => match[1],
  );
  return [...new Set(keys)].flatMap((key) => {
    const matches = revisions.filter((revision) => revision.content.key === key);
    if (matches.length > 1)
      throw new Error(`/${key} matches multiple enabled skills. Rename one before invoking it.`);
    return matches;
  });
}
export const nativeSkillManifestInput = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(
    z.object({ path: z.string(), body: z.string(), digest: z.string(), executable: z.boolean() }),
  ),
});
export function nativeSkillManifest(revisions: SkillRevision[]) {
  const files = revisions.flatMap((revision) => {
    const content = revision.content;
    const frontmatter = `---\nname: ${JSON.stringify(content.name)}\ndescription: ${JSON.stringify(content.description)}\ndisable-model-invocation: ${content.manualOnly ? "true" : "false"}\n---\n${content.instructions}\n`;
    const packageFiles = [
      { path: "SKILL.md", body: frontmatter, encoding: "utf8" as const },
      ...content.references.map((file) => ({ ...file, encoding: "utf8" as const })),
      ...(content.files ?? []),
    ];
    return packageFiles.map((file) => {
      const bytes = Buffer.from(file.body, file.encoding === "base64" ? "base64" : "utf8");
      return {
        path: `${nativeSkillId(revision)}/${file.path}`,
        body: bytes.toString("base64"),
        digest: createHash("sha256").update(bytes).digest("hex"),
        executable: "executable" in file && file.executable === true,
      };
    });
  });
  if (Buffer.byteLength(JSON.stringify(files)) > 7_000_000)
    throw new Error("Enabled skill packages exceed the runtime installation limit");
  return { digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}

export function skillAdvertisement(revisions: SkillRevision[]) {
  return revisions
    .map(
      (revision) =>
        `/${revision.content.key} (${nativeSkillId(revision)}): ${revision.content.description}${revision.content.manualOnly ? " Load only on explicit human invocation." : ""}`,
    )
    .join("\n");
}
export function observedNativeSkillIds(
  messages: readonly unknown[],
  promptId: string,
  admitted: readonly string[],
) {
  const header = z.object({ id: z.string(), type: z.string() }).passthrough();
  const parsed = messages.map((message) => header.parse(message));
  const boundary = parsed.findIndex(
    (message) => message.id === promptId && message.type === "user",
  );
  if (boundary < 0) return [];
  const loaded = new Set<string>();
  for (const message of parsed.slice(0, boundary)) {
    const skill = z.object({ type: z.literal("skill"), skill: z.string() }).safeParse(message);
    if (skill.success) loaded.add(skill.data.skill);
    const assistant = z
      .object({ type: z.literal("assistant"), content: z.array(z.unknown()) })
      .safeParse(message);
    if (assistant.success)
      for (const part of assistant.data.content) {
        const tool = z
          .object({
            type: z.literal("tool"),
            name: z.literal("skill"),
            state: z.object({
              status: z.literal("completed"),
              input: z.object({ id: z.string() }),
            }),
          })
          .safeParse(part);
        if (tool.success) loaded.add(tool.data.state.input.id);
      }
  }
  return admitted.filter((id) => loaded.has(`factory-${id}`));
}
