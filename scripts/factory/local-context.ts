// Local Factory CLI argument parsing, shared execution helpers, and ownership validation.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { kubernetesCommand } from "#runtime-kubernetes/config";
import { requirePublishedRuntimeArtifacts } from "./artifacts";
import { requireForgeFixtureInstallation } from "./forge-fixture";
import {
  composeEnvironment,
  composeProject,
  createInstallation,
  type DisposableInstallation,
  installationDirectory,
  loadInstallation,
  requireOwnedResource,
  requireResetConfirmation,
} from "./installation";
import { requireNativeInstallation, requireNativeRuntimeArtifact } from "./native-installation";
import { inspectCurrentContainers, requireModelConfiguration } from "./preflight";

export type FactoryAction =
  | "up"
  | "restart"
  | "reset"
  | "status"
  | "publish-runtime"
  | "prepare-fixture";

export type ParsedFactoryArgs = {
  action: FactoryAction;
  disposableName: string | undefined;
  confirmation: string | undefined;
  resetData: boolean;
};

export type CommandOptions = { input?: string; quiet?: boolean; env?: Record<string, string> };

export type CommandRunner = (arguments_: string[], options?: CommandOptions) => Promise<string>;

export type LocalFactoryContext = {
  root: string;
  action: FactoryAction;
  sharedStateDirectory: string;
  stateDirectory: string;
  installation: DisposableInstallation | null;
  confirmation: string | undefined;
  resetData: boolean;
  namespace: string;
  ports: { factory: number; forgejo: number; zero: number };
  factoryBaseURL: string;
  forgejoBaseURL: string;
  paths: {
    serverPIDFile: string;
    forgejoTokenFile: string;
    forgejoAdminTokenFile: string;
    authSecretFile: string;
    serverLogFile: string;
    serverIdentityFile: string;
  };
  composeArguments: string[];
  serverImage: string | undefined;
  command: CommandRunner;
  kubectl: (arguments_: string[], input?: string, quiet?: boolean) => Promise<string>;
  forgejoExec: (arguments_: string[], quiet?: boolean) => Promise<string>;
};

const actions = new Set<FactoryAction>([
  "up",
  "restart",
  "reset",
  "status",
  "publish-runtime",
  "prepare-fixture",
]);

export function parseFactoryArgs(argv: string[]): ParsedFactoryArgs {
  const action = argv[0];
  const flags = argv.slice(1);
  const option = (flag: string) => {
    const index = flags.indexOf(flag);
    if (index === -1) return undefined;
    const value = flags[index + 1];
    if (!value || value.startsWith("--") || flags.lastIndexOf(flag) !== index)
      throw new Error(`Missing or repeated ${flag} argument`);
    return value;
  };
  const disposableName = option("--disposable");
  const confirmation = option("--confirm");
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "--disposable" || flags[index] === "--confirm") index += 1;
    else if (flags[index] !== "--data") throw new Error("Unknown Factory command argument");
  }
  const resetData = flags.includes("--data");
  if (action === "reset" && (!disposableName || confirmation !== disposableName || !resetData))
    requireResetConfirmation(null, confirmation, resetData);
  if (disposableName && action === "publish-runtime")
    throw new Error("Disposable installations reuse approved published runtime images");
  if (!action || !actions.has(action as FactoryAction)) throw new Error("Unknown Factory action");
  if (action === "prepare-fixture" && (!disposableName || confirmation !== disposableName))
    throw new Error("Fixture preparation requires --disposable NAME --confirm NAME");
  if (disposableName && action === "up") requireModelConfiguration(process.env);
  return { action: action as FactoryAction, disposableName, confirmation, resetData };
}

