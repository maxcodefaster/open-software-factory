// biome-ignore-all lint/suspicious/noTemplateCurlyInString: This guard matches literal TypeScript source, not interpolated runtime URLs.
import ts from "typescript";
import { dirname, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type BrowserNetworkCall = {
  file: string;
  line: number;
  operation: string;
  arguments: string[];
};
const operations = new Set([
  "fetch",
  "apiRequest",
  "protocolRequest",
  "apiUpload",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);

export function browserNetworkCalls(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, string>();
  const calls: BrowserNetworkCall[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression) &&
            ["window", "globalThis", "self"].includes(expression.expression.getText(source))
          ? expression.name.text
          : "";
      const operation = aliases.get(name) ?? name;
      if (operations.has(operation))
        calls.push({
          file,
          operation,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          arguments: (node.arguments ?? []).map((argument) => argument.getText(source)),
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

export function browserProtocolDecision(call: BrowserNetworkCall): string | undefined {
  const { file, operation, arguments: args } = call;
  if (file === "apps/factory/src/api-client.ts") {
    if (operation === "fetch" && args.join(",") === "path,options")
      return "Exact allowlisted Better Auth JSON or multipart Review still; helper rejects every logical API.";
    if (operation === "XMLHttpRequest" && args.length === 0)
      return "Raw Attachment PUT with real transfer progress; metadata and admission use Server Functions.";
  }
  if (
    file === "apps/factory/src/attachments/ui.tsx" &&
    operation === "apiUpload" &&
    args[0] === "attachmentSummary" &&
    args[1] === "attachmentURL(id)"
  )
    return "Authenticated raw Attachment bytes, without automatic retry or publication.";
  if (
    file === "apps/factory/src/access/security-settings.tsx" &&
    operation === "protocolRequest" &&
    args[1] === '"/api/auth/sign-out"'
  )
    return "Better Auth session and cookie termination protocol.";
  if (
    file === "apps/factory/src/access/identity-settings.tsx" &&
    operation === "protocolRequest" &&
    args[1] === '"/api/auth/sign-in/sso"'
  )
    return "Better Auth SSO redirect and cookie protocol.";
  if (
    file === "apps/factory/src/review/media-client.ts" &&
    operation === "protocolRequest" &&
    args[1] === "`/api/changes/${changeID}/review/stills`"
  )
    return "Multipart JPEG bytes; Review decisions and metadata use Server Functions.";
  return undefined;
}

export function editorProtocolDecision(call: BrowserNetworkCall): string | undefined {
  const prefix = "deploy/theia-ide/factory-ide-extension/src/browser/";
  if (!call.file.startsWith(prefix)) return undefined;
  const file = call.file.slice(prefix.length),
    args = call.arguments;
  if (file === "factory-runtime-context.ts" && call.operation === "fetch" && args[0] === "...args")
    return "Granted IDE origin only: observe Workspace compute; only explicit prepare starts it.";
  if (
    file === "factory-source-client.ts" &&
    call.operation === "EventSource" &&
    args[0] === 'this.url(workspaceID, "events")'
  )
    return "Grant-bound native source/file-watch events in the original Workspace.";
  if (
    file === "factory-runtime-widget.ts" &&
    call.operation === "EventSource" &&
    args[0] === 'factoryRuntimePath(runtime, "processes/events")'
  )
    return "Grant-bound read-only process observations in the original Runtime Attempt.";
  if (
    file === "factory-writer.ts" &&
    call.operation === "fetch" &&
    (args[0] ===
      'factoryWorkspaceRuntimePath(workspaceID).replace(/\\/runtime$/, "/writer/activity")' ||
      args[0] === 'takeOver && action !== "takeover" ? `${endpoint}/${action}` : endpoint')
  )
    return "Grant-bound IDE Writer observation, editing activity and explicit CAS handoff. Same Factory authority, not a central-session API.";
  if (file === "factory-terminal-widget.ts") {
    if (call.operation === "fetch" && args[0] === "path")
      return "Explicit close of the retained PTY identified by original Workspace and Runtime Attempt.";
    if (
      call.operation === "WebSocket" &&
      args[0]?.includes("window.location.host") &&
      args[0].endsWith("${path}`")
    )
      return "Grant-bound binary PTY transport with original Workspace and Runtime Attempt.";
  }
  if (file === "factory-runtime-widget.ts" && call.operation === "fetch" && args[0] === "path")
    return "Grant-bound explicit process action in the selected immutable Runtime Attempt.";
  if (file === "factory-language-tools.ts" && call.operation === "WebSocket" && args[0] === "url")
    return "Grant-bound native language-server protocol in the original Runtime Attempt.";
  return undefined;
}

export async function inventoryBrowserTransports(root: string) {
  const modules = new Set<string>(),
    functions = new Set<string>();
  const calls: BrowserNetworkCall[] = [];
  async function visit(path: string) {
    if (modules.has(path)) return;
    modules.add(path);
    const file = relative(root, path),
      text = await readFile(path, "utf8");
    if (file.includes("/server-functions/") && /["']use server["']/.test(text)) {
      functions.add(file);
      return;
    }
    calls.push(...browserNetworkCalls(file, text));
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function inspect(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause,
          bindings = clause?.namedBindings;
        const typeOnly =
          clause?.isTypeOnly ||
          (!clause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((item) => item.isTypeOnly));
        if (!typeOnly) imports.push(node.moduleSpecifier.text);
      }
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) continue;
      const base = resolve(dirname(path), specifier);
      const target = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ].find((candidate) => /\.[cm]?tsx?$/.test(candidate) && existsSync(candidate));
      if (target) await visit(target);
    }
  }
  await visit(resolve(root, "apps/factory/src/client.tsx"));
  return {
    modules: modules.size,
    serverFunctionModules: [...functions].sort(),
    calls: calls.map((call) => ({ ...call, decision: browserProtocolDecision(call) })),
  };
}
