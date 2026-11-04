// Runs inside the Factory image as `bun /tmp/image-smoke.ts` from /opt/factory. It proves the
// image carries the code, built assets, kubectl and runtime references the entrypoint needs.
import { statSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const { runtimeArtifactsSchema } = await import(resolve(root, "scripts/factory/artifacts.ts"));
await import(resolve(root, "scripts/factory/readiness.ts"));

for (const path of [
  "apps/factory/dist",
  "apps/factory/public",
  "templates",
  "scripts/kubernetes/start.ts",
]) {
  statSync(resolve(root, path));
}
const bundle = await Bun.file(resolve(root, "runtime-artifacts.json")).json();
if (!(bundle === null && process.env["FACTORY_SMOKE_ARTIFACTS"] === "optional"))
  runtimeArtifactsSchema.parse(bundle);
const kubectl = Bun.spawnSync(["kubectl", "version", "--client"], { stderr: "inherit" });
if (kubectl.exitCode !== 0) throw new Error("kubectl does not start in the Factory image");
console.log(JSON.stringify({ factoryImageSmoke: "ok" }));
