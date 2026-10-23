import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";

type Execute = typeof runCommand;
type ContainerIntent = {
  version: 1;
  startupID: string;
  owner: string;
  name: string;
  image: string;
  runtimeHost: string;
  containerID: string | null;
};
type ContainerObservation = {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
};
const identityFile = "server-container.json";
const imageID = /^sha256:[a-f0-9]{64}$/;
const startupIDPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const observation =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{{json .Config.Labels}}}';

function ownerFor(directory: string) {
  return createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 24);
}

export function requireFactoryServerRuntimeHost(value: string | undefined) {
  if (value && isIPv4(value)) {
    const [first, second] = value.split(".").map(Number);
    if (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
      return value;
  }
  throw new Error(
    "FACTORY_SERVER_IMAGE needs FACTORY_RUNTIME_HOST set to the Linux node's reachable private IPv4 address",
  );
}

export function factoryServerComposeOverlay(runtimeHost: string, forgejoPort: number) {
  const host = requireFactoryServerRuntimeHost(runtimeHost);
  if (!Number.isInteger(forgejoPort) || forgejoPort < 1024 || forgejoPort > 65535)
    throw new Error("Invalid local Forgejo listener port");
  return { services: { forgejo: { ports: [`${host}:${forgejoPort}:3000`] } } };
}

function requireIntent(value: ContainerIntent, directory: string) {
  requireFactoryServerRuntimeHost(value.runtimeHost);
  if (
    value.version !== 1 ||
    !startupIDPattern.test(value.startupID) ||
    value.owner !== ownerFor(directory) ||
    value.name !== `factory-server-${value.owner}-${value.startupID}` ||
    !imageID.test(value.image) ||
    (value.containerID !== null && !/^[a-f0-9]{64}$/.test(value.containerID))
  )
    throw new Error("Factory server container identity is invalid");
  return value;
}

function requireOwned(actual: ContainerObservation, intended: ContainerIntent) {
  if (
    !/^[a-f0-9]{64}$/.test(actual.id) ||
    (intended.containerID !== null && intended.containerID !== actual.id) ||
    actual.name !== `/${intended.name}` ||
    actual.image !== intended.image ||
    actual.labels?.["factory.dev/server-owner"] !== intended.owner ||
    actual.labels["factory.dev/server-startup"] !== intended.startupID
  )
    throw new Error("Refusing a Factory server container with different ownership or identity");
  return actual;
}

async function inspect(intended: ContainerIntent, execute: Execute) {
  const result = await execute([
    "docker",
    "inspect",
    "--format",
    observation,
    intended.containerID ?? intended.name,
  ]);
  if (result.exitCode !== 0) {
    if (/No such (container|object)/i.test(result.stderr)) return null;
    throw new Error("Factory server container observation is unavailable");
  }
  return requireOwned(JSON.parse(result.stdout), intended);
}

export async function requireFactoryServerImage(reference: string, execute: Execute = runCommand) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:/@_-]{0,254}$/.test(reference))
    throw new Error("Invalid FACTORY_SERVER_IMAGE");
  const result = await execute(["docker", "image", "inspect", "--format", "{{.Id}}", reference]);
  const id = result.stdout.trim();
  if (result.exitCode !== 0 || !imageID.test(id))
    throw new Error("Build or pull FACTORY_SERVER_IMAGE before replacing the running Factory");
  return id;
}

export async function retainedFactoryServerContainer(directory: string) {
  const raw = await readFile(resolve(directory, identityFile), "utf8").catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    },
  );
  return raw === null ? null : requireIntent(JSON.parse(raw), directory);
}

