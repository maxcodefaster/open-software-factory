import { expect, test } from "bun:test";

test("the attachment store does not load conversion engines in the Factory process", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./store.ts", import.meta.url).pathname],
    target: "bun",
    packages: "external",
  });
  expect(result.success).toBe(true);
  const output = result.outputs[0];
  if (!output) throw new Error("Attachment bundle was not emitted");
  const code = await output.text();
  const dependencies = new Bun.Transpiler({ loader: "js" }).scanImports(code);
  expect(
    dependencies.filter(({ path }) =>
      ["@napi-rs/canvas", "mammoth", "turndown", "pdfjs-dist"].some(
        (name) => path === name || path.startsWith(`${name}/`),
      ),
    ),
  ).toEqual([]);
});
