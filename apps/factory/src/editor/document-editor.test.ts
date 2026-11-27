import { expect, spyOn, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { codeHighlighter } from "./code-highlighting";
import { documentExtensions } from "./document-editor";
import { supportsDocumentMarkdown } from "./document-model";

function codeDecorations(state: EditorState) {
  return state.plugins.flatMap((plugin) => {
    const decorations = plugin.props.decorations?.call(plugin, state);
    return decorations instanceof DecorationSet ? decorations.find() : [];
  });
}

test("the actual editor bounds explicit and unknown-language code blocks without losing Markdown", () => {
  const text = 'const ready = "<script>&";\n'.padEnd(80_001, " ");
  const highlight = spyOn(codeHighlighter, "highlight");
  const highlightAuto = spyOn(codeHighlighter, "highlightAuto");
  try {
    for (const language of ["ts", "factory-unknown"]) {
      const editor = new Editor({
        element: null,
        injectCSS: false,
        extensions: documentExtensions(),
        contentType: "markdown",
        content: `\`\`\`${language}\n${text}\n\`\`\``,
      });
      try {
        const state = EditorState.create({
          doc: editor.state.doc,
          schema: editor.schema,
          plugins: editor.extensionManager.plugins,
        });
        expect(codeDecorations(state)).toEqual([]);
        expect(state.doc.firstChild?.textContent).toBe(text);
        expect(state.doc.firstChild?.attrs["language"]).toBe(language);
        expect(editor.getMarkdown()).toBe(`\`\`\`${language}\n${text}\n\`\`\``);
      } finally {
        editor.destroy();
      }
    }
    expect(highlight).not.toHaveBeenCalled();
    expect(highlightAuto).not.toHaveBeenCalled();
  } finally {
    highlight.mockRestore();
    highlightAuto.mockRestore();
  }
});

test("editing across the code limit removes and restores native highlighting decorations", () => {
  const text = "const ready = true;\n".padEnd(80_000, " ");
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: documentExtensions(),
    contentType: "markdown",
    content: `\`\`\`ts\n${text}\n\`\`\``,
  });
  try {
    let state = EditorState.create({
      doc: editor.state.doc,
      schema: editor.schema,
      plugins: editor.extensionManager.plugins,
    });
    expect(codeDecorations(state).length).toBeGreaterThan(0);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)).insertText(" "));
    expect(state.doc.firstChild?.textContent).toBe(` ${text}`);
    expect(codeDecorations(state)).toEqual([]);
    state = state.apply(state.tr.delete(1, 2));
    expect(state.doc.firstChild?.textContent).toBe(text);
    expect(codeDecorations(state).length).toBeGreaterThan(0);
  } finally {
    editor.destroy();
  }
});

test("unknown editor languages still auto-detect within the code limit", () => {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: documentExtensions(),
    contentType: "markdown",
    content: "```factory-unknown\nconst ready: boolean = true;\n```",
  });
  const highlightAuto = spyOn(codeHighlighter, "highlightAuto");
  try {
    const state = EditorState.create({
      doc: editor.state.doc,
      schema: editor.schema,
      plugins: editor.extensionManager.plugins,
    });
    expect(highlightAuto).toHaveBeenCalledWith("const ready: boolean = true;");
    expect(codeDecorations(state).length).toBeGreaterThan(0);
    expect(editor.getMarkdown()).toContain("```factory-unknown");
  } finally {
    highlightAuto.mockRestore();
    editor.destroy();
  }
});

test("the actual editor retains headings, lists, tasks, tables, links and code through Markdown", () => {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: documentExtensions(),
    contentType: "markdown",
    content:
      "## Scope\n\nA **clear** [reference](https://example.com).\n\n- First\n- Second\n\n- [ ] Pending\n- [x] Complete\n\n| Owner | Scope |\n| --- | --- |\n| Developer | Editor |\n\n```ts\nconst ready = true;\n```",
  });
  try {
    const value = editor.getMarkdown();
    expect(value).toContain("## Scope");
    expect(value).toContain("**clear**");
    expect(value).toContain("[reference](https://example.com)");
    expect(value).toContain("[ ] Pending");
    expect(value).toContain("[x] Complete");
    expect(value).toContain("Developer");
    expect(value).toContain("```ts");
    const types = editor.getJSON().content?.map((node) => node.type);
    expect(types).toContain("table");
    expect(types).toContain("taskList");
    expect(types).toContain("codeBlock");
  } finally {
    editor.destroy();
  }
});

test("unsupported authored image, reference and HTML constructs remain source-editable", () => {
  expect(supportsDocumentMarkdown("![Diagram](https://example.com/diagram.png)")).toBe(false);
  expect(supportsDocumentMarkdown("[reference]: https://example.com")).toBe(false);
  expect(supportsDocumentMarkdown("<aside>Do not drop this.</aside>")).toBe(false);
  expect(supportsDocumentMarkdown("| Owner |\n| --- |\n| Developer |")).toBe(true);
  expect(supportsDocumentMarkdown("| Owner<br>Scope |\n| --- |\n| Developer |")).toBe(true);
  expect(supportsDocumentMarkdown('<br onmouseover="alert(1)">')).toBe(false);
});

test("table header removal retains authored cells and stabilizes canonical GFM on reload", () => {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: documentExtensions(),
    contentType: "markdown",
    content: "| Owner | Scope |\n| --- | --- |\n| Developer | Editor |",
  });
  try {
    editor.commands.setTextSelection(3);
    expect(editor.commands.toggleHeaderRow()).toBe(true);
    const first = editor.getMarkdown();
    expect(first).toContain("Owner");
    expect(first).toContain("Developer");
    expect(first).toContain("Editor");
    editor.commands.setContent(first, { contentType: "markdown" });
    expect(editor.getMarkdown()).toBe(first);
  } finally {
    editor.destroy();
  }
});

test("Factory image references round-trip in the rich editor without admitting remote images", () => {
  const id = crypto.randomUUID();
  const body = `## Design\n\n![Visual reference](/api/attachments/${id})\n\n[Brief.pdf](/api/attachments/${crypto.randomUUID()})`;
  expect(supportsDocumentMarkdown(body)).toBe(true);
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: documentExtensions(),
    contentType: "markdown",
    content: body,
  });
  try {
    expect(editor.getJSON().content?.some((node) => node.type === "image")).toBe(true);
    const saved = editor.getMarkdown();
    expect(saved).toContain(`/api/attachments/${id}`);
    editor.commands.setContent(saved, { contentType: "markdown" });
    expect(editor.getMarkdown()).toBe(saved);
    expect(supportsDocumentMarkdown("![Remote](https://example.invalid/pixel.png)")).toBe(false);
  } finally {
    editor.destroy();
  }
});