export async function prepareFactoryServerContainer(
  input: {
    stateDirectory: string;
    sharedStateDirectory: string;
    image: string;
    startupID: string;
    environment: Record<string, string | undefined>;
  },
  execute: Execute = runCommand,
) {
  const directory = resolve(input.stateDirectory);
  if (await Bun.file(resolve(directory, identityFile)).exists())
    throw new Error("Stop the recorded Factory server container before starting another");
  const owner = ownerFor(directory);
  const intended = requireIntent(
    {
      version: 1,
      startupID: input.startupID,
      owner,
      name: `factory-server-${owner}-${input.startupID}`,
      image: input.image,
      runtimeHost: input.environment["FACTORY_RUNTIME_HOST"] ?? "",
      containerID: null,
    },
    directory,
  );
  const privateDirectory = resolve(directory, "server-runtime", intended.startupID);
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  let recorded = false;
  try {
    const credentialMounts: string[] = [];
    for (const key of ["FACTORY_OPENBAO_TOKEN_FILE", "FACTORY_OPENBAO_CA_FILE"]) {
      const file = input.environment[key];
      if (!file) continue;
      if (
        !isAbsolute(file) ||
        file.includes(",") ||
        !(await lstat(file).catch(() => null))?.isFile()
      )
        throw new Error(`${key} must name an available regular file`);
      credentialMounts.push(`type=bind,src=${file},dst=${file},readonly`);
    }
    const configuration = await execute(
      kubernetesCommand(["config", "view", "--raw", "--flatten", "--minify"], input.environment),
    );
    if (configuration.exitCode !== 0 || !configuration.stdout.trim())
      throw new Error("Factory server needs an available self-contained Kubernetes configuration");
    const kubeconfig = resolve(privateDirectory, "kubeconfig");
    const environmentFile = resolve(privateDirectory, "environment");
    await writeFile(kubeconfig, configuration.stdout, { mode: 0o600 });
    const environment = {
      ...input.environment,
      FACTORY_STATE_DIRECTORY: directory,
      NODE_ENV: input.environment["NODE_ENV"] ?? "development",
      KUBECONFIG: "/run/factory/kubeconfig",
      FACTORY_KUBERNETES_CONTEXT: input.environment["FACTORY_KUBERNETES_CONTEXT"] ?? "",
    };
    const serialized = Object.entries(environment)
      .flatMap(([key, value]) => {
        if (
          value === undefined ||
          (!key.startsWith("FACTORY_") &&
            ![
              "DATABASE_URL",
              "NODE_ENV",
              "KUBECONFIG",
              "HTTP_PROXY",
              "HTTPS_PROXY",
              "NO_PROXY",
            ].includes(key))
        )
          return [];
        if (/[\r\n\0]/.test(value))
          throw new Error(`Factory container environment ${key} must be a single line`);
        return [`${key}=${value}`];
      })
      .join("\n");
    await writeFile(environmentFile, `${serialized}\n`, { mode: 0o600 });
    // The identity exists before Docker can create anything. A lost response is
    // recovered by this exact name and labels, never by repeating creation.
    await writeFile(resolve(directory, identityFile), JSON.stringify(intended), {
      mode: 0o600,
      flag: "wx",
    });
    recorded = true;
    const mounts = [
      `type=bind,src=${directory},dst=${directory}`,
      `type=bind,src=${kubeconfig},dst=/run/factory/kubeconfig,readonly`,
      ...credentialMounts,
    ];
    const shared = resolve(input.sharedStateDirectory);
    if (shared !== directory) mounts.push(`type=bind,src=${shared},dst=${shared},readonly`);
    return {
      command: [
        "docker",
        "run",
        "--name",
        intended.name,
        "--init",
        "--restart",
        "unless-stopped",
        "--network",
        "host",
        "--label",
        `factory.dev/server-owner=${owner}`,
        "--label",
        `factory.dev/server-startup=${intended.startupID}`,
        "--log-opt",
        "max-size=2m",
        "--log-opt",
        "max-file=2",
        ...mounts.flatMap((mount) => ["--mount", mount]),
        "--env-file",
        environmentFile,
        "--entrypoint",
        "/usr/local/bin/bun",
        input.image,
        "apps/factory/src/server.ts",
      ],
      async confirm() {
        const actual = await inspect(intended, execute);
        if (!actual) throw new Error("Factory server container creation is not confirmed");
        intended.containerID = actual.id;
        await writeFile(resolve(directory, identityFile), JSON.stringify(intended), {
          mode: 0o600,
        });
        await rm(environmentFile, { force: true });
      },
    };
  } catch (cause) {
    if (!recorded) await rm(privateDirectory, { recursive: true, force: true });
    throw cause;
  }
}

export async function stopFactoryServerContainer(directory: string, execute: Execute = runCommand) {
  const file = resolve(directory, identityFile);
  const raw = await readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (raw === null) return false;
  const intended = requireIntent(JSON.parse(raw), directory);
  const actual = await inspect(intended, execute);
  if (actual) {
    const stopped = await execute(["docker", "stop", "--time", "30", actual.id], undefined, {
      timeoutMS: 45_000,
      outputBytes: 64 * 1024,
    });
    if (stopped.exitCode !== 0) throw new Error("Factory server container Stop is not confirmed");
    const removed = await execute(["docker", "rm", actual.id]);
    if (removed.exitCode !== 0 || (await inspect(intended, execute)) !== null)
      throw new Error("Factory server container removal is not confirmed");
  }
  await rm(resolve(directory, "server-runtime", intended.startupID), { recursive: true });
  await rm(file);
  return true;
}
