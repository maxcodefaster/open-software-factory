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

export function highlightedCode(text: string, language: string) {
  if (text.length > 80_000 || !codeHighlighter.registered(language)) return;
  return toHtml(codeHighlighter.highlight(language, text));
}
