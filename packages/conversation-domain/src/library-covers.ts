import { z } from "zod";

export const libraryCoverCatalog = [
  { key: "folded-planes", name: "Folded planes" },
  { key: "woven-ribbons", name: "Woven ribbons" },
  { key: "nested-arches", name: "Nested arches" },
  { key: "branching-paths", name: "Branching paths" },
  { key: "offset-windows", name: "Offset windows" },
  { key: "interlocking-loops", name: "Interlocking loops" },
  { key: "stacked-horizons", name: "Stacked horizons" },
  { key: "river-confluence", name: "River confluence" },
  { key: "dovetail-joint", name: "Dovetail joint" },
  { key: "open-folio", name: "Open folio" },
  { key: "balanced-blocks", name: "Balanced blocks" },
  { key: "spiral-cut", name: "Spiral cut" },
  { key: "paired-conduits", name: "Paired conduits" },
  { key: "terraced-steps", name: "Terraced steps" },
  { key: "woven-lattice", name: "Woven lattice" },
  { key: "split-prism", name: "Split prism" },
  { key: "wave-rhythm", name: "Wave rhythm" },
  { key: "joined-ends", name: "Joined ends" },
  { key: "spanning-bridge", name: "Spanning bridge" },
  { key: "root-system", name: "Root system" },
  { key: "turning-planes", name: "Turning planes" },
  { key: "orbital-bands", name: "Orbital bands" },
  { key: "braided-loop", name: "Braided loop" },
  { key: "open-passage", name: "Open passage" },
  { key: "ascending-forms", name: "Ascending forms" },
  { key: "carved-aperture", name: "Carved aperture" },
  { key: "patchwork-fields", name: "Patchwork fields" },
  { key: "converging-lines", name: "Converging lines" },
  { key: "folded-triangles", name: "Folded triangles" },
  { key: "offset-discs", name: "Offset discs" },
] as const;

export const libraryCoverKey = z.enum(libraryCoverCatalog.map((cover) => cover.key));
export type LibraryCoverKey = z.infer<typeof libraryCoverKey>;
export const libraryCoverState = z.object({
  key: libraryCoverKey,
  version: z.number().int().positive(),
});
export type LibraryCover = z.infer<typeof libraryCoverState>;
export const libraryCoverInput = z
  .object({
    libraryId: z.uuid(),
    key: libraryCoverKey,
    expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export function defaultLibraryCover(libraryId: string): LibraryCoverKey {
  let hash = 2166136261;
  for (const character of libraryId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (
    libraryCoverCatalog[(hash >>> 0) % libraryCoverCatalog.length]?.key ??
    libraryCoverCatalog[0].key
  );
}