export function createCommandRunner(root: string): CommandRunner {
  return async (arguments_, options = {}) => {
    const child = Bun.spawn(arguments_, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (options.input !== undefined) {
      const stdin = child.stdin;
      if (!stdin) throw new Error("Command stdin was not created");
      stdin.write(options.input);
      await stdin.flush();
      stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (!options.quiet) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    if (exitCode !== 0)
      throw new Error(
        options.quiet
          ? `${arguments_[0]} operation failed with ${exitCode}. Sensitive output suppressed.`
          : `${arguments_.join(" ")} failed with ${exitCode}`,
      );
    return stdout.trim();
  };
}

export async function createLocalContext(
  root: string,
  parsed: ParsedFactoryArgs,
): Promise<LocalFactoryContext> {
  const sharedStateDirectory = resolve(
    process.env["FACTORY_STATE_DIRECTORY"] || resolve(root, ".factory"),
  );
  const installation = parsed.disposableName
    ? parsed.action === "up"
      ? await requirePublishedRuntimeArtifacts(sharedStateDirectory).then((artifacts) =>
          createInstallation(root, parsed.disposableName as string, {
            runtimeImage: artifacts["runtime-host"],
            browserImage: artifacts["browser-tools"],
          }),
        )
      : await loadInstallation(root, parsed.disposableName)
    : null;
  if (parsed.action === "prepare-fixture")
    requireForgeFixtureInstallation(installation, parsed.confirmation);
  const stateDirectory = installation
    ? installationDirectory(root, installation.name)
    : sharedStateDirectory;
  const ports = {
    factory: installation?.ports.factory ?? Number(process.env["FACTORY_LOCAL_PORT"] || 3000),
    forgejo:
      installation?.ports.forgejo ?? Number(process.env["FACTORY_LOCAL_FORGEJO_PORT"] || 33030),
    zero: installation?.ports.zero ?? Number(process.env["FACTORY_LOCAL_ZERO_PORT"] || 4948),
  };
  for (const port of [ports.factory, ports.forgejo, ports.zero])
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid local Factory port");
  const composeArguments = [
    "docker",
    "compose",
    "-f",
    "deploy/local/compose.yaml",
    ...(installation ? ["--project-name", composeProject(installation)] : []),
  ];
  const command = createCommandRunner(root);
  return {
    root,
    action: parsed.action,
    sharedStateDirectory,
    stateDirectory,
    installation,
    confirmation: parsed.confirmation,
    resetData: parsed.resetData,
    namespace: "open-factory-envbox-smoke",
    ports,
    factoryBaseURL: `http://127.0.0.1:${ports.factory}`,
    forgejoBaseURL: `http://127.0.0.1:${ports.forgejo}`,
    paths: {
      serverPIDFile: resolve(stateDirectory, "server.pid"),
      forgejoTokenFile: resolve(stateDirectory, "forgejo-token"),
      forgejoAdminTokenFile: resolve(stateDirectory, "forgejo-admin-token"),
      authSecretFile: resolve(stateDirectory, "auth-secret"),
      serverLogFile: resolve(stateDirectory, "server.log"),
      serverIdentityFile: resolve(stateDirectory, "server.json"),
    },
    composeArguments,
    serverImage: undefined,
    command,
    kubectl: (arguments_, input, quiet = false) =>
      command(kubernetesCommand(arguments_), input === undefined ? { quiet } : { input, quiet }),
    forgejoExec: (arguments_, quiet = false) =>
      command([...composeArguments, "exec", "-T", "forgejo", "forgejo", ...arguments_], { quiet }),
  };
}

export async function localSecret(path: string) {
  const existing = (await readFile(path, "utf8").catch(() => "")).trim();
  if (existing) {
    await chmod(path, 0o600);
    return existing;
  }
  const value = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return value;
}

export async function configuredRuntimeArtifacts(sharedStateDirectory: string) {
  const native = requireNativeInstallation();
  const artifacts = await requirePublishedRuntimeArtifacts(sharedStateDirectory);
  requireNativeRuntimeArtifact(native, artifacts);
  return artifacts;
}

export async function configureInstallation(ctx: LocalFactoryContext) {
  const { installation, action, stateDirectory } = ctx;
  if (!installation) return;
  if (installation.phase !== "active" && action !== "reset" && action !== "status")
    throw new Error("Installation reset is pending or completed; use a new name");
  const secret = async (file: string) =>
    action === "up"
      ? localSecret(resolve(stateDirectory, file))
      : (await readFile(resolve(stateDirectory, file), "utf8")).trim();
  Object.assign(process.env, composeEnvironment(installation), {
    FACTORY_LOCAL_DB_PASSWORD: await secret("database-password"),
    FACTORY_LOCAL_ZERO_PASSWORD: await secret("zero-password"),
  });
  process.env["DATABASE_URL"] =
    `postgresql://factory:${process.env["FACTORY_LOCAL_DB_PASSWORD"]}@127.0.0.1:${installation.ports.postgres}/factory`;
}

export async function validateComposeOwnership(ctx: LocalFactoryContext, expectAbsent = false) {
  const { installation, command } = ctx;
  if (!installation) throw new Error("Disposable installation required");
  const project = composeProject(installation);
  for (const [kind, expected] of [
    [
      "volume",
      ["factory-postgres", "forgejo-data", "forgejo-config", "zero-cache-data"].map(
        (value) => `${project}_${value}`,
      ),
    ],
    ["network", [`${project}_default`]],
  ] as const) {
    const names = new Set(
      (await command(["docker", kind, "ls", "--format", "{{.Name}}"], { quiet: true })).split("\n"),
    );
    const owned = (
      await command(
        [
          "docker",
          kind,
          "ls",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.Name}}",
        ],
        { quiet: true },
      )
    )
      .split("\n")
      .filter(Boolean);
    const candidates = new Set([...expected.filter((value) => names.has(value)), ...owned]);
    for (const candidate of candidates) {
      if (!expected.some((value) => value === candidate) || expectAbsent)
        throw new Error("Reset refused unexpected or remaining Compose resources");
      const resources = JSON.parse(
        await command(["docker", kind, "inspect", candidate], { quiet: true }),
      ) as Array<{ Labels: Record<string, string> | null }>;
      if (resources.length !== 1) throw new Error("Reset could not confirm resource identity");
      requireOwnedResource(installation, {
        labels: resources[0]?.Labels,
        projectLabel: "com.docker.compose.project",
      });
    }
  }
  const containers = await inspectCurrentContainers(
    async () =>
      (await command(["docker", "ps", "--all", "--quiet"], { quiet: true }))
        .split("\n")
        .filter(Boolean),
    async (ids) =>
      JSON.parse(await command(["docker", "inspect", ...ids], { quiet: true })) as Array<{
        Config: { Labels: Record<string, string> };
        Mounts: Array<{ Type: string; Name?: string }>;
      }>,
  );
  for (const container of containers) {
    const labels = container.Config.Labels;
    const usesVolume = container.Mounts.some((mount) => mount.Name?.startsWith(`${project}_`));
    if (
      labels["com.docker.compose.project"] !== project &&
      !usesVolume &&
      labels["factory.dev/installation"] !== installation.owner
    )
      continue;
    if (expectAbsent) throw new Error("Reset left an owned container");
    requireOwnedResource(installation, { labels, projectLabel: "com.docker.compose.project" });
    if (
      !["postgres", "forgejo", "zero-cache"].includes(labels["com.docker.compose.service"] ?? "") ||
      container.Mounts.some(
        (mount) => mount.Type !== "volume" || !mount.Name?.startsWith(`${project}_`),
      )
    )
      throw new Error("Reset refused unexpected container or mounts");
  }
}
