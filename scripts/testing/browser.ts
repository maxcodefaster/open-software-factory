import { ownClientProcesses, runProcess } from "../owned-client-process";
import { verificationEnvironment } from "./test-prerequisites";

type Environment = Record<string, string | undefined>;
type BrowserHost = {
  base: string;
  databaseURL: string;
  email: string;
  password: string;
  dispose(): Promise<void>;
};
type BrowserDependencies = {
  build(environment: Environment, signal?: AbortSignal): Promise<() => Promise<void>>;
  host(environment: Environment, signal?: AbortSignal): Promise<BrowserHost>;
  run(args: string[], environment: Environment, signal?: AbortSignal): Promise<number>;
};

function interruptedCode(signal: AbortSignal) {
  return signal.reason === "SIGINT" ? 130 : signal.reason === "SIGTERM" ? 143 : 1;
}

export function needsOwnedBrowserHost(args: readonly string[], environment: Environment) {
  return (
    (environment["FACTORY_BROWSER_LANE"] ?? "ui") === "ui" &&
    !environment["FACTORY_BROWSER_BASE_URL"] &&
    !args.some((arg) => ["--list", "--help", "-h"].includes(arg))
  );
}

export async function runBrowserChecks(
  args: string[],
  environment: Environment,
  dependencies: BrowserDependencies,
  signal?: AbortSignal,
) {
  let code: number;
  try {
    signal?.throwIfAborted();
    if (!needsOwnedBrowserHost(args, environment)) {
      code = await dependencies.run(args, environment, signal);
    } else {
      const ownedEnvironment = verificationEnvironment(environment);
      // A direct run owns its daemon rather than adopting an inherited fixture identity.
      delete ownedEnvironment["FACTORY_TEST_POSTGRES"];
      let disposeBuild: (() => Promise<void>) | undefined;
      let host: BrowserHost | undefined;
      try {
        disposeBuild = await dependencies.build(ownedEnvironment, signal);
        signal?.throwIfAborted();
        host = await dependencies.host(ownedEnvironment, signal);
        signal?.throwIfAborted();
        code = await dependencies.run(
          args,
          {
            ...ownedEnvironment,
            FACTORY_BROWSER_BASE_URL: host.base,
            DATABASE_URL: host.databaseURL,
            FACTORY_ADMIN_EMAIL: host.email,
            FACTORY_ADMIN_PASSWORD: host.password,
          },
          signal,
        );
      } finally {
        try {
          await host?.dispose();
        } finally {
          await disposeBuild?.();
        }
      }
    }
  } catch (cause) {
    if (!signal?.aborted || cause !== signal.reason) throw cause;
    code = interruptedCode(signal);
  }
  // Cleanup can receive the first interrupt after the command returned zero.
  return signal?.aborted ? interruptedCode(signal) : code;
}

async function ownedHost(environment: Environment, signal?: AbortSignal): Promise<BrowserHost> {
  let postgres:
    | Awaited<ReturnType<typeof import("../../test/fixtures/postgres-server").ownedPostgresServer>>
    | undefined;
  let owned:
    | Awaited<ReturnType<typeof import("../../test/fixtures/factory-process").factoryProcess>>
    | undefined;
  let disposeChildren: (() => Promise<void>) | undefined;
  const dispose = async () => {
    // Do not delete a database while a local client is still unconfirmed.
    await disposeChildren?.();
    try {
      await owned?.dispose();
    } finally {
      await postgres?.dispose();
    }
  };
  try {
    signal?.throwIfAborted();
    const { factoryProcess } = await import("../../test/fixtures/factory-process");
    const { ownedPostgresServer } = await import("../../test/fixtures/postgres-server");
    signal?.throwIfAborted();
    // An admitted external create must return its confirmed owner before cleanup.
    // Never race it against cancellation and guess which resource to remove.
    postgres = await ownedPostgresServer();
    signal?.throwIfAborted();
    const previous = process.env;
    try {
      process.env = {
        ...environment,
        FACTORY_TEST_POSTGRES: JSON.stringify(postgres.identity),
      };
      owned = await factoryProcess();
    } finally {
      process.env = previous;
    }
    disposeChildren = ownClientProcesses(owned.processes, signal);
    signal?.throwIfAborted();
    await owned.startPlanningCache();
    signal?.throwIfAborted();
    await owned.start();
    signal?.throwIfAborted();
    const database = owned.connect();
    try {
      const email = `owned-${owned.id}@factory.local`;
      const [administrator] = await database.client<{ id: string }[]>`
        SELECT id FROM auth."user" WHERE email=${email}`;
      if (!administrator) throw new Error("Owned browser administrator is unavailable");
      signal?.throwIfAborted();
      const projectID = crypto.randomUUID();
      await database.client`INSERT INTO factory.project
        (id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},'factory-starter','factory-starter',
          'https://example.invalid/owned-browser.git','main','.devcontainer/devcontainer.json',
          ${administrator.id})`;
      signal?.throwIfAborted();
      await database.client`INSERT INTO factory.project_membership
        (project_id,user_id,role,manage_project,updated_by)
        VALUES(${projectID},${administrator.id},'developer',true,${administrator.id})`;
    } finally {
      await database.client.end({ timeout: 2 });
    }
    signal?.throwIfAborted();
    console.info(`Owned browser Factory: ${owned.id}`);
    return {
      base: owned.base,
      databaseURL: owned.databaseURL,
      email: `owned-${owned.id}@factory.local`,
      password: "owned-process-password-not-a-secret",
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

if (import.meta.main) {
  const cancellation = new AbortController();
  let interrupted: number | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= signal === "SIGINT" ? 130 : 143;
    process.exitCode = interrupted;
    if (!cancellation.signal.aborted) cancellation.abort(signal);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const { prepareBrowserBuild } = await import("../../test/fixtures/browser-build");
    process.exitCode = await runBrowserChecks(
      process.argv.slice(2),
      process.env,
      {
        build: (environment, signal) => prepareBrowserBuild(environment, undefined, signal),
        host: ownedHost,
        async run(args, environment, signal) {
          const child = await runProcess(
            [
              process.execPath,
              "--no-env-file",
              "node_modules/@playwright/test/cli.js",
              "test",
              ...args,
            ],
            { env: environment, signal, output: "inherit", allowFailure: true },
          );
          return child.code;
        },
      },
      cancellation.signal,
    );
  } catch (cause) {
    if (!cancellation.signal.aborted) throw cause;
    // Interrupt status does not hide an unconfirmed setup or cleanup outcome.
    if (cause !== cancellation.signal.reason) console.error(cause);
  } finally {
    if (interrupted !== undefined) process.exitCode = interrupted;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
