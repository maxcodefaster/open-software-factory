import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const sourceExtension = /\.[cm]?tsx?$/;
const testModule = /\.(?:test|spec)\.[cm]?tsx?$/;
const domain = /^packages\/[^/]+-domain\/src\//;
const product = /^(?:apps\/factory\/src\/|packages\/[^/]+\/src\/)/;
const browserEntry =
  /^apps\/factory\/src\/(?:.*\.tsx$|(?:desktop|ui|navigation)\/|[^/]+\/(?:contracts|client)\.[cm]?ts$|optional-values\.ts$)/;
const domainLibraries = new Set(["zod", "diff", "node:crypto", "node:path"]);
const nodeLibraries = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const browserServerLibraries =
  /^(?:postgres(?:\/|$)|drizzle-orm(?:\/|$)|@(?:ai-sdk|mastra|opencode)\/|@modelcontextprotocol\/server(?:\/|$)|@rocicorp\/zero\/server(?:\/|$)|@tanstack\/solid-start\/server(?:\/|$)|bun$)/;
// Feature directories also contain public contracts, validators and browser helpers.
// Classify implementation owners, not entire features. Their other helpers are
// checked through the resolved graph, including type-only edges.
const serverImplementation =
  /^(?:packages\/(?:db|auth|forge|runtime-kubernetes)\/|packages\/zero-schema\/src\/(?:generate|server|[^/]+-server)(?:\.|\/|$)|apps\/factory\/src\/(?:secrets\/|storage\/|installation\/|server\/|(?:server|start-server|http-listener|static-assets)(?:\.|$)|zero\/server(?:\.|$)|server-functions\/(?:context|entry)(?:\.|$)|[^/]+\/(?:[^/]*-)?(?:controller|service|store|secrets|openbao|native|integration|hub|routes)(?:\.|\/|$)))/;
const serverRoute = /^apps\/factory\/src\/routes\/(?:api|editor|health|hooks|internal|runtime)\//;
const generatedRouteTree = "apps/factory/src/routeTree.gen.ts";

function sourcePath(path: string, repositoryRoot = root) {
  return relative(repositoryRoot, resolve(repositoryRoot, path)).split(sep).join("/");
}

type ImportEdge = {
  name: string | undefined;
  line: number;
  typeOnly: boolean;
  reExport: boolean;
  namedReExport: boolean;
  target?: string;
  library?: string;
};
type Module = {
  edges: ImportEdge[];
  serverFunction: boolean;
  forwardingFacade: boolean;
  esmViolations: string[];
};
type Options = { root?: string; compilerOptions?: ts.CompilerOptions };

function serverFunctionModule(file: string, syntax: ts.SourceFile) {
  if (!file.startsWith("apps/factory/src/server-functions/")) return false;
  const factories = new Set<string>();
  for (const statement of syntax.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@tanstack/solid-start" &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const binding of statement.importClause.namedBindings.elements)
        if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === "createServerFn")
          factories.add(binding.name.text);
  }
  function isServerFunction(expression: ts.Expression | undefined, handler = false): boolean {
    if (!expression || !ts.isCallExpression(expression)) return false;
    if (ts.isIdentifier(expression.expression))
      return factories.has(expression.expression.text) && handler;
    if (!ts.isPropertyAccessExpression(expression.expression)) return false;
    return isServerFunction(
      expression.expression.expression,
      handler || expression.expression.name.text === "handler",
    );
  }
  let functions = 0;
  for (const statement of syntax.statements) {
    // A re-export or an ordinary exported helper is not a compiled RPC boundary.
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return false;
    if (!ts.canHaveModifiers(statement)) continue;
    if (
      !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (!ts.isVariableStatement(statement)) return false;
    for (const declaration of statement.declarationList.declarations) {
      if (!isServerFunction(declaration.initializer)) return false;
      functions++;
    }
  }
  return functions > 0;
}

