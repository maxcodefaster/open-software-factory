import { toHtml } from "hast-util-to-html";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

export const codeLanguages = [
  "plaintext",
  "typescript",
  "javascript",
  "json",
  "bash",
  "css",
  "html",
  "python",
  "go",
  "sql",
  "yaml",
] as const;
export const codeHighlighter = createLowlight({
  typescript,
  javascript,
  json,
  bash,
  css,
  xml,
  python,
  go,
  sql,
  yaml,
  plaintext: () => ({ name: "Plain text", contains: [] }),
});
codeHighlighter.registerAlias({
  typescript: ["ts", "tsx"],
  javascript: ["js", "jsx"],
  xml: ["html"],
  bash: ["sh", "shell"],
});

const maximumHighlightedCharacters = 80_000;

function plainCode(text: string): ReturnType<typeof codeHighlighter.highlight> {
  return {
    type: "root",
    children: [{ type: "text", value: text }],
    data: { language: undefined, relevance: 0 },
  };
}

// Tiptap also auto-detects unknown languages. Bound both grammar paths without
// truncating the authored code or changing its saved language.
export const codeBlockHighlighter = {
  ...codeHighlighter,
  highlight(...args: Parameters<typeof codeHighlighter.highlight>) {
    return args[1].length > maximumHighlightedCharacters
      ? plainCode(args[1])
      : codeHighlighter.highlight(...args);
  },
  highlightAuto(...args: Parameters<typeof codeHighlighter.highlightAuto>) {
    return args[0].length > maximumHighlightedCharacters
      ? plainCode(args[0])
      : codeHighlighter.highlightAuto(...args);
  },
};

export function highlightedCode(text: string, language: string) {
  if (text.length > maximumHighlightedCharacters || !codeHighlighter.registered(language)) return;
  return toHtml(codeHighlighter.highlight(language, text));
}
