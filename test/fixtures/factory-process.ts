import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../../packages/db/src/client";
import { runEnvironmentCommand } from "../../packages/runtime-kubernetes/src/command";
import {
  kubernetesCommand,
  kubernetesConnectionEnvironment,
} from "../../packages/runtime-kubernetes/src/config";
import {
  readResetResources,
  requireResetResourcesAbsent,
} from "../../scripts/factory/reset-resources";
import { ownedContainerCallback } from "./container-callback";
import { nativeLiveConfiguration, saveNativeLiveConfiguration } from "./native-live-configuration";
import { ownedPlanningCache } from "./planning-cache";
import { ownedTestDatabase } from "./postgres-server";
import { fixtureRuntime } from "./substrate";

export const ownedFactorySigningSecret = "owned-process-auth-secret-not-a-production-credential";

export function factoryProcessCommand(entrypoint: string, args: string[] = []) {
  // Owned proofs pass their complete environment explicitly. Loading the
  // repository's .env here would reintroduce live models and credentials.
  return [process.execPath, "--no-env-file", entrypoint, ...args];
}

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Owned Factory database ${args[0]} failed: ${error}`);
  return output.trim();
}

export async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  message: string,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

// Separate database and listener. Never restart the user's Factory or recover its runtimes.
export async function factoryProcess(
  liveRuntime?: { runtimeHostImage: string; forgejoToken: string },
  modelOverrides?: {
    FACTORY_MODEL_IDS?: string;
    FACTORY_PROJECT_AGENT_MODEL?: string;
    FACTORY_AGENT_MODEL_ID?: string;
    FACTORY_MODEL_BASE_URL?: string;
    FACTORY_MODEL_API_KEY?: string;
    FACTORY_PLANNING_MODEL_BASE_URL?: string;
    FACTORY_PLANNING_MODEL_API_KEY?: string;
    FACTORY_BROWSER_TOOLS_IMAGE?: string;
    FACTORY_DEVELOPER_IDE_IMAGE?: string;
    FACTORY_EXECUTION_IDLE_MINUTES?: string;
    FACTORY_OPENBAO_URL?: string;
    FACTORY_OPENBAO_TOKEN_FILE?: string;
    FACTORY_OPENBAO_CA_FILE?: string;
    FACTORY_FORGEJO_API_URL?: string;
    FACTORY_FORGEJO_PUBLIC_URL?: string;
    FACTORY_FORGEJO_OWNER?: string;
    FACTORY_FORGEJO_ADMIN_TOKEN?: string;
    FACTORY_FORGE_ISSUER_URL?: string;
    FACTORY_FORGE_ISSUER_HOST?: string;
    FACTORY_FORGE_DISCOVERY_URL?: string;
    FACTORY_HOST?: string;
    FACTORY_GIT_IMPORT_ORIGINS?: string;
    FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION?: string;
  },
  retained?: { id: string; base: string },
) {
  if (
    retained &&
    (!/^[a-f0-9-]{36}$/.test(retained.id) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(retained.base))
  )
    throw new Error("Invalid retained owned Factory identity");
  const id = retained?.id ?? crypto.randomUUID();
  const nativeFile = modelOverrides?.FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION;
  let commissionedNative: ReturnType<typeof nativeLiveConfiguration> | undefined;
  if (liveRuntime) {
    if (!nativeFile)
      throw Error(
        "Live Factory proof requires its explicit owned Substrate installation configuration",
      );
    commissionedNative = nativeLiveConfiguration(
      await Bun.file(nativeFile).json(),
      `owned_${id.replaceAll("-", "")}`,
      modelOverrides ?? {},
    );
  }
  const publishedRuntimeImages = liveRuntime
    ? Object.fromEntries(
        await Promise.all(
          [
            ["FACTORY_BROWSER_TOOLS_IMAGE", "browser-tools"],
            ["FACTORY_DEVELOPER_IDE_IMAGE", "developer-ide"],
          ].map(async ([key, name]) => [
            key,
            (await readFile(`.factory/${name}-image`, "utf8")).trim(),
          ]),
        ),
      )
    : {};
  const container = `factory-owned-commit-process-${id}`;
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  let created = false;
  let shared: Awaited<ReturnType<typeof ownedTestDatabase>> | undefined;
  let planningCache: Awaited<ReturnType<typeof ownedPlanningCache>> | undefined;
  let callback: Awaited<ReturnType<typeof ownedContainerCallback>> | undefined;
  let ownedDatabaseURL: string | undefined;
  let migrated = false;
  async function shutdown() {
    for (const child of processes) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  }
  async function dispose() {
    await shutdown();
    await planningCache?.dispose();
    planningCache = undefined;
    await callback?.dispose();
    callback = undefined;
    if (commissionedNative && ownedDatabaseURL && migrated) {
      const previousURL = process.env["DATABASE_URL"];
      process.env["DATABASE_URL"] = ownedDatabaseURL;
      const database = createDatabase(1);
      if (previousURL === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previousURL;
      try {
        await requireResetResourcesAbsent(
          await readResetResources(database),
          async (kind, name, namespace) => {
            const result = await runEnvironmentCommand(
              kubernetesCommand([
                "get",
                kind,
                name,
                ...(namespace ? ["-n", namespace] : []),
                "--ignore-not-found",
                "-o",
                "json",
              ]),
              kubernetesConnectionEnvironment(),
              { timeoutMS: 15_000, outputBytes: 1024 * 1024 },
            );
            if (result.exitCode !== 0)
              throw Error(
                "Native fixture cleanup inventory is unavailable; owned database retained",
              );
            return !!result.stdout.trim();
          },
        );
      } finally {
        await database.client.end({ timeout: 1 });
      }
    }
    if (shared) {
      await shared.dispose();
      shared = undefined;
      return;
    }
    if (!created) return;
    const owner = await docker(
      "inspect",
      "--format",
      '{{index .Config.Labels "factory.owned-commit-process"}}',
      container,
    );
    if (owner !== id) throw new Error("Owned Factory database cleanup refused");
    await docker("rm", "--force", container);
    created = false;
  }
  try {
    const sharedIdentity = process.env["FACTORY_TEST_POSTGRES"];
    if (sharedIdentity) {
      shared = await ownedTestDatabase(JSON.parse(sharedIdentity), id, Boolean(retained));
    } else if (retained) {
      const owner = await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-commit-process"}}',
        container,
      );
      if (owner !== id) throw new Error("Retained Factory database ownership differs");
    } else
      await docker(
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        `factory.owned-commit-process=${id}`,
        "--env",
        "POSTGRES_USER=factory",
        "--env",
        "POSTGRES_PASSWORD=owned-process-not-a-secret",
        "--env",
        `POSTGRES_DB=owned_${id.replaceAll("-", "")}`,
        "--tmpfs",
        "/var/lib/postgresql/data",
        "--publish",
        "127.0.0.1::5432",
        "docker.io/library/postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8",
        "postgres",
        "-c",
        "wal_level=logical",
      );
    created = !shared;
    const databasePort = shared
      ? ""
      : (await docker("port", container, "5432/tcp")).split(":").at(-1);
    if (!shared && (!databasePort || !/^\d+$/.test(databasePort)))
      throw new Error("Owned database port missing");
    const databaseURL =
      shared?.url ??
      `postgresql://factory:owned-process-not-a-secret@127.0.0.1:${databasePort}/owned_${id.replaceAll("-", "")}`;
    ownedDatabaseURL = databaseURL;
    const migration = shared
      ? undefined
      : Bun.spawn([process.execPath, "packages/db/src/migrate.ts"], {
          env: { ...process.env, DATABASE_URL: databaseURL },
          stdout: "ignore",
          stderr: "pipe",
        });
    const [error, status] = await Promise.all([
      migration ? new Response(migration.stderr).text() : "",
      migration?.exited ?? 0,
    ]);
    if (status !== 0) throw new Error(`Owned migration failed: ${error}`);
    migrated = true;
    const reservation = retained
      ? undefined
      : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = retained ? Number(new URL(retained.base).port) : reservation?.port;
    if (!port) throw new Error("Owned Factory listener port missing");
    await reservation?.stop(true);
    const base = `http://127.0.0.1:${port}`;
    let nativeConfiguration = modelOverrides?.FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION;
    if (commissionedNative) {
      const directory = resolve(".factory/test-results/factory-process", id);
      await mkdir(directory, { recursive: true });
      nativeConfiguration = await saveNativeLiveConfiguration(
        resolve(directory, "substrate-live.json"),
        commissionedNative,
        !!retained,
      );
    }
    if (!nativeConfiguration) {
      const directory = resolve(".factory/test-results/factory-process", id);
      await mkdir(directory, { recursive: true });
      const caFile = resolve(directory, "fixture-native-ca.pem");
      await writeFile(
        caFile,
        "-----BEGIN CERTIFICATE-----\nowned-controller-fixture\n-----END CERTIFICATE-----\n",
        { mode: 0o600 },
      );
      nativeConfiguration = resolve(directory, "substrate.json");
      const connection = {
        bridge: resolve(directory, "unavailable-native-control"),
        endpoint: "127.0.0.1:1",
        serverName: "api.ate-system.svc",
        caFile,
        tokenFile: resolve(directory, "unavailable-native-token"),
      };
      // Planning/controller fixtures have no runtime server. Any accidental
      // native dispatch fails closed rather than contacting a retained cluster.
      await writeFile(
        nativeConfiguration,
        JSON.stringify({
          deployment: "owned-test",
          database: new URL(databaseURL).pathname.slice(1),
          connection,
          provisioner: connection,
          editorPrincipal: "user:system:serviceaccount:owned:factory-control",
          connectorURL: "wss://owned-factory.test/internal/runtime-connect",
          factoryCAFile: caFile,
          workloadImage: `registry.example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
          profile: "nightly-20261109-975fb172241c",
          runtime: fixtureRuntime,
          workerSelector: {
            "factory.runtime/profile": "nightly-20261109-975fb172241c",
            "factory.dev/deployment": id,
          },
          egressHosts: [],
        }),
        { mode: 0o600 },
      );
    }
    const environment = {
      ...process.env,
      DATABASE_URL: databaseURL,
      FACTORY_HOST: liveRuntime ? "0.0.0.0" : "127.0.0.1",
      FACTORY_PORT: String(port),
      FACTORY_BASE_URL: base,
      FACTORY_STATE_DIRECTORY: `.factory/test-results/factory-process/${id}`,
      FACTORY_ADMIN_EMAIL: `owned-${id}@factory.local`,
      FACTORY_ADMIN_PASSWORD: "owned-process-password-not-a-secret",
      FACTORY_AUTH_SECRET: ownedFactorySigningSecret,
      FACTORY_FORGEJO_API_URL: liveRuntime
        ? "http://127.0.0.1:33030/api/v1/"
        : "http://127.0.0.1:9/api/v1/",
      FACTORY_FORGEJO_TOKEN: liveRuntime?.forgejoToken ?? "owned-unused-forge-token",
      FACTORY_FORGEJO_OWNER: liveRuntime ? "factory-mutation" : "owned-process-fixture",
      FACTORY_RUNTIME_HOST_IMAGE:
        liveRuntime?.runtimeHostImage ??
        `registry.example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
      FACTORY_MODEL_BASE_URL: liveRuntime
        ? process.env["FACTORY_MODEL_BASE_URL"]
        : "http://127.0.0.1:9/v1",
      FACTORY_MODEL_API_KEY: liveRuntime
        ? process.env["FACTORY_MODEL_API_KEY"]
        : "owned-unused-model-token",
      FACTORY_PLANNING_MODEL_BASE_URL: liveRuntime
        ? process.env["FACTORY_PLANNING_MODEL_BASE_URL"]
        : "",
      FACTORY_PLANNING_MODEL_API_KEY: liveRuntime
        ? process.env["FACTORY_PLANNING_MODEL_API_KEY"]
        : "",
      FACTORY_ZERO_CACHE_URL: "",
      ...publishedRuntimeImages,
      ...modelOverrides,
      // An operator template must not overwrite this fixture's fresh database attribution.
      FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: nativeConfiguration,
    };
    if (modelOverrides?.FACTORY_FORGEJO_ADMIN_TOKEN) {
      environment.FACTORY_HOST = "0.0.0.0";
      environment.FACTORY_FORGE_ISSUER_HOST = "host.docker.internal";
      environment.FACTORY_FORGE_ISSUER_URL = `http://host.docker.internal:${port}/api/auth`;
      environment.FACTORY_FORGE_DISCOVERY_URL = `${environment.FACTORY_FORGE_ISSUER_URL}/.well-known/openid-configuration`;
    }
    return {
      base,
      id,
      databaseURL,
      nativeConfiguration,
      processes,
      shutdown,
      async pause() {
        await shutdown();
        await planningCache?.dispose();
        planningCache = undefined;
        await callback?.dispose();
        callback = undefined;
      },
      connect(max = 10) {
        const previousURL = process.env["DATABASE_URL"];
        try {
          process.env["DATABASE_URL"] = databaseURL;
          return createDatabase(max);
        } finally {
          if (previousURL === undefined) delete process.env["DATABASE_URL"];
          else process.env["DATABASE_URL"] = previousURL;
        }
      },
      async startPlanningCache(observeWhileRunning = false, syncWorkers = 1, network?: string) {
        callback ??= await ownedContainerCallback(base, network ?? shared?.network);
        planningCache ??= await ownedPlanningCache(
          databaseURL,
          base,
          observeWhileRunning,
          syncWorkers,
          network ?? shared?.network,
          callback.base,
        );
        environment.FACTORY_ZERO_CACHE_URL = planningCache.url;
        return planningCache;
      },
      async start(entrypoint = "apps/factory/src/server.ts", args: string[] = []) {
        const child = Bun.spawn(factoryProcessCommand(entrypoint, args), {
          env: environment,
          stdout: "pipe",
          stderr: "pipe",
        });
        processes.push(child);
        // Drain without publishing credentials or raw auth/provider diagnostics.
        void new Response(child.stdout).text();
        void new Response(child.stderr).text();
        await eventually(
          async () => {
            if (child.exitCode !== null) throw new Error(`Owned Factory exited: ${child.exitCode}`);
            return fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1_000) }).catch(
              () => null,
            );
          },
          (response) => response?.ok === true,
          "Owned Factory did not start",
          // Cold TypeScript/module preparation can exceed ten seconds under
          // concurrent proof load. Observe this same process, never replace it.
          30_000,
        );
        return child;
      },
      async signIn() {
        const response = await fetch(`${base}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({
            email: environment.FACTORY_ADMIN_EMAIL,
            password: environment.FACTORY_ADMIN_PASSWORD,
          }),
        });
        if (!response.ok) throw new Error(`Owned sign-in failed: ${response.status}`);
        return response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
      },
      async kill(child: ReturnType<typeof Bun.spawn>) {
        if (!processes.includes(child)) throw new Error("Factory process is not owned");
        child.kill("SIGKILL");
        await child.exited;
      },
      dispose,
    };
  } catch (cause) {
    if (retained) {
      await shutdown();
      await planningCache?.dispose();
    } else await dispose();
    throw cause;
  }
}
