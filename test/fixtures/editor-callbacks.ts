import { readFileSync } from "node:fs";
import ts from "typescript";

// Node resolves Solid's SSR entry, whose effects are no-ops. These callbacks own
// client drafts, so exercise the pinned client runtime even in the unit lane.
export const editorSolid = (await import(
  new URL("./dist/solid.js", import.meta.resolve("solid-js/package.json")).href
)) as typeof import("solid-js");

/** Run component setup and its real callbacks without rendering JSX or starting a server. */
export function editorCallbacks<T>(options: {
  path: string;
  source?: string;
  component: string;
  expose: string[];
  imports: Record<string, unknown>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): (props: unknown) => T {
  const source = options.source ?? readFileSync(options.path, "utf8");
  let replaced = false;
  const compiled = ts.transpileModule(source, {
    fileName: options.path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
    transformers: {
      before: [
        (context) => (file) =>
          ts.visitEachChild(
            file,
            (node) => {
              if (!ts.isFunctionDeclaration(node) || node.name?.text !== options.component)
                return node;
              return ts.visitEachChild(
                node,
                (child) => {
                  if (!ts.isBlock(child)) return child;
                  return ts.factory.updateBlock(
                    child,
                    child.statements.map((statement) => {
                      if (!ts.isReturnStatement(statement)) return statement;
                      replaced = true;
                      return ts.factory.createReturnStatement(
                        ts.factory.createObjectLiteralExpression(
                          options.expose.map((name) =>
                            ts.factory.createShorthandPropertyAssignment(name),
                          ),
                        ),
                      );
                    }),
                  );
                },
                context,
              );
            },
            context,
          ),
      ],
    },
  });
  if (!replaced) throw new Error(`Missing component return in ${options.path}`);
  const exports: Record<string, (props: unknown) => T> = {};
  const require = (name: string) => options.imports[name] ?? {};
  new Function(
    "require",
    "exports",
    "localStorage",
    "setTimeout",
    "clearTimeout",
    compiled.outputText,
  )(
    require,
    exports,
    options.storage,
    () => 0,
    () => {},
  );
  const component = exports[options.component];
  if (!component) throw new Error(`Missing component ${options.component}`);
  return component;
}
