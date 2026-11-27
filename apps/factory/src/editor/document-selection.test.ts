import { expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { documentExtensions } from "./document-editor";
import { preserveDocumentSelection } from "./document-selection";

test("an external structural replacement retains cursor in unchanged human prose", () => {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: documentExtensions(),
    contentType: "markdown",
    content: "Old source.\n\nHuman framing.",
  });
  try {
    const selection = TextSelection.create(editor.state.doc, editor.state.doc.content.size - 3);
    const next = editor.schema.nodeFromJSON(
      editor.storage.markdown.manager.parse("New source with longer context.\n\nHuman framing."),
    );
    const transaction = editor.state.tr.replace(0, editor.state.doc.content.size, next.slice(0));
    preserveDocumentSelection(transaction, selection);
    expect(transaction.selection.$from.parent.textContent).toBe("Human framing.");
    expect(transaction.selection.$from.parentOffset).toBe(selection.$from.parentOffset);
  } finally {
    editor.destroy();
  }
});
