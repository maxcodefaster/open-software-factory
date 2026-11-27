import type { Node as DocumentNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";

// A broad structural replacement may span unchanged prose. Retain positions within
// an exact unchanged text block; duplicated blocks keep ProseMirror's mapped fallback.
export function preserveDocumentSelection(transaction: Transaction, selection: TextSelection) {
  const retain = (position: typeof selection.$anchor) => {
    const matches: number[] = [];
    transaction.doc.descendants((node: DocumentNode, offset: number) => {
      if (node.isTextblock && node.eq(position.parent))
        matches.push(offset + 1 + position.parentOffset);
    });
    if (matches.length === 1) return matches[0];
    return transaction.mapping.map(position.pos);
  };
  const anchor = retain(selection.$anchor),
    head = retain(selection.$head);
  if (anchor !== undefined && head !== undefined)
    transaction.setSelection(TextSelection.create(transaction.doc, anchor, head));
  return transaction;
}
