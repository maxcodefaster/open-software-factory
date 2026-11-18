// Runs inside the Factory image as `bun /tmp/image-smoke.ts` from /opt/factory. It proves the
// image carries the code, built assets, kubectl and runtime references the entrypoint needs.
import { statSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const { runtimeArtifactsSchema } = await import(resolve(root, "scripts/factory/artifacts.ts"));
await import(resolve(root, "scripts/factory/readiness.ts"));
await import(resolve(root, "scripts/factory/native-installation.ts"));
await import(resolve(root, "scripts/kubernetes/preflight.ts"));
await import(resolve(root, "apps/factory/src/server/application.ts"));

// Loading every static bootstrap dependency must work in the installed image,
// not just in the checkout. Deliberately omit credentials and installation
// configuration; bootstrap must fail before any filesystem or external action.
const startup = Bun.spawn([process.execPath, "scripts/kubernetes/start.ts"], {
  cwd: root,
  env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const [exit, stdout, stderr] = await Promise.all([
  startup.exited,
  new Response(startup.stdout).text(),
  new Response(startup.stderr).text(),
]);
if (
  exit === 0 ||
  stdout.trim() ||
  !stderr.includes("Configure FACTORY_STATE_DIRECTORY before Kubernetes startup")
)
  throw new Error("Installed Factory bootstrap dependencies or configuration boundary failed");

for (const path of [
  "apps/factory/dist",
  "apps/factory/public",
  "templates",
  "scripts/kubernetes/start.ts",
  "/usr/local/bin/factory-substrate-control",
  "/usr/local/bin/factory-runtime-connector",
]) {
  statSync(resolve(root, path));
}
const bundle = await Bun.file(resolve(root, "runtime-artifacts.json")).json();
if (!(bundle === null && process.env["FACTORY_SMOKE_ARTIFACTS"] === "optional"))
  runtimeArtifactsSchema.parse(bundle);
const kubectl = Bun.spawnSync(["kubectl", "version", "--client"], { stderr: "inherit" });
if (kubectl.exitCode !== 0) throw new Error("kubectl does not start in the Factory image");
const upstream = await Bun.file(resolve(root, "upstream.json")).json();
const sqlite = Bun.spawnSync(
  [
    "factory-sqlite",
    "-init",
    "/dev/null",
    "-batch",
    "-bail",
    ":memory:",
    "SELECT sqlite_version();",
  ],
  {
    stderr: "inherit",
  },
);
if (sqlite.exitCode !== 0 || sqlite.stdout.toString().trim() !== upstream.sqlite.version)
  throw new Error("The pinned static SQLite backup tool does not start in the Factory image");
console.log(JSON.stringify({ factoryImageSmoke: "ok" }));
