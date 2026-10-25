import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { serverFunctionImports } from "./server-function-manifest";

test("handler imports use exactly their own client discoveries, never another build's manifest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "factory-function-manifest-"));
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  try {
    for (const [directory, module] of [
      [first, "src/server-functions/first.ts"],
      [second, "src/server-functions/second.ts"],
      [resolve(root, "dist"), "src/server-functions/unrelated.ts"],
    ] as const) {
      await mkdir(resolve(directory, "client/.vite"), { recursive: true });
      await writeFile(
        resolve(directory, "client/.vite/solid-server-functions.json"),
        JSON.stringify({
          modules: [module],
          functions: [],
        }),
      );
    }
    expect(await serverFunctionImports(root, first)).toBe(
      `import ${JSON.stringify(resolve(root, "src/server-functions/first.ts"))};`,
    );
    expect(await serverFunctionImports(root, second)).toBe(
      `import ${JSON.stringify(resolve(root, "src/server-functions/second.ts"))};`,
    );
    await rm(first, { recursive: true });
    await expect(serverFunctionImports(root, first)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
