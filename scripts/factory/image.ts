import { resolve } from "node:path";
import { publishedRuntimeArtifacts } from "./artifacts";
import { requireAvailableRuntimeArtifacts } from "./artifact-availability";

const root = resolve(import.meta.dir, "../..");
const directory = resolve(process.env["FACTORY_STATE_DIRECTORY"] || resolve(root, ".factory"));
const artifacts = await publishedRuntimeArtifacts(directory);
if (!artifacts)
  throw new Error(
    "Publish the complete runtime artifact set before building a local distribution image",
  );
await requireAvailableRuntimeArtifacts(artifacts);
const child = Bun.spawn(
  [
    "docker",
    "buildx",
    "build",
    "--load",
    "--file",
    "deploy/factory/Dockerfile",
    "--tag",
    process.env["FACTORY_IMAGE"] || "open-software-factory:local",
    "--build-arg",
    `FACTORY_RUNTIME_ARTIFACTS=${JSON.stringify(artifacts)}`,
    ".",
  ],
  { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
