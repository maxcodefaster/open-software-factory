// Local Factory server container/process lifecycle and planning cache helpers.
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeArtifacts } from "./artifacts";
import { type LocalFactoryContext, localSecret } from "./local-context";
import { wireLocalForgeIdentity } from "./local-forge";
import { localOpenBao } from "./openbao";
import { waitForFactory } from "./readiness";
import {
  factoryServerComposeOverlay,
  prepareFactoryServerContainer,
  requireFactoryServerImage,
  requireFactoryServerRuntimeHost,
  retainedFactoryServerContainer,
  stopFactoryServerContainer,
} from "./server-container";
import { type localForgeIdentityEndpoints, localServerSettings } from "./server-settings";

export async function stopServer(ctx: LocalFactoryContext) {
  const { stateDirectory, installation, paths } = ctx;
  if (await stopFactoryServerContainer(stateDirectory)) {
    await rm(paths.serverPIDFile, { force: true });
    return;
  }
  const pid = Number((await readFile(paths.serverPIDFile, "utf8").catch(() => "")).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const child = Bun.spawn(["ps", "eww", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const commandLine = await new Response(child.stdout).text();
  await child.exited;
  if (installation && commandLine) {
    const identity = JSON.parse(await readFile(paths.serverIdentityFile, "utf8")) as {
      pid: number;
      startupID: string;
    };
    if (
      identity.pid !== pid ||
      !/^[a-f0-9-]{36}$/.test(identity.startupID) ||
      !commandLine.includes(`FACTORY_STARTUP_ID=${identity.startupID}`)
    )
      throw new Error(
        "Refusing to stop a process without the installation's exact startup identity",
      );
  }
  if (!commandLine.includes("apps/factory/src/server.ts")) {
    await rm(paths.serverPIDFile, { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      await rm(paths.serverPIDFile, { force: true });
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("Existing Factory server did not stop");
}

export async function selectServerImage(ctx: LocalFactoryContext) {
  const retained = await retainedFactoryServerContainer(ctx.stateDirectory);
  const reference = process.env["FACTORY_SERVER_IMAGE"] ?? retained?.image;
  if (!reference || reference === "native") return;
  const runtimeHost = requireFactoryServerRuntimeHost(
    process.env["FACTORY_RUNTIME_HOST"] ?? retained?.runtimeHost,
  );
  ctx.serverImage = await requireFactoryServerImage(reference);
  process.env["FACTORY_RUNTIME_HOST"] = runtimeHost;
  const networkFile = resolve(ctx.stateDirectory, "linux-server.compose.json");
  await writeFile(
    networkFile,
    JSON.stringify(factoryServerComposeOverlay(runtimeHost, ctx.ports.forgejo)),
    { mode: 0o600 },
  );
  ctx.composeArguments.push("-f", networkFile);
}

export async function startServer(
  ctx: LocalFactoryContext,
  forgejoToken: string | undefined,
  artifacts: RuntimeArtifacts,
  forgeIdentity: ReturnType<typeof localForgeIdentityEndpoints>,
  artifactEnv: (artifacts: RuntimeArtifacts) => Record<string, string>,
  forgeAdminToken: () => Promise<string>,
) {
  const {
    root,
    installation,
    stateDirectory,
    sharedStateDirectory,
    namespace,
    ports,
    factoryBaseURL,
    forgejoBaseURL,
    paths,
    serverImage,
  } = ctx;
  const settings = localServerSettings(
    installation ? { FACTORY_HOST: process.env["FACTORY_HOST"] } : process.env,
    {
      email: installation ? `admin-${installation.name}@factory.local` : "admin@factory.local",
      password: await localSecret(resolve(stateDirectory, "admin-password")),
    },
  );
  const authSecret = await localSecret(paths.authSecretFile);
  const startupID = crypto.randomUUID();
  await writeFile(paths.serverLogFile, "", { mode: 0o600 });
  await chmod(paths.serverLogFile, 0o600);
  const environment = {
    ...process.env,
    FACTORY_STATE_DIRECTORY: stateDirectory,
    ...artifactEnv(artifacts),
    FACTORY_REGISTRY_CA_NAMESPACE: namespace,
    FACTORY_REGISTRY_CA_SECRET: "registry-tls",
    ...(process.env["FACTORY_OPENBAO_URL"]
      ? {}
      : await (await localOpenBao(stateDirectory)).start()),
    FACTORY_HOST: settings.host,
    FACTORY_PORT: String(ports.factory),
    FACTORY_BASE_URL: factoryBaseURL,
    FACTORY_WIKI_WEBHOOK_URL:
      process.env["FACTORY_WIKI_WEBHOOK_URL"] ??
      `http://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${ports.factory}`,
    FACTORY_WIKI_WEBHOOK_SECRET: await localSecret(resolve(stateDirectory, "wiki-webhook-secret")),
    FACTORY_AUTH_SECRET: authSecret,
    FACTORY_AUTH_COOKIE_PREFIX: installation ? `factory-${installation.name}` : "factory",
    FACTORY_ADMIN_EMAIL: settings.email,
    FACTORY_ADMIN_PASSWORD: settings.password,
    FACTORY_FORGEJO_API_URL: `${forgejoBaseURL}/api/v1/`,
    FACTORY_FORGEJO_TOKEN: forgejoToken ?? (await readFile(paths.forgejoTokenFile, "utf8")).trim(),
    FACTORY_FORGEJO_OWNER: "factory-mutation",
    FACTORY_FORGEJO_ADMIN_TOKEN: await forgeAdminToken(),
    FACTORY_FORGE_ISSUER_HOST: forgeIdentity.host,
    FACTORY_FORGE_ISSUER_URL: forgeIdentity.issuer,
    FACTORY_FORGE_DISCOVERY_URL: forgeIdentity.discovery,
    FACTORY_ZERO_CACHE_URL: `http://127.0.0.1:${ports.zero}`,
    FACTORY_STARTUP_ID: startupID,
  };
  const container = serverImage
    ? await prepareFactoryServerContainer({
        stateDirectory,
        sharedStateDirectory,
        image: serverImage,
        startupID,
        environment,
      })
    : undefined;
  const server = Bun.spawn(container?.command ?? ["bun", "apps/factory/src/server.ts"], {
    cwd: root,
    env: environment,
    stdin: "ignore",
    stdout: Bun.file(paths.serverLogFile),
    stderr: Bun.file(paths.serverLogFile),
    detached: true,
  });
  server.unref();
  await writeFile(paths.serverPIDFile, `${server.pid}\n`);
  await writeFile(paths.serverIdentityFile, JSON.stringify({ pid: server.pid, startupID }), {
    mode: 0o600,
  });
  try {
    await waitForFactory({ server, baseURL: factoryBaseURL, startupID });
    await container?.confirm();
    await wireLocalForgeIdentity(ctx, { settings, authSecret, forgeIdentity });
  } catch (cause) {
    if (server.exitCode === null) server.kill();
    await server.exited;
    if (container) await stopFactoryServerContainer(stateDirectory);
    await rm(paths.serverPIDFile, { force: true });
    throw new Error(
      `${cause instanceof Error ? cause.message : "Factory startup failed"}. Inspect the protected local log at ${paths.serverLogFile}`,
    );
  }
}

export async function startPlanningCache(ctx: LocalFactoryContext) {
  await ctx.command([...ctx.composeArguments, "up", "-d", "--wait", "zero-cache"], {
    quiet: Boolean(ctx.installation),
  });
}

export function announceReady(ctx: LocalFactoryContext) {
  console.log(`Factory is ready at ${ctx.factoryBaseURL}`);
  if (!process.env["FACTORY_ADMIN_PASSWORD"])
    console.log(
      `The generated administrator password is in ${resolve(ctx.stateDirectory, "admin-password")}. Set FACTORY_ADMIN_PASSWORD before first startup to choose your own; this never resets an existing password.`,
    );
}
