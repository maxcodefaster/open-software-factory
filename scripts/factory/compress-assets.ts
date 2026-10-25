import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";

const directory = resolve(factoryBuildDirectory(), "client");
for await (const path of new Bun.Glob("**/*.{js,css,html,svg,json}").scan(directory)) {
  if (path.split("/").some((part) => part.startsWith("."))) continue;
  const file = resolve(directory, path);
  const source = await readFile(file);
  if (source.byteLength < 1024) continue;
  for (const [suffix, bytes] of [
    [".br", brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })],
    [".gz", gzipSync(source, { level: 9 })],
  ] as const) {
    if (bytes.byteLength < source.byteLength) await writeFile(`${file}${suffix}`, bytes);
  }
}
