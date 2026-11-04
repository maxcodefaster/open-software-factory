const generic = new Set([
  "license",
  "licence",
  "lizenz",
  "contributing",
  "contents",
  "table of contents",
  "inhalt",
  "inhaltsverzeichnis",
  "changelog",
  "credits",
  "contact",
  "kontakt",
  "badges",
  "authors",
  "acknowledgements",
  "acknowledgments",
]);
const readme = /(^|\/)readme(?:\.[a-z]+)?\.mdx?$/i;
const documentation = /^(?:docs?|documentation|dokumentation)\/.+\.mdx?$/i;
const skipped = /(^|\/)(?:readme|index|changelog|license|licence|contributing|security)\.mdx?$/i;

/**
 * Reader areas the repository's own documentation names: README sections and one area per
 * documentation file. A deterministic floor for the plan, independent of the planner's judgment.
 */
export function documentedReaderAreas(
  inventory: ReadonlyArray<{ path: string }>,
  sources: ReadonlyArray<{ path: string; content: string }>,
): string[] {
  const areas = new Map<string, string>();
  for (const source of sources) {
    if (!readme.test(source.path)) continue;
    let fenced = false;
    for (const line of source.content.split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) continue;
      const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/
        .exec(line)?.[1]
        ?.replace(/[`*_[\]]/g, "")
        .trim();
      if (!heading || heading.length > 80 || generic.has(heading.toLowerCase())) continue;
      areas.set(`readme:${heading.toLowerCase()}`, heading);
    }
  }
  for (const file of inventory) {
    if (!documentation.test(file.path) || skipped.test(file.path)) continue;
    areas.set(`doc:${file.path.toLowerCase()}`, file.path);
  }
  return [...areas.values()];
}

/** Below this many documented areas, one topic can be a complete plan. */
export const minimumDocumentedAreas = 3;
