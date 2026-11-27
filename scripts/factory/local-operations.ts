// Local Factory `status` and disposable `reset` subcommands.
import { lstat, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "#db/client";
import { localRuntimeDefaults, publishedRuntimeArtifacts } from "./artifacts";
import { composeProject } from "./installation";
import { type LocalFactoryContext, validateComposeOwnership } from "./local-context";
import { stopServer } from "./local-server";
import { localOpenBao } from "./openbao";
import { resetDisposable } from "./reset";
import { readResetResources, requireResetResourcesAbsent } from "./reset-resources";
import { disposeRuntimeStorageCheck } from "./storage-readiness";

export async function runStatus(ctx: LocalFactoryContext) {
  const response = await fetch(`${ctx.factoryBaseURL}/health/ready`, {
    signal: AbortSignal.timeout(1_000),
  }).catch(() => null);
  const runtimeImage =
    localRuntimeDefaults(
      await publishedRuntimeArtifacts(ctx.sharedStateDirectory),
      ctx.installation,
    ).runtimeImage ?? "not published";
  console.log(`server: ${response?.ok ? "ready" : "stopped"}`);
  console.log(`runtime host: ${runtimeImage.trim()}`);
  await ctx.command([...ctx.composeArguments, "ps"]);
}

export async function runReset(ctx: LocalFactoryContext) {
  const {
    installation,
    confirmation,
    resetData,
    stateDirectory,
    composeArguments,
    command,
    kubectl,
  } = ctx;
  let resetResources = installation?.resetResources;

  const validateResetRuntimes = async () => {
    if (!installation) throw new Error("Disposable installation required");
    const containers = (
      await command(["docker", "ps", "--all", "--format", "{{.Names}}"], { quiet: true })
    ).split("\n");
    if (containers.includes(`${composeProject(installation)}-postgres-1`)) {
      const database = createDatabase(1);
      try {
        resetResources = await readResetResources(database);
      } finally {
        await database.client.end();
      }
    } else if (installation.phase === "active") {
      throw new Error(
        "Reset cannot confirm product ownership without its disposable database or a persisted reset intent",
      );
    }
    if (!resetResources)
      throw new Error("Reset cannot confirm native resources without its saved exact inventory");
    await requireResetResourcesAbsent(resetResources, async (kind, name, namespace) => {
      const existing = await kubectl(
        [
          "get",
          kind,
          name,
          ...(namespace ? ["-n", namespace] : []),
          "--ignore-not-found",
          "-o",
          "name",
        ],
        undefined,
        true,
      );
      return Boolean(existing);
    });
  };

  const saveInstallationPhase = async (phase: "reset-intent" | "reset") => {
    if (!installation) throw new Error("Disposable installation required");
    await writeFile(
      resolve(stateDirectory, "installation.next.json"),
      `${JSON.stringify({ ...installation, phase, resetResources })}\n`,
      { mode: 0o600 },
    );
    await rename(
      resolve(stateDirectory, "installation.next.json"),
      resolve(stateDirectory, "installation.json"),
    );
  };

  if (installation?.phase === "reset") {
    await validateComposeOwnership(ctx, true);
    await validateResetRuntimes();
    console.log("Disposable reset was already confirmed; no deletion was repeated");
    return;
  }
  await resetDisposable({
    installation,
    confirmation,
    data: resetData,
    validate: async () => {
      if (!installation) throw new Error("Disposable installation required");
      await validateComposeOwnership(ctx);
      await validateResetRuntimes();
    },
    persistIntent: () => saveInstallationPhase("reset-intent"),
    stop: () => stopServer(ctx),
    remove: async () => {
      await validateComposeOwnership(ctx);
      await validateResetRuntimes();
      await saveInstallationPhase("reset-intent");
      await disposeRuntimeStorageCheck(stateDirectory);
      await command([...composeArguments, "down", "--volumes"], { quiet: true });
      if (await lstat(resolve(stateDirectory, "openbao/identity.json")).catch(() => undefined)) {
        await (await localOpenBao(stateDirectory)).dispose();
      }
      await validateComposeOwnership(ctx, true);
    },
    persistOutcome: () => saveInstallationPhase("reset"),
  });
  console.log(
    `Removed disposable installation ${installation?.name} containers and data volumes. Data deletion is not recoverable; local identity/diagnostics were retained. The developer installation and shared registry were untouched.`,
  );
}
