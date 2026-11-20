import { expect, spyOn, test } from "bun:test";
import { toHtml } from "hast-util-to-html";
import { codeBlockHighlighter, codeHighlighter, highlightedCode } from "./code-highlighting";
import { markdownHTML } from "./markdown";

test("editor highlighting retains registered grammars, aliases and explicit plain text", () => {
  for (const [language, text] of [
    ["ts", "const ready: boolean = true;"],
    ["tsx", "const ready: boolean = true;"],
    ["js", "const ready = true;"],
    ["jsx", "const ready = true;"],
    ["json", '{"ready": true}'],
    ["sh", 'echo "$HOME"'],
    ["shell", 'echo "$HOME"'],
    ["css", "body { color: red; }"],
    ["html", "<strong>Ready</strong>"],
    ["python", "def ready():\n  return True"],
    ["go", "func ready() bool { return true }"],
    ["sql", "SELECT ready FROM tasks;"],
    ["yaml", "ready: true"],
    ["plaintext", "<script>const ready = true;</script>"],
  ] as const) {
    expect(codeBlockHighlighter.registered(language)).toBe(true);
    expect(codeBlockHighlighter.highlight(language, text)).toEqual(
      codeHighlighter.highlight(language, text),
    );
  }
  expect(toHtml(codeBlockHighlighter.highlight("plaintext", "<script>"))).toBe("&#x3C;script>");
  expect(codeBlockHighlighter.listLanguages()).toEqual(codeHighlighter.listLanguages());
});

test("editor highlighting preserves options, auto-detection and unknown-language behavior", () => {
  const text = "const ready: boolean = true;";
  expect(codeBlockHighlighter.highlight("ts", text, { prefix: "syntax-" })).toEqual(
    codeHighlighter.highlight("ts", text, { prefix: "syntax-" }),
  );
  const options = { subset: ["typescript"], prefix: "syntax-" };
  expect(codeBlockHighlighter.highlightAuto(text, options)).toEqual(
    codeHighlighter.highlightAuto(text, options),
  );
  expect(() => codeBlockHighlighter.highlight("factory-unknown", text)).toThrow("Unknown language");
  expect(highlightedCode(text, "factory-unknown")).toBeUndefined();
});

test("reader and editor still highlight exactly 80,000 characters", () => {
  const text = "const ready = true;\n".padEnd(80_000, " ");
  const highlight = spyOn(codeHighlighter, "highlight");
  const highlightAuto = spyOn(codeHighlighter, "highlightAuto");
  try {
    expect(toHtml(codeBlockHighlighter.highlight("ts", text))).toContain("hljs-keyword");
    expect(highlight).toHaveBeenCalledWith("ts", text);
    expect(toHtml(codeBlockHighlighter.highlightAuto(text, { subset: ["typescript"] }))).toContain(
      "hljs-keyword",
    );
    expect(highlightAuto).toHaveBeenCalledWith(text, { subset: ["typescript"] });
    expect(highlightedCode(text, "ts")).toContain("hljs-keyword");
  } finally {
    highlight.mockRestore();
    highlightAuto.mockRestore();
  }
});

test("oversized code bypasses both grammar paths and retains all plain text", () => {
  const text = '  const ready = "<script>&";\n'.padEnd(80_001, " ");
  const highlight = spyOn(codeHighlighter, "highlight");
  const highlightAuto = spyOn(codeHighlighter, "highlightAuto");
  try {
    for (const tree of [
      codeBlockHighlighter.highlight("ts", text),
      codeBlockHighlighter.highlightAuto(text),
    ]) {
      expect(tree.children).toEqual([{ type: "text", value: text }]);
      const html = toHtml(tree);
      expect(html.slice(0, 100)).toContain("&#x3C;script>&#x26;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("hljs-");
      expect(html).toEndWith(" ");
    }
    expect(highlightedCode(text, "ts")).toBeUndefined();
    const rendered = markdownHTML(`\`\`\`ts\n${text}\n\`\`\``, true);
    expect(rendered).toContain('class="language-ts"');
    expect(rendered).toContain('aria-label="Copy code"');
    expect(rendered).toContain("&lt;script&gt;&amp;");
    expect(rendered).not.toContain("hljs-");
    expect(highlight).not.toHaveBeenCalled();
    expect(highlightAuto).not.toHaveBeenCalled();
  } finally {
    highlight.mockRestore();
    highlightAuto.mockRestore();
  }
});
