import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";

test("serialized browser callbacks keep their fixture guards in the browser's own scope", async () => {
  const methods = new Set([
    "evaluate",
    "evaluateAll",
    "evaluateHandle",
    "addInitScript",
    "waitForFunction",
    "$eval",
    "$$eval",
  ]);
  const unbound: string[] = [];
  function usesGuard(node: ts.Node): boolean {
    return (
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "fixtureValue") ||
      Boolean(ts.forEachChild(node, (child) => usesGuard(child) || undefined))
    );
  }
  for await (const path of new Bun.Glob("**/*.{spec,test}.ts").scan(resolve("test"))) {
    const text = await Bun.file(resolve("test", path)).text();
    if (!text.includes("fixtureValue(")) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        methods.has(node.expression.name.text)
      )
        for (const argument of node.arguments) {
          if (
            !(ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ||
            !usesGuard(argument)
          )
            continue;
          const localGuard =
            ts.isBlock(argument.body) &&
            argument.body.statements.some(
              (statement) =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === "fixtureValue",
            );
          if (!localGuard)
            unbound.push(
              `${path}:${source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1}`,
            );
        }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(unbound).toEqual([]);
});
