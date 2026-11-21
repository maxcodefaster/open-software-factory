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
  /** Dependencies used only by JSX or callbacks outside this case. Access fails explicitly. */
  stubs?: string[];
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  timers?: {
    setTimeout: (callback: () => void, milliseconds?: number) => number;
    clearTimeout: (id: number | undefined) => void;
  };
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
        (context) => (file) => {
          const transformed = ts.visitEachChild(
            file,
            (node) => {
              if (!ts.isFunctionDeclaration(node) || node.name?.text !== options.component)
                return node;
              if (!node.body) return node;
              return ts.factory.updateFunctionDeclaration(
                node,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                node.parameters,
                node.type,
                ts.factory.updateBlock(
                  node.body,
                  node.body.statements.map((statement) => {
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
                ),
              );
            },
            context,
          );
          // Bind private components too. Adding an export modifier after TypeScript's
          // module analysis does not reliably emit a CommonJS export for them.
          return ts.factory.updateSourceFile(transformed, [
            ...transformed.statements,
            ts.factory.createExpressionStatement(
              ts.factory.createAssignment(
                ts.factory.createElementAccessExpression(
                  ts.factory.createIdentifier("exports"),
                  ts.factory.createStringLiteral(options.component),
                ),
                ts.factory.createIdentifier(options.component),
              ),
            ),
          ]);
        },
      ],
    },
  });
  if (!replaced) throw new Error(`Missing component return in ${options.path}`);
  const exports: Record<string, (props: unknown) => T> = {};
  const require = (name: string) => {
    if (Object.hasOwn(options.imports, name)) return options.imports[name];
    if (options.stubs?.includes(name))
      return new Proxy(
        {},
        {
          get(_, property) {
            throw new Error(
              `Stubbed editor dependency ${name}.${String(property)} in ${options.path}`,
            );
          },
        },
      );
    throw new Error(`Unspecified editor dependency ${name} in ${options.path}`);
  };
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
    options.timers?.setTimeout ?? (() => 0),
    options.timers?.clearTimeout ?? (() => {}),
  );
  const component = exports[options.component];
  if (!component) throw new Error(`Missing component ${options.component}`);
  return component;
}
