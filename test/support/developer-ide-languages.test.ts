import { expect, mock, test } from "bun:test";
import { TextmateRegistry } from "../../deploy/theia-ide/node_modules/@theia/monaco/lib/browser/textmate/textmate-registry";
import { Registry, parseRawGrammar } from "../../deploy/theia-ide/node_modules/vscode-textmate";
import {
  loadWASM,
  OnigScanner,
  OnigString,
} from "../../deploy/theia-ide/node_modules/vscode-oniguruma";

const registered: Array<{ id: string; extensions: string[] }> = [];
const configurations = new Map<string, unknown>();
mock.module("../../deploy/theia-ide/node_modules/@theia/monaco-editor-core", () => ({
  languages: {
    register: (language: { id: string; extensions: string[] }) => registered.push(language),
    setLanguageConfiguration: (id: string, configuration: unknown) =>
      configurations.set(id, configuration),
  },
}));
const { FactoryLanguageGrammars, factoryLanguages } = await import(
  "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-language-grammars"
);
const registry = new TextmateRegistry();
new FactoryLanguageGrammars().registerTextmateLanguage(registry);
await loadWASM(
  await Bun.file(
    new URL(
      "../../deploy/theia-ide/node_modules/vscode-oniguruma/release/onig.wasm",
      import.meta.url,
    ),
  ).arrayBuffer(),
);

const tokenizer = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns) => new OnigScanner(patterns),
    createOnigString: (value) => new OnigString(value),
  }),
  loadGrammar: async (scope) => {
    const definition = await registry.getProvider(scope)?.getGrammarDefinition();
    return definition
      ? parseRawGrammar(JSON.stringify(definition.content), "factory-grammar.json")
      : null;
  },
});

async function grammarFor(language: string) {
  const scope = registry.getScope(language);
  if (!scope) throw new Error(`Missing grammar scope for ${language}`);
  const grammar = await tokenizer.loadGrammar(scope);
  if (!grammar) throw new Error(`Could not load grammar for ${language}`);
  return grammar;
}

test("Starter languages register actual upstream grammars and editing configuration", () => {
  expect(registered.map((language) => language.id)).toEqual(
    factoryLanguages.map((language) => language.id),
  );
  for (const [extension, id] of [
    [".ts", "typescript"],
    [".mts", "typescript"],
    [".cts", "typescript"],
    [".tsx", "typescriptreact"],
    [".jsx", "javascriptreact"],
    [".json", "json"],
    [".css", "css"],
    [".html", "html"],
    [".md", "markdown"],
    [".yml", "yaml"],
  ] as const) {
    expect(registered.find((language) => language.extensions.includes(extension))?.id).toBe(id);
  }
  for (const language of factoryLanguages) {
    expect(registry.getScope(language.id)).toBe(language.grammars.at(-1)?.scopeName);
    const scope = registry.getScope(language.id);
    if (!scope) throw new Error(`Missing registered scope for ${language.id}`);
    expect(registry.getProvider(scope)).toBeDefined();
    expect(configurations.has(language.id)).toBe(true);
  }
  expect(configurations.get("typescript")).toMatchObject({
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
  });
  expect(configurations.get("json")).not.toHaveProperty("comments", expect.anything());
  expect(configurations.get("json")).toMatchObject({
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
  });
  expect(configurations.get("jsonc")).toMatchObject({
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
  });
});

test("real TypeScript and TSX grammars distinguish code, strings, comments and JSX", async () => {
  const grammar = await grammarFor("typescript");
  const tokens = grammar.tokenizeLine("export const title: string = 'hello'; // retained", null);
  const scopes = tokens.tokens.flatMap((token) => token.scopes);
  expect(scopes.some((scope) => scope.startsWith("keyword"))).toBe(true);
  expect(scopes.some((scope) => scope.startsWith("storage"))).toBe(true);
  expect(scopes.some((scope) => scope.startsWith("string"))).toBe(true);
  expect(scopes.some((scope) => scope.startsWith("comment"))).toBe(true);
  const jsxGrammar = await grammarFor("typescriptreact");
  const jsx = jsxGrammar.tokenizeLine('const view = <button title="Save">{title}</button>;', null);
  expect(jsx.tokens.flatMap((token) => token.scopes)).toContain("entity.name.tag.tsx");
});

test("HTML embedded styles and scripts resolve registered dependency grammars", async () => {
  const grammar = await grammarFor("html");
  let state = grammar.tokenizeLine("<script>", null).ruleStack;
  const code = grammar.tokenizeLine('const name = "Factory";', state);
  expect(code.tokens.flatMap((token) => token.scopes)).toContain("source.js");
  state = grammar.tokenizeLine("</script><style>", code.ruleStack).ruleStack;
  const style = grammar.tokenizeLine(".button { color: red; }", state);
  expect(style.tokens.flatMap((token) => token.scopes)).toContain("source.css");
});
