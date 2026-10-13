import { z } from "zod";
import { knowledgePageInput } from "./knowledge";

export const wikiGenerationOutput = z
  .object({
    pages: z
      .array(
        knowledgePageInput
          .extend({
            id: z.uuid().nullable(),
            parentSlug: z
              .string()
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
              .nullable(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export type WikiPageSnapshot = {
  id: string;
  slug: string;
  title: string;
  body: string;
  version: number;
  revisionId: string | null;
  parentId: string | null;
  state: string;
  citations: Array<{ path: string; commitSha: string }>;
};
export type WikiGenerationOutput = z.infer<typeof wikiGenerationOutput>;

export function validateWikiGeneration(
  output: WikiGenerationOutput,
  pages: readonly WikiPageSnapshot[],
  readPaths: ReadonlySet<string>,
) {
  const slugs = new Set<string>();
  const ids = new Set<string>();
  for (const page of output.pages) {
    if (slugs.has(page.slug) || (page.id && ids.has(page.id)))
      throw new Error("Wiki update repeats a page");
    slugs.add(page.slug);
    if (page.id) {
      ids.add(page.id);
      const current = pages.find((current) => current.id === page.id);
      if (current?.state !== "active")
        throw new Error("Wiki update references an unavailable page");
      if (current.slug !== page.slug || page.parentSlug !== null)
        throw new Error("Wiki updates cannot change human organization");
    } else if (pages.some((current) => current.slug === page.slug))
      throw new Error("Wiki update duplicates an existing or archived page");
    if (!page.sources.length || page.sources.some((path) => !readPaths.has(path)))
      throw new Error("Wiki update must cite sources actually read");
    if (
      page.parentSlug &&
      !output.pages.some((parent) => parent.slug === page.parentSlug) &&
      !pages.some((parent) => parent.state === "active" && parent.slug === page.parentSlug)
    )
      throw new Error("Wiki parent is unavailable");
    let parent = page.parentSlug;
    const visited = new Set([page.slug]);
    while (parent) {
      if (visited.has(parent)) throw new Error("Wiki update contains a parent cycle");
      visited.add(parent);
      parent = output.pages.find((candidate) => candidate.slug === parent)?.parentSlug ?? null;
    }
  }
}
