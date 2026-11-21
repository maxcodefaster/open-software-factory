import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../../scripts/owned-client-process";
import {
  productionBuildEnvironment,
  verificationEnvironment,
} from "../../scripts/testing/test-prerequisites";

type Environment = Record<string, string | undefined>;
type Build = (environment: Environment, signal?: AbortSignal) => Promise<void>;
const root = resolve(import.meta.dirname, "../..");

async function buildFactory(environment: Environment, signal?: AbortSignal) {
  await runProcess(["mise", "exec", "--", "bun", "--no-env-file", "run", "factory:build"], {
    cwd: root,
    env: environment,
    output: "inherit",
    signal,
  });
}

async function requireBuild(directory: string) {
  await access(resolve(directory, "server/entry.js"));
  await access(resolve(directory, "client/assets"));
}

export async function prepareBrowserBuild(
  environment: Environment,
  build: Build = buildFactory,
  signal?: AbortSignal,
  ownedDirectory?: string,
) {
  signal?.throwIfAborted();
  const inherited = environment["FACTORY_BUILD_DIRECTORY"];
  if (inherited) {
    await requireBuild(inherited);
    signal?.throwIfAborted();
    return async () => {};
  }
  const parent = resolve(root, ".factory/test-results/application-builds");
  await mkdir(parent, { recursive: true });
  signal?.throwIfAborted();
  const directory = ownedDirectory
    ? await mkdir(ownedDirectory).then(() => ownedDirectory)
    : await mkdtemp(resolve(parent, "browser-ui-"));
  environment["FACTORY_BUILD_DIRECTORY"] = directory;
  const dispose = async () => {
    if (environment["FACTORY_BUILD_DIRECTORY"] === directory)
      delete environment["FACTORY_BUILD_DIRECTORY"];
    await rm(directory, { recursive: true, force: true });
  };
  try {
    signal?.throwIfAborted();
    await build(productionBuildEnvironment(verificationEnvironment(environment)), signal);
    signal?.throwIfAborted();
    await requireBuild(directory);
    signal?.throwIfAborted();
    return dispose;
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

export default async function setup() {
  return prepareBrowserBuild(process.env);
}
