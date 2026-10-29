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
  build(environment: Environment): Promise<() => Promise<void>>;
  host(environment: Environment): Promise<BrowserHost>;
  run(args: string[], environment: Environment): Promise<number>;
};

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
) {
  if (!needsOwnedBrowserHost(args, environment)) return dependencies.run(args, environment);
  const ownedEnvironment = verificationEnvironment(environment);
  // A direct run owns its daemon rather than adopting an inherited fixture identity.
  delete ownedEnvironment["FACTORY_TEST_POSTGRES"];
  const disposeBuild = await dependencies.build(ownedEnvironment);
  let host: BrowserHost | undefined;
  try {
    host = await dependencies.host(ownedEnvironment);
    return await dependencies.run(args, {
      ...ownedEnvironment,
      FACTORY_BROWSER_BASE_URL: host.base,
      DATABASE_URL: host.databaseURL,
      FACTORY_ADMIN_EMAIL: host.email,
      FACTORY_ADMIN_PASSWORD: host.password,
    });
  } finally {
    try {
      await host?.dispose();
    } finally {
      await disposeBuild();
    }
  }
}

async function ownedHost(environment: Environment): Promise<BrowserHost> {
  const { factoryProcess } = await import("../../test/fixtures/factory-process");
  const previous = process.env;
  let owned: Awaited<ReturnType<typeof factoryProcess>>;
  try {
    process.env = environment;
    owned = await factoryProcess();
  } finally {
    process.env = previous;
  }
  try {
    await owned.startPlanningCache();
    await owned.start();
    const database = owned.connect();
    try {
      const email = `owned-${owned.id}@factory.local`;
      const [administrator] = await database.client<{ id: string }[]>`
        SELECT id FROM auth."user" WHERE email=${email}`;
      if (!administrator) throw new Error("Owned browser administrator is unavailable");
      const projectID = crypto.randomUUID();
      await database.client`INSERT INTO factory.project
        (id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},'factory-starter','factory-starter',
          'https://example.invalid/owned-browser.git','main','.devcontainer/devcontainer.json',
          ${administrator.id})`;
      await database.client`INSERT INTO factory.project_membership
        (project_id,user_id,role,manage_project,updated_by)
        VALUES(${projectID},${administrator.id},'developer',true,${administrator.id})`;
    } finally {
      await database.client.end({ timeout: 2 });
    }
    console.info(`Owned browser Factory: ${owned.id}`);
    return {
      base: owned.base,
      databaseURL: owned.databaseURL,
      email: `owned-${owned.id}@factory.local`,
      password: "owned-process-password-not-a-secret",
      dispose: () => owned.dispose(),
    };
  } catch (cause) {
    await owned.dispose();
    throw cause;
  }
}

if (import.meta.main) {
  const { prepareBrowserBuild } = await import("../../test/fixtures/browser-build");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted: number | undefined;
  const interrupt = (code: number) => {
    interrupted ??= code;
    if (child?.exitCode === null) child.kill("SIGTERM");
  };
  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    process.exitCode = await runBrowserChecks(process.argv.slice(2), process.env, {
      build: prepareBrowserBuild,
      host: ownedHost,
      async run(args, environment) {
        if (interrupted !== undefined) return interrupted;
        child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "node_modules/@playwright/test/cli.js",
            "test",
            ...args,
          ],
          { env: environment, stdout: "inherit", stderr: "inherit" },
        );
        const code = await child.exited;
        return interrupted ?? code;
      },
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
