import { mkdir, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { projectImportOrigins } from "#project-domain/setup";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import { requireAvailableRuntimeArtifacts } from "./artifact-availability";
import {
  publishedRuntimeArtifacts,
  type RuntimeArtifacts,
  runtimeArtifactEnvironment,
} from "./artifacts";
import { prepareForgejoFixture, requireForgeFixtureInstallation } from "./forge-fixture";
import {
  configuredRuntimeArtifacts,
  configureInstallation,
  createLocalContext,
  parseFactoryArgs,
  validateComposeOwnership,
} from "./local-context";
import {
  configuredForgeIdentity,
  ensureForgeAdministrator as ensureLocalForgeAdministrator,
  ensureForgejo as ensureLocalForgejo,
} from "./local-forge";
import { runReset, runStatus } from "./local-operations";
import { ensureRegistry, preflight, publishRuntimeHost, runPublishRuntime } from "./local-registry";
import {
  announceReady,
  selectServerImage,
  startPlanningCache,
  startServer,
  stopServer,
} from "./local-server";
import { requireNativeInstallation, requireNativeStarterImages } from "./native-installation";
import { completeFactoryStartup } from "./readiness";
import { requireWritableRuntimeStorage } from "./storage-readiness";

const root = resolve(import.meta.dir, "../..");
Object.assign(process.env, {
  FACTORY_POSTGRES_IMAGE: imagePins.postgres,
  FACTORY_FORGEJO_IMAGE: imagePins.forgejo,
  FACTORY_ZERO_IMAGE: imagePins.zero,
});
process.env["FACTORY_FORGEJO_IMPORT_DOMAINS"] =
  projectImportOrigins(process.env["FACTORY_GIT_IMPORT_ORIGINS"])
    .map((origin) => new URL(origin).hostname)
    .join(",") || "imports-disabled.invalid";

const parsed = parseFactoryArgs(process.argv.slice(2));
const ctx = await createLocalContext(root, parsed);
const { action, installation, confirmation, stateDirectory, sharedStateDirectory } = ctx;

async function ensureForgejo() {
  const token = await ensureLocalForgejo(ctx);
  return token;
}

async function prepareFixture() {
  requireForgeFixtureInstallation(installation, confirmation);
  const artifacts = await configuredRuntimeArtifacts(sharedStateDirectory);
  const starterImages = requireNativeStarterImages({
    ...nativeArtifactEnvironment(artifacts),
    ...process.env,
  });
  await validateComposeOwnership(ctx);
  await prepareForgejoFixture({
    root,
    installation,
    confirmation,
    token: (await readFile(ctx.paths.forgejoTokenFile, "utf8")).trim(),
    platform: starterImages.platform,
    starterImages,
    command: ctx.command,
  });
  console.log(`Prepared the runtime test fixture in disposable installation ${installation?.name}`);
}

async function ensureForgeAdministrator() {
  return ensureLocalForgeAdministrator(ctx);
}

function nativeArtifactEnvironment(artifacts: RuntimeArtifacts) {
  const environment = runtimeArtifactEnvironment(
    artifacts,
    nativeRuntimeArchitecture(requireNativeInstallation().runtime),
  );
  if (process.env["FACTORY_STARTER_IMAGES"])
    environment.FACTORY_STARTER_IMAGES = JSON.stringify(requireNativeStarterImages());
  return environment;
}

async function up() {
  await preflight(ctx);
  const published = await publishedRuntimeArtifacts(sharedStateDirectory);
  if (!installation && !published) await ensureRegistry(ctx);
  if (!published) await publishRuntimeHost(ctx);
  const artifacts = await configuredRuntimeArtifacts(sharedStateDirectory);
  await requireAvailableRuntimeArtifacts(artifacts);
  await selectServerImage(ctx);
  await completeFactoryStartup({
    checkStorageReady: () =>
      requireWritableRuntimeStorage({
        stateDirectory,
        image: artifacts["runtime-host"],
      }),
    startDependencies: startDataServices,
    startServer: async () => {
      await ctx.command(["bun", "run", "db:migrate"], { quiet: true });
      const forgejoToken = await ensureForgejo();
      const forgeIdentity = await configuredForgeIdentity(ctx.ports.factory);
      await ctx.command(["bun", "run", "factory:build"], {
        quiet: Boolean(installation),
        env: { NODE_ENV: "production" },
      });
      await stopServer(ctx);
      await startServer(
        ctx,
        forgejoToken,
        artifacts,
        forgeIdentity,
        nativeArtifactEnvironment,
        ensureForgeAdministrator,
      );
    },
    startPlanningCache: () => startPlanningCache(ctx),
    ready: () => announceReady(ctx),
  });
  if (installation)
    console.log(
      `Disposable installation ${installation.name}; credentials are in its protected local state directory`,
    );
}

async function startDataServices() {
  await ctx.command([...ctx.composeArguments, "up", "-d", "--wait", "postgres", "forgejo"], {
    quiet: Boolean(installation),
  });
}

async function restart() {
  await preflight(ctx);
  const artifacts = await configuredRuntimeArtifacts(sharedStateDirectory);
  await requireAvailableRuntimeArtifacts(artifacts);
  await selectServerImage(ctx);
  await completeFactoryStartup({
    checkStorageReady: () =>
      requireWritableRuntimeStorage({
        stateDirectory,
        image: artifacts["runtime-host"],
      }),
    startDependencies: startDataServices,
    startServer: async () => {
      await ctx.command(["bun", "run", "db:migrate"], { quiet: true });
      const forgeIdentity = await configuredForgeIdentity(ctx.ports.factory);
      await stopServer(ctx);
      await startServer(
        ctx,
        undefined,
        artifacts,
        forgeIdentity,
        nativeArtifactEnvironment,
        ensureForgeAdministrator,
      );
    },
    startPlanningCache: () => startPlanningCache(ctx),
    ready: () => announceReady(ctx),
  });
}

await mkdir(stateDirectory, { recursive: true });
const lockFile = resolve(stateDirectory, "operation.lock");
const lock = await open(lockFile, "wx", 0o600).catch(() => {
  throw new Error(
    "Another Factory operation owns this installation; inspect its operation.lock before retrying",
  );
});
try {
  await lock.writeFile(String(process.pid));
  if (action !== "prepare-fixture") await configureInstallation(ctx);
  if (action === "up") await up();
  else if (action === "publish-runtime") await runPublishRuntime(ctx);
  else if (action === "restart") await restart();
  else if (action === "status") await runStatus(ctx);
  else if (action === "reset") await runReset(ctx);
  else if (action === "prepare-fixture") await prepareFixture();
} finally {
  await lock.close();
  await rm(lockFile, { force: true });
}
