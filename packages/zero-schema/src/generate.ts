import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const output = resolve(import.meta.dir, "schema.generated.ts");
const temporary = resolve(import.meta.dir, `.schema-${crypto.randomUUID()}.ts`);

async function command(args: string[]) {
  const process = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "inherit" });
  const result = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(`Zero generation failed: ${args.join(" ")}`);
  return result;
}

// Use the public generator CLI. Only its checked-in output is imported at runtime.
try {
  await command([
    "node",
    resolve(root, "node_modules/.bin/drizzle-zero"),
    "generate",
    "--config",
    "packages/zero-schema/src/projection.ts",
    "--output",
    temporary,
    "--skip-types",
    "--skip-builder",
    "--skip-declare",
  ]);
  await command([resolve(root, "node_modules/.bin/biome"), "format", "--write", temporary]);
  const source = await readFile(temporary, "utf8");
  if (process.argv.includes("--check")) {
    if ((await readFile(output, "utf8")) !== source)
      throw new Error("Zero schema differs from Drizzle projection; run bun run zero:generate");
  } else {
    await writeFile(output, source);
  }
} finally {
  await rm(temporary, { force: true });
}
