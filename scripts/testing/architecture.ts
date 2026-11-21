import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const domainLibraries = new Set(["zod", "diff", "node:crypto", "node:path"]);
const browserServerLibraries =
  /^(?:postgres(?:\/|$)|drizzle-orm(?:\/|$)|@(?:ai-sdk|mastra|opencode)\/)/;
const integration =
  /^(?:apps\/factory\/src(?:\/|$)|packages\/(?:db|auth|forge|runtime-kubernetes|zero-schema|zero-solid)(?:\/|$))/;
const browserImplementation =
  /^(?:packages\/(?:db|auth|forge|runtime-kubernetes)\/|apps\/factory\/src\/(?:secrets\/|server\/|server\.ts$|models\/native(?:\.|$)|(?:access|agent|runtime)\/controller(?:\.|$)))/;
const domain = /^packages\/[^/]+-domain\/src\/.*\.[cm]?tsx?$/;
const browser = /^apps\/factory\/src\/(?:.*\.tsx$|(?:desktop|ui|navigation)\/.*\.[cm]?ts$)/;
const sourcePath = (path: string) => relative(root, resolve(root, path)).split(sep).join("/");

export function architectureViolations(path: string, source: string) {
  const file = sourcePath(path);
  if (/\.test\.[cm]?tsx?$/.test(file) || (!domain.test(file) && !browser.test(file))) return [];
  const errors: string[] = [];
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function inspect(node: ts.Node, specifier: ts.Node | undefined) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      errors.push(`${file}: use a literal module path so Factory can check its owner`);
      return;
    }
    const name = specifier.text;
    const relativeImport = name.startsWith(".") || name.startsWith("/");
    const local = relativeImport ? sourcePath(resolve(dirname(resolve(root, file)), name)) : name;
    const violation = domain.test(file)
      ? (!relativeImport && !domainLibraries.has(name)) ||
        integration.test(local) ||
        local.startsWith("../") ||
        local.startsWith("node_modules/")
      : browserImplementation.test(local) ||
        browserServerLibraries.test(name) ||
        (relativeImport && (local.startsWith("../") || local.startsWith("node_modules/"))) ||
        /^(?:node:)?(?:fs|child_process|net|tls)(?:\/|$)/.test(name);
    if (!violation) return;
    const line = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1;
    errors.push(
      `${file}:${line}: Factory ${domain.test(file) ? "domain" : "browser"} boundary rejects ${name}. ` +
        (domain.test(file)
          ? "Use a domain contract and put integration in its feature adapter."
          : "Use a domain contract or authenticated server function, not a server implementation."),
    );
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) inspect(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspect(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      inspect(node, node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      inspect(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return errors;
}

if (import.meta.main) {
  const files: string[] = [];
  for (const base of ["packages", "apps/factory/src"])
    for await (const path of new Bun.Glob("**/*.{ts,tsx,mts,cts}").scan(resolve(root, base))) {
      const file = `${base}/${path}`;
      if ((domain.test(file) || browser.test(file)) && !/\.test\.[cm]?tsx?$/.test(file))
        files.push(file);
    }
  const errors = (
    await Promise.all(
      files.map(async (path) =>
        architectureViolations(path, await readFile(resolve(root, path), "utf8")),
      ),
    )
  ).flat();
  for (const error of errors) console.error(error);
  console.log(`Factory architecture: ${files.length} owned modules, ${errors.length} violations`);
  process.exitCode = errors.length ? 1 : 0;
}
