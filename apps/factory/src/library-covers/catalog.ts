import type { LibraryCoverKey } from "../../../../packages/conversation-domain/src/library-covers";

export const libraryCoverURL = (key: LibraryCoverKey, kind: "skill" | "mcp") =>
  `/art/library/${key}-${kind}.webp`;