function imports(file: string, source: string): Module {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edges: ImportEdge[] = [];
  const esmViolations: string[] = [];
  const forwardedNames = new Set<string>();
  for (const statement of syntax.statements)
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        forwardedNames.add((element.propertyName ?? element.name).text);
  // Named facet files select existing exports rather than contain implementation.
  // A backend SDK adapter such as agent/opencode-adapter.ts is not a browser/public
  // facade merely because its filename ends in -client.ts. Invalid wildcard
  // facades still qualify here, so the named-export diagnostic cannot be bypassed.
  const forwardingFacade =
    syntax.statements.some(ts.isExportDeclaration) &&
    syntax.statements.every(
      (statement) =>
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEmptyStatement(statement),
    );
  function inspect(node: ts.Node, specifier: ts.Node | undefined) {
    const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
    const bindings = clause?.namedBindings;
    const namespaceForwarded =
      bindings && ts.isNamespaceImport(bindings) && forwardedNames.has(bindings.name.text);
    const importForwarded =
      namespaceForwarded ||
      (clause?.name && forwardedNames.has(clause.name.text)) ||
      (bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((element) => forwardedNames.has(element.name.text)));
    edges.push({
      name: specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined,
      line: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1,
      reExport: ts.isExportDeclaration(node) || Boolean(importForwarded),
      namedReExport:
        (ts.isExportDeclaration(node) &&
          node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause)) ||
        Boolean(importForwarded && !namespaceForwarded),
      typeOnly:
        ts.isImportTypeNode(node) ||
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly),
    });
  }
  function visit(node: ts.Node) {
    // Biome's noCommonJs covers require() and module.exports, but not TypeScript's
    // import/export assignments. Product code is ESM; the Theia NodeNext adapter
    // and inline upstream supervisor text are outside this authored syntax rule.
    if (
      product.test(file) &&
      ((ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) ||
        (ts.isExportAssignment(node) && node.isExportEquals))
    )
      esmViolations.push(
        `${file}:${syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1}: ` +
          "Factory ESM product code rejects TypeScript CommonJS assignments. Use ESM imports/exports.",
      );
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) inspect(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspect(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      inspect(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
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
  return {
    edges,
    serverFunction: serverFunctionModule(file, syntax),
    forwardingFacade,
    esmViolations,
  };
}

function serverLibrary(name: string) {
  return (
    browserServerLibraries.test(name) ||
    nodeLibraries.has(name.replace(/^node:/, "")) ||
    /^@types\/node(?:\/|$)/.test(name) ||
    /^(?:better-auth|@better-auth\/[^/]+)(?:$|\/(?!client(?:\.|\/|$)|dist\/client(?:\.|\/|$)))/.test(
      name,
    ) ||
    /^@(?:rocicorp\/zero|tanstack\/solid-start)\/.*\/server(?:\.|\/|$)/.test(name)
  );
}

function forbidden(edge: ImportEdge, boundary: string) {
  const { name, target: local, library } = edge;
  if (name === undefined) return true;
  const outside = local?.startsWith("../") || local?.includes("node_modules/");
  if (outside) return true;
  if (boundary === "domain")
    return local
      ? !domain.test(local) ||
          testModule.test(local) ||
          (!sourceExtension.test(local) && /\.[^/]+$/.test(local))
      : !domainLibraries.has(name) && !domainLibraries.has(library?.split("/")[0] ?? "");
  return (
    (local !== undefined && serverImplementation.test(local)) ||
    serverLibrary(name) ||
    (library !== undefined && serverLibrary(library))
  );
}

// Q6 applies to application owner directories, including server-side code. Root
// wiring, server protocols, bootstrap and desktop assemble features; they are not features.
// Only real compiled RPC modules and their exact request/dispatch owners compose
// features inside server-functions. Other files in that directory get no exemption.
function featureOwner(file: string) {
  const owner = /^apps\/factory\/src\/([^/]+)\//.exec(file)?.[1];
  return owner && !["server", "bootstrap", "routes", "desktop"].includes(owner) ? owner : undefined;
}
const functionCompositionOwners = new Set([
  "apps/factory/src/server-functions/context.ts",
  "apps/factory/src/server-functions/entry.ts",
  "apps/factory/src/server-functions/endpoint.ts",
]);
const canonicalAPIRole = /^(?:api|client|[^/]+-(?:api|client))$/;
function canonicalFeatureAPI(file: string, module: Module | undefined) {
  const name = /^apps\/factory\/src\/[^/]+\/([^/]+)\.[cm]?ts$/.exec(file)?.[1];
  return (
    name !== undefined &&
    canonicalAPIRole.test(name) &&
    (name === "api" || name === "client" || module?.forwardingFacade === true)
  );
}
const publicFeatureRole = /^(?:authority|contracts|service|[^/]+-(?:contracts?|service))$/;
const contractRole = /^(?:contracts|[^/]+-contracts?)$/;
// These existing commands modules declare input schemas. Workspace's commands
// module instead implements persisted shell/terminal execution and stays private.
// A filename alone cannot make that implementation an independent contract.
const commandContractEntries = new Set([
  "apps/factory/src/access/commands.ts",
  "apps/factory/src/agent/commands.ts",
  "apps/factory/src/attachments/commands.ts",
  "apps/factory/src/mcp/commands.ts",
  "apps/factory/src/project-agent/commands.ts",
  "apps/factory/src/skills/commands.ts",
]);
function featureContract(file: string) {
  return (
    contractRole.test(file.slice(file.lastIndexOf("/") + 1).replace(/\.[cm]?ts$/, "")) ||
    commandContractEntries.has(file) ||
    ["apps/factory/src/agent/turn-record.ts", "apps/factory/src/runtime/types.ts"].includes(file)
  );
}
// Existing non-conventional entrypoints with a specific public responsibility.
// These are not allowances for controllers/stores/engines. New private helpers
// remain private unless exposed through an owned API, authority or contract.
const publicFeatureEntries = new Set([
  // Shared access checks and admitted writer commands are authority APIs.
  "access/change-writer",
  "access/runtime",
  "access/workspace",
  "access/writer-command",
  "workspace/source-role-fence",
  "setup/execution-gate",
  "installation/maintenance",
  "usage/compute",
  // Bounded feature commands, source validation and rendering.
  "projects/creation",
  "knowledge/code-read",
  "knowledge/forge-source",
  "knowledge/edit",
  "monitoring/instructions",
  "technical-design/diagrams",
  // Model/usage facades hide provider selection and the private accounting journal.
  "models/native",
  "models/resolver",
  "models/execution-policy",
  "runtime/endpoints",
  "usage/record-mastra",
  "usage/record-opencode",
  // The retained turn record is a declaration, not the persistence implementation.
  "agent/turn-record",
  "runtime/types",
  // Public browser state/input adapters and shared infrastructure ports.
  "attachments/composer",
  "attachments/mention-text",
  "change/drafts",
  "inbox/client",
  "inbox/navigation",
  "knowledge/source-link",
  "knowledge/state",
  "knowledge/draft",
  "knowledge/language",
  "models/reasoning",
  "models/probe-result",
  "access/settings-return",
  "projects/planning",
  "projects/ticket-content",
  "project-agent/selection",
  "workspace/state",
  "library-covers/catalog",
  "ui/clipboard",
  "navigation/desktop",
  "zero/invalidated-read",
  "secrets/openbao",
  "storage/objects",
  "server-functions/result",
  "server-functions/client-transport",
  "server-functions/shared-reads",
]);

function featureEntry(file: string, module: Module | undefined) {
  if (module?.serverFunction) return true;
  const path = file.replace(/^apps\/factory\/src\//, "").replace(/\.[cm]?tsx?$/, "");
  const name = path.slice(path.indexOf("/") + 1);
  // Top-level feature views are public UI components. Nested private components
  // are not entrypoints, and all JSX remains subject to the browser/server guard.
  return (
    (file.endsWith(".tsx") && !name.includes("/")) ||
    canonicalFeatureAPI(file, module) ||
    publicFeatureRole.test(name) ||
    commandContractEntries.has(file) ||
    publicFeatureEntries.has(path)
  );
}

function featureViolations(graph: ReadonlyMap<string, Module>) {
  const errors: string[] = [];
  const owners = new Set(
    [...graph.keys()].map(featureOwner).filter((owner) => owner !== undefined),
  );
  for (const owner of [...owners].sort()) {
    const queue = [...graph.keys()]
      .filter(
        (file) =>
          featureOwner(file) === owner &&
          !graph.get(file)?.serverFunction &&
          !functionCompositionOwners.has(file),
      )
      .sort();
    const paths = new Map(queue.map((file) => [file, [] as string[]]));
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index];
      if (!file) continue;
      const trail = paths.get(file) ?? [];
      const module = graph.get(file);
      const ownEntry = featureEntry(file, module);
      const ownContract = featureContract(file);
      const canonicalAPI = canonicalFeatureAPI(file, module);
      for (const edge of module?.edges ?? []) {
        const location = `${file}:${edge.line}`;
        const chain = [...trail, location];
        if (edge.name === undefined) {
          errors.push(
            `${location}: Factory feature boundary requires a literal module path to check its owner.`,
          );
          continue;
        }
        if (canonicalAPI && edge.reExport && !edge.namedReExport) {
          errors.push(
            `${location}: Factory feature boundary rejects ${edge.name} [${edge.target ?? edge.library ?? edge.name}]. ` +
              "A canonical API/client must select named exports, not expose a wildcard or namespace barrel.",
          );
          continue;
        }
        const target = edge.target;
        if (!target) continue;
        // Style sheets and data assets are not private TypeScript implementations.
        if (!/\.[cm]?[jt]sx?$/.test(target) && /\.[^/]+$/.test(target)) continue;
        const targetOwner = featureOwner(target);
        const publicTarget = featureEntry(target, graph.get(target));
        const privateCrossing = targetOwner && targetOwner !== owner && !publicTarget;
        const implementationContract = ownContract && targetOwner && !featureContract(target);
        const privateExposure =
          targetOwner === owner &&
          ownEntry &&
          !publicTarget &&
          (ownContract || (edge.reExport && !(canonicalAPI && edge.namedReExport)));
        if (privateCrossing || privateExposure || implementationContract) {
          errors.push(
            `${location}: Factory feature boundary rejects ${edge.name} [${target}]. ` +
              (privateExposure || implementationContract
                ? "Use a canonical API/client for named operations; public contracts must be independent of private implementations."
                : `Feature ${owner} must use ${targetOwner}'s public API, authority or contract, not its private implementation.`) +
              (trail.length ? ` Import chain: ${chain.join(" -> ")}.` : ""),
          );
          continue;
        }
        // A public facade may call its own private implementation. Check that
        // feature's edges under its own owner, rather than attributing them to
        // every caller. Shared/root/package barrels do not reset the caller's owner.
        if (!targetOwner && graph.has(target) && !paths.has(target)) {
          paths.set(target, chain);
          queue.push(target);
        }
      }
    }
  }
  return errors;
}

// Only these declarative graphs are exempt from cycles. Drizzle tables mutually
// reference keys in deferred FK callbacks; this is a relational model, not feature
// execution. Exempt only schema-to-schema edges so a schema importing feature code
// still participates. TanStack's generated registration points back at router types,
// and Zero's exact generated schema describes tables/relationships. Neither is an
// authored dependency direction. They are still inspected for boundary violations.
const generatedCycleModules = new Set([
  generatedRouteTree,
  "packages/zero-schema/src/schema.generated.ts",
]);
function cycleEdge(from: string, to: string) {
  return (
    product.test(from) &&
    product.test(to) &&
    !generatedCycleModules.has(from) &&
    !generatedCycleModules.has(to) &&
    !(from.startsWith("packages/db/src/schema/") && to.startsWith("packages/db/src/schema/"))
  );
}

function cycles(graph: ReadonlyMap<string, Module>) {
  const errors: string[] = [];
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];
  const steps: ImportEdge[] = [];
  function visit(file: string) {
    state.set(file, "active");
    stack.push(file);
    for (const edge of graph.get(file)?.edges ?? []) {
      const target = edge.target;
      if (!target || !graph.has(target) || !cycleEdge(file, target)) continue;
      if (state.get(target) === "active") {
        const start = stack.indexOf(target);
        const chain = stack.slice(start).map((path, index) => {
          const step = index === stack.length - start - 1 ? edge : steps[start + index];
          return `${path}:${step?.line}`;
        });
        errors.push(
          `${file}:${edge.line}: Factory dependency cycle: ${[...chain, target].join(" -> ")}. ` +
            "Move shared contracts or helpers to their owner; type imports count too.",
        );
      } else if (!state.has(target)) {
        steps.push(edge);
        visit(target);
        steps.pop();
      }
    }
    stack.pop();
    state.set(file, "done");
  }
  for (const file of [...graph.keys()].sort()) if (!state.has(file)) visit(file);
  return errors;
}

