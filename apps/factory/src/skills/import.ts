import { parse } from "yaml";
import { z } from "zod";
import { skillContentInput } from "../../../../packages/conversation-domain/src/skills";
import { skillImportInput, repositorySkillImportInput } from "./commands";

export function previewSkillImport(value: unknown) {
  const input = skillImportInput.parse(value);
  const original = input.files.find((file) => file.path === "SKILL.md");
  if (original?.encoding !== "utf8")
    throw new Error("Choose a package containing a text SKILL.md at its root");
  const match = original.body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md needs name and description in YAML frontmatter");
  const metadata = z
    .object({
      name: z.string(),
      description: z.string(),
      "disable-model-invocation": z.boolean().optional(),
      compatibility: z.unknown().optional(),
    })
    .passthrough()
    .parse(parse(match[1] ?? "", { maxAliasCount: 0 }));
  const files = input.files.filter((file) => file.path !== "SKILL.md");
  const buildOnly = files.some((file) => file.path.startsWith("scripts/") || file.executable);
  const warnings = [
    ...(buildOnly
      ? [
          "This package includes executable resources and is available in Build only. Installing it does not run them.",
        ]
      : []),
    ...(metadata.compatibility
      ? [
          `Source compatibility requirements: ${JSON.stringify(metadata.compatibility)}. Check them against your Sandbox before use.`,
        ]
      : []),
    ...(!input.origin
      ? [
          "This file import has no repository or licence provenance. Keep the original attribution and confirm your right to share it.",
        ]
      : []),
  ];
  const content = skillContentInput.parse({
    key: metadata.name,
    name: metadata.name.replaceAll("-", " "),
    description: metadata.description,
    instructions: match[2],
    references: [],
    files,
    sourceSkill: original.body,
    roles: buildOnly ? ["build"] : ["planning", "build"],
    ...(metadata["disable-model-invocation"] ? { manualOnly: true } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
  });
  return { content, warnings };
}

export async function previewRepositorySkill(value: unknown) {
  const input = repositorySkillImportInput.parse(value);
  const repository = input.repository.replace(/\/$/, "").slice("https://github.com/".length);
  const directory = input.path.slice(0, -"/SKILL.md".length);
  const fetchPinned = async (url: string) => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The pinned source could not be read (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 2_000_000) throw new Error("Source response exceeds the package limit");
    return bytes;
  };
  const tree = z
    .object({
      truncated: z.boolean(),
      tree: z.array(
        z.object({
          path: z.string(),
          type: z.string(),
          mode: z.string(),
          size: z.number().optional(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        new TextDecoder().decode(
          await fetchPinned(
            `https://api.github.com/repos/${repository}/git/trees/${input.commit}?recursive=1`,
          ),
        ),
      ),
    );
  if (tree.truncated)
    throw new Error("Repository tree is truncated; use a complete file package import");
  const selected = tree.tree.filter(
    (file) => file.path.startsWith(`${directory}/`) && file.type === "blob",
  );
  const licenceFile =
    selected.find((file) =>
      /^LICENSE(?:\.txt|\.md)?$/i.test(file.path.slice(directory.length + 1)),
    ) ?? tree.tree.find((file) => /^LICENSE(?:\.txt|\.md)?$/i.test(file.path));
  if (licenceFile && !selected.includes(licenceFile)) selected.push(licenceFile);
  if (
    selected.length > 65 ||
    selected.some((file) => !["100644", "100755"].includes(file.mode)) ||
    selected.reduce((sum, file) => sum + (file.size ?? 2_000_001), 0) > 1_400_000
  )
    throw new Error(
      "Import needs a bounded package of regular files; symlinks and oversized packages are unsupported",
    );
  const files = [];
  let licenceText = "";
  for (const file of selected) {
    const bytes = await fetchPinned(
      `https://raw.githubusercontent.com/${repository}/${input.commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
    );
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      /* Preserve binary assets exactly. */
    }
    if (file === licenceFile) licenceText = text ?? "";
    files.push({
      path: file.path.startsWith(`${directory}/`)
        ? file.path.slice(directory.length + 1)
        : "LICENSE.txt",
      body: text ?? Buffer.from(bytes).toString("base64"),
      encoding: text === undefined ? ("base64" as const) : ("utf8" as const),
      ...(file.mode === "100755" ? { executable: true } : {}),
    });
  }
  const preview = previewSkillImport({
    files,
    origin: {
      ...input,
      licence: licenceText.includes("Apache License")
        ? "Apache-2.0"
        : licenceText.includes("MIT License")
          ? "MIT"
          : "See source",
      licenceText: licenceText || "No licence text supplied by this source.",
    },
  });
  if (!licenceText)
    preview.warnings.push(
      "No source licence was found. Confirm usage and sharing rights before installation.",
    );
  return preview;
}
export async function checkSkillSourceUpdate(value: unknown) {
  const input = repositorySkillImportInput.parse(value);
  const repository = input.repository.replace(/\/$/, "").slice("https://github.com/".length);
  const directory = input.path.slice(0, -"/SKILL.md".length);
  const response = await fetch(
    `https://api.github.com/repos/${repository}/commits?path=${encodeURIComponent(directory)}&per_page=1`,
    { redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) throw new Error("The source update could not be checked");
  const [latest] = z
    .array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }))
    .parse(await response.json());
  if (!latest || latest.sha === input.commit) return { current: true as const };
  return {
    current: false as const,
    ...(await previewRepositorySkill({ ...input, commit: latest.sha })),
  };
}
