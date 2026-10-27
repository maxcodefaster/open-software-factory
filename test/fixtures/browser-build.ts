import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  productionBuildEnvironment,
  verificationEnvironment,
} from "../../scripts/testing/test-prerequisites";

type Environment = Record<string, string | undefined>;
type Build = (environment: Environment) => Promise<void>;
const root = resolve(import.meta.dirname, "../..");

async function buildFactory(environment: Environment) {
  await new Promise<void>((complete, fail) => {
    const child = spawn("mise", ["exec", "--", "bun", "--no-env-file", "run", "factory:build"], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? complete() : fail(new Error("Owned browser application build failed")),
    );
  });
}

async function requireBuild(directory: string) {
  await access(resolve(directory, "server/entry.js"));
  await access(resolve(directory, "client/assets"));
}

export async function prepareBrowserBuild(environment: Environment, build: Build = buildFactory) {
  const inherited = environment["FACTORY_BUILD_DIRECTORY"];
  if (inherited) {
    await requireBuild(inherited);
    return async () => {};
  }
  const parent = resolve(root, ".factory/test-results/application-builds");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "browser-ui-"));
  environment["FACTORY_BUILD_DIRECTORY"] = directory;
  const dispose = async () => {
    if (environment["FACTORY_BUILD_DIRECTORY"] === directory)
      delete environment["FACTORY_BUILD_DIRECTORY"];
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await build(productionBuildEnvironment(verificationEnvironment(environment)));
    await requireBuild(directory);
    return dispose;
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

export default async function setup() {
  return prepareBrowserBuild(process.env);
}