export function analyzeArchitecture(sources: ReadonlyMap<string, string>, options: Options = {}) {
  const repositoryRoot = resolve(options.root ?? root);
  const files = new Map(
    [...sources].map(([path, source]) => [sourcePath(path, repositoryRoot), source]),
  );
  const absoluteFiles = new Map(
    [...files].map(([path, source]) => [resolve(repositoryRoot, path), source]),
  );
  const directories = new Set<string>();
  for (const file of absoluteFiles.keys())
    for (
      let directory = dirname(file);
      directory !== dirname(directory);
      directory = dirname(directory)
    )
      directories.add(directory);
  // Use the pinned compiler's resolver for paths/baseUrl, .js -> .ts, directory
  // indexes and workspace package exports. Do not invent a second alias grammar.
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => absoluteFiles.has(resolve(path)) || ts.sys.fileExists(path),
    readFile: (path) => absoluteFiles.get(resolve(path)) ?? ts.sys.readFile(path),
    directoryExists: (path) => directories.has(resolve(path)) || ts.sys.directoryExists(path),
    getCurrentDirectory: () => repositoryRoot,
  };
  const compilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    ...options.compilerOptions,
  };
  const cache = ts.createModuleResolutionCache(repositoryRoot, (path) => path, compilerOptions);
  const graph = new Map<string, Module>();
  for (const [file, source] of files) {
    if (!sourceExtension.test(file) || testModule.test(file) || file.includes("node_modules/"))
      continue;
    const module = imports(file, source);
    for (const edge of module.edges) {
      if (!edge.name) continue;
      const resolved = ts.resolveModuleName(
        edge.name,
        resolve(repositoryRoot, file),
        compilerOptions,
        host,
        cache,
      ).resolvedModule;
      if (resolved) {
        const target = sourcePath(resolved.resolvedFileName, repositoryRoot);
        if (
          !resolved.isExternalLibraryImport ||
          (files.has(target) && !target.includes("node_modules/"))
        )
          edge.target = target;
        // A paths alias can name an installed server library instead of an owned
        // file. Keep its resolved package path so postgres cannot become "shared".
        const installed = target.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/);
        if (installed) edge.library = `${installed[1]}${installed[2] ?? ""}`;
      }
      if (edge.target === undefined && (edge.name.startsWith(".") || edge.name.startsWith("/")))
        edge.target = sourcePath(
          resolve(dirname(resolve(repositoryRoot, file)), edge.name),
          repositoryRoot,
        );
    }
    graph.set(file, module);
  }
  const errors: string[] = [...graph.values()].flatMap((module) => module.esmViolations);
  const browserModules = new Set<string>();
  for (const boundary of ["domain", "browser"]) {
    const paths = new Map<string, string[]>();
    const queue = [...graph.keys()]
      .filter((file) =>
        boundary === "domain"
          ? domain.test(file)
          : browserEntry.test(file) ||
            (/-client\.[cm]?ts$/.test(file) && canonicalFeatureAPI(file, graph.get(file))),
      )
      .sort();
    for (const file of queue) paths.set(file, []);
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index];
      if (!file) continue;
      const module = graph.get(file);
      if (!module) continue;
      if (boundary === "browser") browserModules.add(file);
      // Start strips the implementation of exported createServerFn(...).handler(...)
      // functions. A directory name alone never grants this exception.
      if (boundary === "browser" && module.serverFunction) continue;
      const trail = paths.get(file) ?? [];
      for (const edge of module.edges) {
        const location = `${file}:${edge.line}`;
        const chain = [...trail, location];
        if (forbidden(edge, boundary)) {
          errors.push(
            `${location}: Factory ${boundary} boundary ${
              edge.name === undefined
                ? "requires a literal module path"
                : `rejects ${edge.name}${edge.target || edge.library ? ` [${edge.target ?? edge.library}]` : ""}`
            }. Use a domain contract${boundary === "browser" ? " or authenticated server function" : " and a feature adapter"}.` +
              (trail.length ? ` Import chain: ${chain.join(" -> ")}.` : ""),
          );
          continue;
        }
        const target = edge.target;
        // Start strips registered server route handlers. Its generated Register
        // config type also refers to startInstance's server middleware in start.ts.
        // Neither registration makes those implementations browser helpers.
        // Authored imports and all other type edges remain checked.
        if (
          boundary === "browser" &&
          file === generatedRouteTree &&
          target &&
          (serverRoute.test(target) || (edge.typeOnly && target === "apps/factory/src/start.ts"))
        )
          continue;
        if (target && graph.has(target) && !paths.has(target)) {
          paths.set(target, chain);
          queue.push(target);
        }
      }
    }
  }
  return {
    violations: [...errors, ...featureViolations(graph), ...cycles(graph)],
    browserModules: [...browserModules].sort(),
    ownedModules: [...graph.keys()].filter((file) => product.test(file)).length,
  };
}

export function architectureViolations(path: string, source: string) {
  return analyzeArchitecture(new Map([[path, source]])).violations;
}

if (import.meta.main) {
  const sources = new Map<string, string>();
  for (const base of ["packages", "apps/factory/src", "scripts"])
    for await (const path of new Bun.Glob("**/*.{ts,tsx,mts,cts,json}").scan(resolve(root, base))) {
      if (/(?:^|\/)(?:node_modules|dist)\//.test(path)) continue;
      const file = `${base}/${path}`;
      sources.set(file, await readFile(resolve(root, file), "utf8"));
    }
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const result = analyzeArchitecture(sources, { compilerOptions: parsed.options });
  for (const error of result.violations) console.error(error);
  console.log(
    `Factory architecture: ${result.ownedModules} owned modules, ${result.violations.length} violations`,
  );
  process.exitCode = result.violations.length ? 1 : 0;
}
