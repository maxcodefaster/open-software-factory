import { expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { documentExtensions, supportsDocumentMarkdown } from "./document-editor";

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
