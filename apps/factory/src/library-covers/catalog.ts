import type { LibraryCoverKey } from "#conversation-domain/library-covers";

export const libraryCoverURL = (key: LibraryCoverKey, kind: "skill" | "mcp") =>
  `/art/library/${key}-${kind}.webp`;
