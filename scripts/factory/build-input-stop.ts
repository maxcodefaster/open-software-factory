import { resolve } from "node:path";

export async function buildInputStop(directory: string) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../apps/factory/src/agent/input-stop-worker.ts")],
    outdir: resolve(directory),
    naming: "input-stop.mjs",
    target: "bun",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Native input Stop build failed");
  return resolve(directory, "input-stop.mjs");
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Supply one native input Stop output directory");
  await buildInputStop(process.argv[2] ?? "");
}
