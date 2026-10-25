export const documentBlocks = [
  { id: "paragraph", label: "Text" },
  { id: "heading", label: "Heading" },
  { id: "bullet-list", label: "Bullet list" },
  { id: "numbered-list", label: "Numbered list" },
  { id: "checklist", label: "Checklist" },
  { id: "quote", label: "Quote" },
  { id: "code-block", label: "Code block" },
  { id: "table", label: "Table" },
  { id: "divider", label: "Divider" },
  { id: "image", label: "Image" },
  { id: "file", label: "File" },
] as const;
export type DocumentBlock = (typeof documentBlocks)[number]["id"];
export type DocumentFormat = DocumentBlock | "bold" | "italic" | "code";

// Unsupported authored constructs stay in source instead of being dropped on save.
export function supportsDocumentMarkdown(value: string) {
  return !/(!\[|^\s*\[[^\]]+\]:|<\/?[a-z][^>]*>|^---\s*\n[\s\S]+?\n---\s*$)/im.test(
    value
      .replace(/<br\s*\/?>/gi, "")
      .replace(/!\[[^\]]*\]\(\/api\/attachments\/[a-f0-9-]{36}\)/gi, ""),
  );
}

export type DocumentEditor = {
  element: HTMLElement;
  focused(): boolean;
  value(value: string): void;
  editable(value: boolean): void;
  format(command: DocumentFormat, selection?: Range): void;
  link(url: string, selection?: Range): void;
  removeSlash(): void;
  slash(): { query: string; length: number } | undefined;
  prepareAttachment(): (markdown: string) => void;
  table(command: TableCommand): void;
  language(value: string): void;
  destroy(): void;
};
export type TableCommand =
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "toggleHeaderRow"
  | "deleteTable";
export type DocumentBlockState =
  | { kind: "table"; element: HTMLElement }
  | { kind: "code"; element: HTMLElement; text: string; language: string };
