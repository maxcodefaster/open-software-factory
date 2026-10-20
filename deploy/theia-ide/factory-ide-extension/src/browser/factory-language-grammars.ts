import { injectable } from "@theia/core/shared/inversify";
import * as monaco from "@theia/monaco-editor-core";
import type { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";
import type { TextmateRegistry } from "@theia/monaco/lib/browser/textmate/textmate-registry";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import markdown from "@shikijs/langs/markdown";
import yaml from "@shikijs/langs/yaml";
import sql from "@shikijs/langs/sql";
import shell from "@shikijs/langs/shellscript";
import dockerfile from "@shikijs/langs/dockerfile";
import python from "@shikijs/langs/python";

const codeConfiguration: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
};

const jsonConfiguration: monaco.languages.LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
};

export const factoryLanguages = [
  {
    id: "python",
    label: "Python",
    extensions: [".py", ".pyi"],
    grammars: python,
    configuration: {
      ...codeConfiguration,
      comments: { lineComment: "#" },
    },
  },
  {
    id: "typescript",
    label: "TypeScript",
    extensions: [".ts", ".mts", ".cts"],
    grammars: typescript,
    configuration: codeConfiguration,
  },
  {
    id: "typescriptreact",
    label: "TypeScript JSX",
    extensions: [".tsx"],
    grammars: tsx,
    configuration: codeConfiguration,
  },
  {
    id: "javascript",
    label: "JavaScript",
    extensions: [".js", ".mjs", ".cjs"],
    grammars: javascript,
    configuration: codeConfiguration,
  },
  {
    id: "javascriptreact",
    label: "JavaScript JSX",
    extensions: [".jsx"],
    grammars: jsx,
    configuration: codeConfiguration,
  },
  {
    id: "css",
    label: "CSS",
    extensions: [".css"],
    grammars: css,
    configuration: {
      ...codeConfiguration,
      comments: { blockComment: ["/*", "*/"] as [string, string] },
    },
  },
  {
    id: "html",
    label: "HTML",
    extensions: [".html", ".htm"],
    grammars: html,
    configuration: { comments: { blockComment: ["<!--", "-->"] as [string, string] } },
  },
  {
    id: "json",
    label: "JSON",
    extensions: [".json"],
    grammars: json,
    configuration: jsonConfiguration,
  },
  {
    id: "jsonc",
    label: "JSON with Comments",
    extensions: [".jsonc"],
    filenames: ["tsconfig.json", "jsconfig.json"],
    grammars: jsonc,
    configuration: { ...jsonConfiguration, comments: codeConfiguration.comments },
  },
  {
    id: "markdown",
    label: "Markdown",
    extensions: [".md", ".markdown"],
    grammars: markdown,
    configuration: {},
  },
  {
    id: "yaml",
    label: "YAML",
    extensions: [".yml", ".yaml"],
    grammars: yaml,
    configuration: { comments: { lineComment: "#" } },
  },
  {
    id: "sql",
    label: "SQL",
    extensions: [".sql"],
    grammars: sql,
    configuration: {
      ...codeConfiguration,
      comments: { lineComment: "--", blockComment: ["/*", "*/"] as [string, string] },
    },
  },
  {
    id: "shellscript",
    label: "Shell Script",
    extensions: [".sh", ".bash", ".zsh"],
    grammars: shell,
    configuration: { comments: { lineComment: "#" } },
  },
  {
    id: "dockerfile",
    label: "Dockerfile",
    extensions: [".dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
    grammars: dockerfile,
    configuration: { comments: { lineComment: "#" } },
  },
];

@injectable()
export class FactoryLanguageGrammars implements LanguageGrammarDefinitionContribution {
  registerTextmateLanguage(registry: TextmateRegistry): void {
    const registeredScopes = new Set<string>();
    for (const language of factoryLanguages) {
      monaco.languages.register({
        id: language.id,
        aliases: [language.label, language.id],
        extensions: language.extensions,
        filenames: "filenames" in language ? language.filenames : undefined,
      });
      monaco.languages.setLanguageConfiguration(language.id, language.configuration);
      for (const grammar of language.grammars) {
        if (registeredScopes.has(grammar.scopeName)) continue;
        registeredScopes.add(grammar.scopeName);
        registry.registerTextmateGrammarScope(grammar.scopeName, {
          getGrammarDefinition: async () => ({ format: "json", content: grammar }),
        });
      }
      const grammar = language.grammars.at(-1);
      if (grammar) registry.mapLanguageIdToTextmateGrammar(language.id, grammar.scopeName);
    }
  }
}
