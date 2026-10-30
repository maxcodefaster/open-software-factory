import { resolve } from "node:path";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";

const result = await Bun.build({
  entrypoints: [
    resolve(import.meta.dirname, "../../apps/factory/src/agent/retained-stop-runner.ts"),
  ],
  outdir: factoryBuildDirectory(),
  naming: "retained-stop-runner.mjs",
  target: "bun",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Retained Stop runner build failed");
if (result.outputs.length !== 1)
  throw new Error("Retained Stop runner must have one self-contained native entry");
