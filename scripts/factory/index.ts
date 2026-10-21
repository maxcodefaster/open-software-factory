import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createDatabase } from "../../packages/db/src/client";
import { projectImportOrigins } from "../../packages/project-domain/src/setup";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import upstream from "../../upstream.json";
import { inspectRegistryArtifact, requireAvailableRuntimeArtifacts } from "./artifact-availability";
import {
  installRuntimeArtifacts,
  publishedRuntimeArtifacts,
  type RuntimeArtifacts,
  runtimeArtifactsSchema,
} from "./artifacts";
import { requireContainerState } from "./container-state";
import { ensureLocalForgeIdentity } from "./forge-identity";
import { installForgeBrowserLogout } from "./forge-logout";
import {
  composeEnvironment,
  composeProject,
  createInstallation,
  installationDirectory,
  loadInstallation,
  requireOwnedResource,
  requireResetConfirmation,
} from "./installation";
import { ensureLocalMetricsServer } from "./metrics-server";
import { localOpenBao } from "./openbao";
import {
  inspectCurrentContainers,
  requireComposePins,
  requireModelConfiguration,
  requirePinnedImage,
} from "./preflight";
import { completeFactoryStartup, waitForFactory } from "./readiness";
import { waitForRegistry } from "./registry-readiness";
import { requireSafeRegistryStorage } from "./registry-storage";
import { requireRuntimeNamespacesAbsent, resetDisposable } from "./reset";
import { publishRuntimeImage } from "./runtime-publication";
import { localServerSettings } from "./server-settings";
import { localStarterCompose, starterImageManifest, starterImagesSchema } from "./starter-images";
import { disposeRuntimeStorageCheck, requireWritableRuntimeStorage } from "./storage-readiness";

const root = resolve(import.meta.dir, "../..");
process.env["FACTORY_FORGEJO_IMPORT_DOMAINS"] =
  projectImportOrigins(process.env["FACTORY_GIT_IMPORT_ORIGINS"])
    .map((origin) => new URL(origin).hostname)
    .join(",") || "imports-disabled.invalid";
const sharedStateDirectory = resolve(
  process.env["FACTORY_STATE_DIRECTORY"] || resolve(root, ".factory"),
);
const action = process.argv[2];
const flags = process.argv.slice(3);
function option(flag: string) {
  const index = flags.indexOf(flag);
  if (index === -1) return undefined;
  const value = flags[index + 1];
  if (!value || value.startsWith("--") || flags.lastIndexOf(flag) !== index)
    throw new Error(`Missing or repeated ${flag} argument`);
  return value;
}
const disposableName = option("--disposable");
const confirmation = option("--confirm");
for (let index = 0; index < flags.length; index += 1) {
  if (flags[index] === "--disposable" || flags[index] === "--confirm") index += 1;
  else if (flags[index] !== "--data") throw new Error("Unknown Factory command argument");
}
if (
  action === "reset" &&
  (!disposableName || confirmation !== disposableName || !flags.includes("--data"))
)
  requireResetConfirmation(null, confirmation, flags.includes("--data"));
if (disposableName && action === "publish-runtime")
  throw new Error("Disposable installations reuse approved published runtime images");
if (!["up", "container", "restart", "reset", "status", "publish-runtime"].includes(action ?? ""))
  throw new Error("Unknown Factory action");
if (disposableName && action === "up") requireModelConfiguration(process.env);
const installationArtifacts =
  disposableName && action === "up" ? await publishedRuntimeArtifacts(sharedStateDirectory) : null;
const installation = disposableName
  ? action === "up"
    ? await createInstallation(root, disposableName, {
        runtimeImage:
          installationArtifacts?.["runtime-host"] ??
          (await readFile(resolve(sharedStateDirectory, "runtime-host-image"), "utf8")).trim(),
        browserImage:
          installationArtifacts?.["browser-tools"] ??
          (await readFile(resolve(sharedStateDirectory, "browser-tools-image"), "utf8")).trim(),
      })
    : await loadInstallation(root, disposableName)
  : null;
const stateDirectory = installation
  ? installationDirectory(root, installation.name)
  : sharedStateDirectory;
const runtimeImageFile = resolve(stateDirectory, "runtime-host-image");
const browserImageFile = resolve(stateDirectory, "browser-tools-image");
const sourceFilesImageFile = resolve(sharedStateDirectory, "workspace-files-image");
const developerIDEImageFile = resolve(sharedStateDirectory, "developer-ide-image");
const buildRuntimeImageFile = resolve(sharedStateDirectory, "build-runtime-host-image");
const verificationRuntimeImageFile = resolve(
  sharedStateDirectory,
  "verification-runtime-host-image",
);
const serverPIDFile = resolve(stateDirectory, "server.pid");
const forgejoTokenFile = resolve(stateDirectory, "forgejo-token");
const forgejoAdminTokenFile = resolve(stateDirectory, "forgejo-admin-token");
const authSecretFile = resolve(stateDirectory, "auth-secret");
const serverLogFile = resolve(stateDirectory, "server.log");
const serverIdentityFile = resolve(stateDirectory, "server.json");
const factoryPort =
  installation?.ports.factory ?? Number(process.env["FACTORY_LOCAL_PORT"] || 3000);
const forgejoPort =
  installation?.ports.forgejo ?? Number(process.env["FACTORY_LOCAL_FORGEJO_PORT"] || 33030);
const zeroPort = installation?.ports.zero ?? Number(process.env["FACTORY_LOCAL_ZERO_PORT"] || 4948);
for (const port of [factoryPort, forgejoPort, zeroPort])
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid local Factory port");
let foregroundServer: ReturnType<typeof Bun.spawn> | undefined;
const factoryBaseURL = `http://127.0.0.1:${factoryPort}`;
const forgejoBaseURL = `http://127.0.0.1:${forgejoPort}`;
const composeArguments = [
  "docker",
  "compose",
  "-f",
  "deploy/local/compose.yaml",
  ...(installation ? ["--project-name", composeProject(installation)] : []),
];
const namespace = "open-factory-envbox-smoke";
const starterImagesFile = resolve(sharedStateDirectory, "starter-images.json");

async function command(
  arguments_: string[],
  options: { input?: string; quiet?: boolean; env?: Record<string, string> } = {},
) {
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
}

async function preflight() {
  if (process.platform === "linux" && !process.env["FACTORY_RUNTIME_HOST"])
    throw new Error(
      "Set FACTORY_RUNTIME_HOST to this host's address reachable from Kubernetes Pods",
    );
  if (Bun.version !== "1.4.3") throw new Error("Factory startup requires Bun 1.4.3");
  for (const value of [
    upstream.envbox.image,
    upstream.docker.image,
    upstream.nodeDevelopment.image,
  ])
    requirePinnedImage(value);
  if (
    !/^\d+\.\d+\.\d+$/.test(upstream.devcontainersCli.version) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(upstream.devcontainersCli.integrity)
  )
    throw new Error("Dev Containers CLI pin/integrity is invalid");
  const dockerOS = await command(["docker", "info", "--format", "{{.OSType}}"], { quiet: true });
  if (dockerOS !== "linux") throw new Error("Factory requires a running Linux Docker daemon");
  await command(["git", "--version"], { quiet: true });
  const compose = JSON.parse(
    await command([...composeArguments, "config", "--format", "json"], { quiet: true }),
  ) as Parameters<typeof requireComposePins>[0];
  requireComposePins(compose);
  await kubectl(["get", "nodes", "-o", "name"], undefined, true);
  if (installation) {
    requireModelConfiguration(process.env);
    requirePinnedImage(installation.runtimeImage);
    requirePinnedImage(installation.browserImage);
    await kubectl(
      ["get", "service/registry", "secret/registry-tls", "-n", namespace, "-o", "name"],
      undefined,
      true,
    );
    await validateComposeOwnership();
  }
  console.log(
    "Startup prerequisites and exact pins passed; sensitive configuration was not printed",
  );
}

async function kubectl(arguments_: string[], input?: string, quiet = false) {
  return command(kubernetesCommand(arguments_), input === undefined ? { quiet } : { input, quiet });
}

async function requireRegistryStorage() {
  const [existingRegistry, existingStorage] = await Promise.all(
    ["deployment/registry", "persistentvolumeclaim/registry-data"].map((resource) =>
      kubectl(
        ["get", resource, "-n", namespace, "--ignore-not-found", "-o", "json"],
        undefined,
        true,
      ),
    ),
  );
  requireSafeRegistryStorage(
    existingRegistry ? JSON.parse(existingRegistry) : null,
    existingStorage ? JSON.parse(existingStorage) : null,
  );
}

async function ensureRegistry() {
  await requireRegistryStorage();
  await kubectl(
    ["create", "namespace", namespace, "--dry-run=client", "-o", "json"],
    undefined,
    true,
  ).then((manifest) => kubectl(["apply", "-f", "-"], manifest));
  await mkdir(stateDirectory, { recursive: true });
  const certificate = resolve(stateDirectory, "registry.pem");
  const key = resolve(stateDirectory, "registry-key.pem");
  const rootCA = resolve(await command(["mkcert", "-CAROOT"], { quiet: true }), "rootCA.pem");
  await command([
    "mkcert",
    "-cert-file",
    certificate,
    "-key-file",
    key,
    "registry.localhost",
    `registry.${namespace}.svc.cluster.local`,
  ]);
  await kubectl(
    [
      "create",
      "secret",
      "generic",
      "registry-tls",
      "-n",
      namespace,
      `--from-file=tls.crt=${certificate}`,
      `--from-file=tls.key=${key}`,
      `--from-file=ca.crt=${rootCA}`,
      "--dry-run=client",
      "-o",
      "json",
    ],
    undefined,
    true,
  ).then((manifest) => kubectl(["apply", "-f", "-"], manifest));
  await kubectl(["apply", "-f", "deploy/runtime-smoke/registry.yaml"]);
  await kubectl(["rollout", "restart", "deployment/registry", "-n", namespace]);
  await kubectl(["rollout", "status", "deployment/registry", "-n", namespace, "--timeout=180s"]);
}

async function publishRuntimeHost() {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const registryPort = reservation.port;
  const registryHost = `registry.localhost:${registryPort}`;
  const registryRepository = `${registryHost}/open-factory/runtime-host`;
  await reservation.stop(true);
  const metadataFile = resolve(stateDirectory, "runtime-host-metadata.json");
  const rootCA = resolve(await command(["mkcert", "-CAROOT"], { quiet: true }), "rootCA.pem");
  const forward = Bun.spawn(
    kubernetesCommand([
      "port-forward",
      "-n",
      namespace,
      "service/registry",
      `${registryPort}:5000`,
    ]),
    { cwd: root, stdout: "ignore", stderr: "pipe" },
  );
  try {
    await waitForRegistry({ forward, host: registryHost, caFile: rootCA });
    let runtimeReference = "";
    const published: Record<string, string> = {};
    const outputs: Array<{ path: string; reference: string }> = [];
    for (const artifact of [
      {
        name: "runtime-host",
        repository: registryRepository,
        metadata: metadataFile,
        state: runtimeImageFile,
        dockerfile: "deploy/runtime-host/Dockerfile",
        target: "runtime-host",
      },
      {
        name: "build-runtime-host",
        repository: `${registryHost}/open-factory/build-runtime-host`,
        metadata: resolve(sharedStateDirectory, "build-runtime-host-metadata.json"),
        state: buildRuntimeImageFile,
        dockerfile: "deploy/runtime-host/Dockerfile",
        target: "build-runtime-host",
      },
      {
        name: "verification-runtime-host",
        repository: `${registryHost}/open-factory/verification-runtime-host`,
        metadata: resolve(sharedStateDirectory, "verification-runtime-host-metadata.json"),
        state: verificationRuntimeImageFile,
        dockerfile: "deploy/runtime-host/Dockerfile",
        target: "verification-runtime-host",
      },
      {
        name: "browser-tools",
        repository: `${registryHost}/open-factory/browser-tools`,
        metadata: resolve(stateDirectory, "browser-tools-metadata.json"),
        state: browserImageFile,
        dockerfile: "deploy/browser-tools/Dockerfile",
        target: undefined,
      },
      {
        name: "workspace-files",
        repository: `${registryHost}/open-factory/workspace-files`,
        metadata: resolve(sharedStateDirectory, "workspace-files-metadata.json"),
        state: sourceFilesImageFile,
        dockerfile: "deploy/workspace-files/Dockerfile",
        target: undefined,
      },
      {
        name: "developer-ide",
        repository: `${registryHost}/open-factory/developer-ide`,
        metadata: resolve(sharedStateDirectory, "developer-ide-metadata.json"),
        state: developerIDEImageFile,
        dockerfile: "deploy/runtime-host/Dockerfile",
        target: "developer-ide",
      },
    ]) {
      await publishRuntimeImage(artifact, command);
      const metadata = JSON.parse(await readFile(artifact.metadata, "utf8")) as {
        "containerimage.digest"?: string;
      };
      const digest = metadata["containerimage.digest"];
      if (!digest?.match(/^sha256:[a-f0-9]{64}$/))
        throw new Error(`${artifact.name} build returned no exact pushed digest`);
      const reference = `registry.${namespace}.svc.cluster.local:5000/open-factory/${artifact.name}@${digest}`;
      await inspectRegistryArtifact({
        name: artifact.name,
        reference,
        origin: `https://${registryHost}`,
        caFile: rootCA,
      });
      published[artifact.name] = reference;
      outputs.push({ path: artifact.state, reference });
      if (artifact.name === "runtime-host") runtimeReference = reference;
    }
    // Copy upstream native manifests unchanged. No rebuilt base image or
    // node Docker graph is shared with a Workspace's private Docker daemon.
    const architecture = await command(["docker", "info", "--format", "{{.Architecture}}"], {
      quiet: true,
    });
    const platform =
      architecture === "aarch64" || architecture === "arm64"
        ? "linux/arm64"
        : architecture === "x86_64" || architecture === "amd64"
          ? "linux/amd64"
          : undefined;
    if (!platform) throw new Error("Starter publication requires a supported native architecture");
    const references: string[] = [];
    for (const [name, image] of [
      ["development", upstream.nodeDevelopment.image],
      ["support", upstream.node.image],
    ] as const) {
      const index = JSON.parse(
        await command(["docker", "buildx", "imagetools", "inspect", "--raw", image], {
          quiet: true,
        }),
      );
      const digest = starterImageManifest(index, platform);
      if (!digest) throw new Error("Starter native image digest missing");
      const nativeImage = `${image.split("@")[0]}@${digest}`;
      const destination = `${registryHost}/open-factory/starter-${name}:local`;
      await command(["docker", "pull", "--platform", platform, nativeImage]);
      await command(["docker", "tag", nativeImage, destination]);
      await command(["docker", "push", "--platform", platform, destination]);
      const localManifest = await command(
        [
          "docker",
          "buildx",
          "imagetools",
          "inspect",
          "--raw",
          `${destination.split(":local")[0]}@${digest}`,
        ],
        { quiet: true },
      );
      if (!localManifest) throw new Error("Published Starter manifest was not confirmed");
      references.push(
        `registry.${namespace}.svc.cluster.local:5000/open-factory/starter-${name}@${digest}`,
      );
    }
    await writeFile(
      starterImagesFile,
      JSON.stringify(
        starterImagesSchema.parse({ platform, development: references[0], support: references[1] }),
      ),
    );
    // Adopt the complete remotely observed generation atomically. Interrupted
    // publication must not combine old and new individual image files.
    await installRuntimeArtifacts(sharedStateDirectory, published);
    for (const output of outputs) await writeFile(output.path, `${output.reference}\n`);
    return runtimeReference;
  } finally {
    forward.kill();
  }
}

async function stopServer() {
  const pid = Number((await readFile(serverPIDFile, "utf8").catch(() => "")).trim());
  if (Number.isSafeInteger(pid) && pid > 0) {
    const command = Bun.spawn(["ps", "eww", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const commandLine = await new Response(command.stdout).text();
    await command.exited;
    if (installation && commandLine) {
      const identity = JSON.parse(await readFile(serverIdentityFile, "utf8")) as {
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
      await rm(serverPIDFile, { force: true });
      return;
    }
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        await rm(serverPIDFile, { force: true });
        return;
      }
      await Bun.sleep(100);
    }
    throw new Error("Existing Factory server did not stop");
  }
}

async function localSecret(path: string) {
  const existing = (await readFile(path, "utf8").catch(() => "")).trim();
  if (existing) {
    await chmod(path, 0o600);
    return existing;
  }
  const value = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return value;
}

async function forgejoExec(arguments_: string[], quiet = false) {
  return command([...composeArguments, "exec", "-T", "forgejo", "forgejo", ...arguments_], {
    quiet,
  });
}

async function ensureForgejo() {
  await ensureForgeAdministrator();
  const username = "factory-mutation";
  const users = await forgejoExec(["admin", "user", "list"], true);
  if (!users.split("\n").some((line) => line.split(/\s+/).includes(username))) {
    await forgejoExec(
      [
        "admin",
        "user",
        "create",
        "--username",
        username,
        "--random-password",
        "--email",
        "factory-mutation@factory.invalid",
        "--must-change-password=false",
      ],
      true,
    );
  }
  let token = (await readFile(forgejoTokenFile, "utf8").catch(() => "")).trim();
  if (token) {
    const probe = await fetch(`${forgejoBaseURL}/api/v1/user`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!probe?.ok) token = "";
  }
  if (!token) {
    token = await forgejoExec(
      [
        "admin",
        "user",
        "generate-access-token",
        "--username",
        username,
        "--token-name",
        `factory-local-${crypto.randomUUID().slice(0, 8)}`,
        "--scopes",
        "write:repository,write:user",
        "--raw",
      ],
      true,
    );
    if (!token) throw new Error("Forgejo returned no mutation token");
    await writeFile(forgejoTokenFile, `${token}\n`, { mode: 0o600 });
  }
  // Distribution startup creates infrastructure identities only. The runtime
  // conformance repository belongs to the source-development installation.
  if (action === "container") return token;
  const authorization = `Bearer ${token}`;
  const repositoryAPI = `${forgejoBaseURL}/api/v1/repos/factory-mutation/runtime-fixture`;
  const starterImages = starterImagesSchema.parse(
    JSON.parse(await readFile(starterImagesFile, "utf8")),
  );
  const fixtureContent = async (path: string) => {
    const content = await readFile(resolve(root, "test/fixtures/runtime-project", path), "utf8");
    return path === ".devcontainer/compose.yaml"
      ? localStarterCompose(content, starterImages)
      : content;
  };
  async function ensureFixtureFile(path: string, message: string) {
    const expected = await fixtureContent(path);
    const endpoint = `${repositoryAPI}/contents/${path}`;
    let missing = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const existing = await fetch(`${endpoint}?ref=main`, { headers: { authorization } });
      if (existing.status === 404) {
        missing = true;
        break;
      }
      if (!existing.ok) throw new Error(`Forgejo fixture lookup failed with ${existing.status}`);
      const value = (await existing.json()) as { content?: string; sha?: string };
      if (!value.content || !value.sha) {
        await Bun.sleep(250);
        continue;
      }
      if (value.content && Buffer.from(value.content, "base64").toString() === expected) return;
      const updateFile = () =>
        fetch(endpoint, {
          method: "PUT",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({
            branch: "main",
            message,
            content: Buffer.from(expected).toString("base64"),
            sha: value.sha,
          }),
        });
      let updated = await updateFile();
      if (updated.status === 403) {
        const removedProtection = await fetch(`${repositoryAPI}/branch_protections/main`, {
          method: "DELETE",
          headers: { authorization },
        });
        if (!removedProtection.ok && removedProtection.status !== 404) {
          throw new Error(
            `Forgejo fixture branch-protection cleanup failed with ${removedProtection.status}`,
          );
        }
        updated = await updateFile();
      }
      if (!updated.ok) throw new Error(`Forgejo fixture update failed with ${updated.status}`);
      return;
    }
    if (!missing) throw new Error("Forgejo fixture content did not settle after repository push");
    const created = await fetch(endpoint, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        message,
        content: Buffer.from(expected).toString("base64"),
      }),
    });
    if (!created.ok) throw new Error(`Forgejo fixture creation failed with ${created.status}`);
  }
  async function ensureFixtureFiles() {
    await ensureFixtureFile(
      ".devcontainer/compose.yaml",
      "Use locally published exact Starter images",
    );
    await ensureFixtureFile(
      ".forgejo/workflows/factory-verification.yml",
      "Update Factory Verification workflow",
    );
    await ensureFixtureFile(".factory/system.json", "Update Factory System Contract");
    await ensureFixtureFile("src/worker.mjs", "Add Factory fixture worker");
  }
  async function ensureLocalFixtureFiles() {
    const destination = resolve(stateDirectory, "runtime-fixture-repository");
    const repository = await stat(resolve(destination, ".git")).catch(() => null);
    if (!repository?.isDirectory()) return;
    const paths = [".factory/system.json", "src/worker.mjs", ".devcontainer/compose.yaml"];
    for (const path of paths) {
      const content = await fixtureContent(path);
      const target = resolve(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const changed = await command(
      ["git", "-C", destination, "status", "--porcelain", "--", ...paths],
      { quiet: true },
    );
    if (!changed) return;
    await command(["git", "-C", destination, "add", "--", ...paths]);
    await command([
      "git",
      "-C",
      destination,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "Update Factory runtime fixture",
      "--",
      ...paths,
    ]);
  }
  const existing = await fetch(repositoryAPI, { headers: { authorization } });
  if (existing.status === 404) {
    const created = await fetch(`${forgejoBaseURL}/api/v1/user/repos`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        name: "runtime-fixture",
        private: false,
        auto_init: false,
        default_branch: "main",
      }),
    });
    if (!created.ok && created.status !== 409) {
      throw new Error(`Forgejo repository bootstrap failed with ${created.status}`);
    }
  } else if (!existing.ok) {
    throw new Error(`Forgejo repository lookup failed with ${existing.status}`);
  }
  const main = await fetch(`${repositoryAPI}/branches/main`, { headers: { authorization } });
  if (main.ok) {
    await ensureFixtureFiles();
    await ensureLocalFixtureFiles();
    return token;
  }
  if (main.status !== 404) throw new Error(`Forgejo main branch lookup failed with ${main.status}`);
  const destination = resolve(stateDirectory, "runtime-fixture-repository");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await command(["cp", "-R", `${resolve(root, "test/fixtures/runtime-project")}/.`, destination]);
  await writeFile(
    resolve(destination, ".devcontainer/compose.yaml"),
    await fixtureContent(".devcontainer/compose.yaml"),
  );
  await command(["git", "init", "--initial-branch=main", destination]);
  await command(["git", "-C", destination, "add", "."]);
  await command([
    "git",
    "-C",
    destination,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "-m",
    "runtime fixture",
  ]);
  await command([
    "git",
    "-C",
    destination,
    "remote",
    "add",
    "origin",
    `${forgejoBaseURL}/factory-mutation/runtime-fixture.git`,
  ]);
  await command(["git", "-C", destination, "push", "origin", "HEAD:main"], {
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
    },
  });
  await ensureFixtureFiles();
  return token;
}

async function ensureForgeAdministrator() {
  const username = "factory-identity-control";
  const users = await forgejoExec(["admin", "user", "list"], true);
  if (!users.split("\n").some((line) => line.split(/\s+/).includes(username)))
    await forgejoExec(
      [
        "admin",
        "user",
        "create",
        "--username",
        username,
        "--random-password",
        "--email",
        `${username}@factory.invalid`,
        "--admin",
        "--must-change-password=false",
      ],
      true,
    );
  const token = (await readFile(forgejoAdminTokenFile, "utf8").catch(() => "")).trim();
  if (token) {
    const probe = await fetch(`${forgejoBaseURL}/api/v1/admin/users?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    if (probe?.ok) return token;
  }
  const created = await forgejoExec(
    [
      "admin",
      "user",
      "generate-access-token",
      "--username",
      username,
      "--token-name",
      `factory-identity-${crypto.randomUUID()}`,
      "--scopes",
      "all",
      "--raw",
    ],
    true,
  );
  if (!created) throw new Error("Forge administrator token is unavailable");
  await writeFile(forgejoAdminTokenFile, `${created}\n`, { mode: 0o600 });
  return created;
}

async function publishedBrowserImage() {
  const artifacts = await publishedRuntimeArtifacts(sharedStateDirectory);
  const browserImage =
    installation?.browserImage ??
    process.env["FACTORY_BROWSER_TOOLS_IMAGE"] ??
    artifacts?.["browser-tools"] ??
    (await readFile(browserImageFile, "utf8")).trim();
  if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(browserImage))
    throw new Error("Published browser tools image is not pinned");
  return browserImage;
}

async function publishedSourceImages() {
  const artifacts = await publishedRuntimeArtifacts(sharedStateDirectory);
  const files =
    process.env["FACTORY_WORKSPACE_FILES_IMAGE"] ??
    artifacts?.["workspace-files"] ??
    (await readFile(sourceFilesImageFile, "utf8")).trim();
  requirePinnedImage(files);
  const editor =
    process.env["FACTORY_DEVELOPER_IDE_IMAGE"] ??
    artifacts?.["developer-ide"] ??
    (await readFile(developerIDEImageFile, "utf8")).trim();
  requirePinnedImage(editor);
  return {
    FACTORY_WORKSPACE_FILES_IMAGE: files,
    FACTORY_DEVELOPER_IDE_IMAGE: editor,
  };
}

async function configuredRuntimeArtifacts(runtimeImage: string) {
  const artifacts = await publishedRuntimeArtifacts(sharedStateDirectory);
  const sourceImages = await publishedSourceImages();
  return runtimeArtifactsSchema.parse({
    "runtime-host": runtimeImage,
    "browser-tools": await publishedBrowserImage(),
    "workspace-files": sourceImages.FACTORY_WORKSPACE_FILES_IMAGE,
    "developer-ide": sourceImages.FACTORY_DEVELOPER_IDE_IMAGE,
    "build-runtime-host":
      process.env["FACTORY_BUILD_RUNTIME_HOST_IMAGE"] ??
      artifacts?.["build-runtime-host"] ??
      (await readFile(buildRuntimeImageFile, "utf8")).trim(),
    "verification-runtime-host":
      process.env["FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE"] ??
      artifacts?.["verification-runtime-host"] ??
      (await readFile(verificationRuntimeImageFile, "utf8")).trim(),
  });
}

async function startServer(
  runtimeImage: string,
  forgejoToken: string | undefined,
  artifacts: RuntimeArtifacts,
) {
  const settings = localServerSettings(
    installation
      ? {
          FACTORY_HOST: process.env["FACTORY_HOST"],
          FACTORY_EXECUTION_RESERVE_TARGET: process.env["FACTORY_EXECUTION_RESERVE_TARGET"],
        }
      : process.env,
    {
      email: installation ? `admin-${installation.name}@factory.local` : "admin@factory.local",
      password: installation
        ? await localSecret(resolve(stateDirectory, "admin-password"))
        : "factory-local-password",
    },
  );
  const authSecret = await localSecret(authSecretFile);
  const startupID = crypto.randomUUID();
  await writeFile(serverLogFile, "", { mode: 0o600 });
  await chmod(serverLogFile, 0o600);
  const server = Bun.spawn(["bun", "apps/factory/src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      FACTORY_RUNTIME_HOST_IMAGE: runtimeImage,
      ...(action === "container" &&
      !runtimeImage.includes("registry.open-factory-envbox-smoke.svc.cluster.local")
        ? {
            FACTORY_REGISTRY_CA_FILE:
              process.env["FACTORY_REGISTRY_CA_FILE"] || "/etc/ssl/certs/ca-certificates.crt",
          }
        : {}),
      ...(process.env["FACTORY_OPENBAO_URL"]
        ? {}
        : await (
            await localOpenBao(
              stateDirectory,
              action === "container" ? composeArguments : undefined,
            )
          ).start()),
      FACTORY_BUILD_RUNTIME_HOST_IMAGE: artifacts["build-runtime-host"],
      FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE: artifacts["verification-runtime-host"],
      FACTORY_BROWSER_TOOLS_IMAGE: artifacts["browser-tools"],
      FACTORY_WORKSPACE_FILES_IMAGE: artifacts["workspace-files"],
      FACTORY_DEVELOPER_IDE_IMAGE: artifacts["developer-ide"],
      FACTORY_HOST: settings.host,
      FACTORY_EXECUTION_RESERVE_TARGET: settings.executionReserveTarget,
      FACTORY_PORT: String(factoryPort),
      FACTORY_BASE_URL: factoryBaseURL,
      FACTORY_WIKI_WEBHOOK_URL:
        process.env["FACTORY_WIKI_WEBHOOK_URL"] ??
        `http://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${factoryPort}`,
      FACTORY_WIKI_WEBHOOK_SECRET: await localSecret(
        resolve(stateDirectory, "wiki-webhook-secret"),
      ),
      FACTORY_AUTH_SECRET: authSecret,
      FACTORY_AUTH_COOKIE_PREFIX: installation
        ? `factory-${installation.name}`
        : action === "container"
          ? `factory-${process.env["COMPOSE_PROJECT_NAME"]}`
          : "factory",
      FACTORY_ADMIN_EMAIL: settings.email,
      FACTORY_ADMIN_PASSWORD: settings.password,
      FACTORY_FORGEJO_API_URL: `${forgejoBaseURL}/api/v1/`,
      FACTORY_FORGEJO_TOKEN: forgejoToken ?? (await readFile(forgejoTokenFile, "utf8")).trim(),
      FACTORY_FORGEJO_OWNER: "factory-mutation",
      FACTORY_FORGEJO_ADMIN_TOKEN: await ensureForgeAdministrator(),
      FACTORY_FORGE_ISSUER_URL: `http://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${factoryPort}/api/auth`,
      FACTORY_FORGE_DISCOVERY_URL: `http://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${factoryPort}/api/auth/.well-known/openid-configuration`,
      FACTORY_ZERO_CACHE_URL: `http://127.0.0.1:${zeroPort}`,
      FACTORY_STARTUP_ID: startupID,
    },
    stdin: "ignore",
    stdout: Bun.file(serverLogFile),
    stderr: Bun.file(serverLogFile),
    detached: action !== "container",
  });
  if (action === "container") {
    foregroundServer = server;
    const stop = () => {
      if (server.exitCode === null) server.kill("SIGTERM");
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } else server.unref();
  await writeFile(serverPIDFile, `${server.pid}\n`);
  await writeFile(serverIdentityFile, JSON.stringify({ pid: server.pid, startupID }), {
    mode: 0o600,
  });
  try {
    await waitForFactory({ server, baseURL: factoryBaseURL, startupID });
    await ensureLocalForgeIdentity({
      factoryURL: factoryBaseURL,
      forgeURL: forgejoBaseURL,
      discoveryURL: `http://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${factoryPort}/api/auth/.well-known/openid-configuration`,
      email: settings.email,
      password: settings.password,
      signingKey: authSecret,
      execute: (args) => forgejoExec(args, true),
      installLogout: () =>
        installForgeBrowserLogout({
          factoryURL: factoryBaseURL,
          execute: (args) =>
            command([...composeArguments, "exec", "-T", "forgejo", ...args], { quiet: true }),
          copy: (source, destination) =>
            command([...composeArguments, "cp", source, `forgejo:${destination}`], { quiet: true }),
        }),
      reload: async () => {
        await command([...composeArguments, "restart", "forgejo"], { quiet: true });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (
            await fetch(`${forgejoBaseURL}/api/healthz`)
              .then((response) => response.ok)
              .catch(() => false)
          )
            return;
          await Bun.sleep(100);
        }
        throw new Error("Forgejo did not become healthy after loading Factory identity");
      },
    });
  } catch (cause) {
    if (server.exitCode === null) server.kill();
    await server.exited;
    await rm(serverPIDFile, { force: true });
    throw new Error(
      `${cause instanceof Error ? cause.message : "Factory startup failed"}. Inspect the protected local log at ${serverLogFile}`,
    );
  }
}

async function startPlanningCache() {
  await command([...composeArguments, "up", "-d", "--wait", "zero-cache"], {
    quiet: Boolean(installation),
  });
}

function announceReady() {
  console.log(`Factory is ready at ${factoryBaseURL}`);
  if (!installation && !process.env["FACTORY_ADMIN_PASSWORD"])
    console.log(
      "Local development bootstrap credentials are in README.md. Configure FACTORY_ADMIN_PASSWORD before first startup for shared access; this never resets an existing password.",
    );
}

async function up() {
  await preflight();
  await ensureLocalMetricsServer(command);
  if (action === "container") {
    const bundle = JSON.parse(await readFile(resolve(root, "runtime-artifacts.json"), "utf8"));
    if (bundle !== null) {
      await requireAvailableRuntimeArtifacts(bundle);
      await installRuntimeArtifacts(sharedStateDirectory, bundle);
    }
  }
  const published = installation ? null : await publishedRuntimeArtifacts(sharedStateDirectory);
  if (action === "container" && !published)
    throw new Error(
      "Use a release Factory image with embedded runtime artifacts, or supply a complete published artifact set in FACTORY_STATE_DIRECTORY",
    );
  if (!installation && !published) await ensureRegistry();
  if (published && action !== "container" && !(await Bun.file(starterImagesFile).exists())) {
    const architecture = await command(["docker", "info", "--format", "{{.Architecture}}"], {
      quiet: true,
    });
    const platform =
      architecture === "arm64" || architecture === "aarch64"
        ? "linux/arm64"
        : architecture === "amd64" || architecture === "x86_64"
          ? "linux/amd64"
          : undefined;
    await writeFile(
      starterImagesFile,
      JSON.stringify(
        starterImagesSchema.parse({
          platform,
          development: upstream.nodeDevelopment.image,
          support: upstream.node.image,
        }),
      ),
      { mode: 0o600 },
    );
  }
  const runtimeImage =
    installation?.runtimeImage ?? published?.["runtime-host"] ?? (await publishRuntimeHost());
  const artifacts = await configuredRuntimeArtifacts(runtimeImage);
  await requireAvailableRuntimeArtifacts(artifacts);
  await completeFactoryStartup({
    checkStorageReady: () =>
      requireWritableRuntimeStorage({
        stateDirectory,
        image: artifacts["workspace-files"],
      }),
    startServer: async () => {
      await command([...composeArguments, "up", "-d", "--wait", "postgres", "forgejo"], {
        quiet: Boolean(installation),
      });
      await command(["bun", "run", "db:migrate"], { quiet: true });
      const forgejoToken = await ensureForgejo();
      if (action !== "container") {
        await command(["bun", "run", "factory:build"], {
          quiet: Boolean(installation),
          env: { NODE_ENV: "production" },
        });
        await stopServer();
      }
      await startServer(runtimeImage, forgejoToken, artifacts);
    },
    startPlanningCache,
    ready: announceReady,
  });
  if (installation)
    console.log(
      `Disposable installation ${installation.name}; credentials are in its protected local state directory`,
    );
}

async function restart() {
  await preflight();
  const runtimeImage =
    installation?.runtimeImage ??
    (await publishedRuntimeArtifacts(sharedStateDirectory))?.["runtime-host"] ??
    (await readFile(runtimeImageFile, "utf8")).trim();
  if (!/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(runtimeImage))
    throw new Error("Published runtime host is not pinned");
  const artifacts = await configuredRuntimeArtifacts(runtimeImage);
  await requireAvailableRuntimeArtifacts(artifacts);
  await completeFactoryStartup({
    checkStorageReady: () =>
      requireWritableRuntimeStorage({
        stateDirectory,
        image: artifacts["workspace-files"],
      }),
    startServer: async () => {
      await command(["bun", "run", "db:migrate"], { quiet: true });
      await stopServer();
      await startServer(runtimeImage, undefined, artifacts);
    },
    startPlanningCache,
    ready: announceReady,
  });
}

async function status() {
  const response = await fetch(`${factoryBaseURL}/api/session`, {
    signal: AbortSignal.timeout(1_000),
  }).catch(() => null);
  const runtimeImage =
    installation?.runtimeImage ??
    (await publishedRuntimeArtifacts(sharedStateDirectory))?.["runtime-host"] ??
    (await readFile(runtimeImageFile, "utf8").catch(() => "not published"));
  console.log(`server: ${response?.ok ? "ready" : "stopped"}`);
  console.log(`runtime host: ${runtimeImage.trim()}`);
  await command([...composeArguments, "ps"]);
}

async function reset() {
  if (installation?.phase === "reset") {
    await validateComposeOwnership(true);
    await validateResetRuntimes();
    console.log("Disposable reset was already confirmed; no deletion was repeated");
    return;
  }
  await resetDisposable({
    installation,
    confirmation,
    data: flags.includes("--data"),
    validate: async () => {
      if (!installation) throw new Error("Disposable installation required");
      await validateComposeOwnership();
      await validateResetRuntimes();
    },
    persistIntent: async () => {
      await saveInstallationPhase("reset-intent");
    },
    stop: stopServer,
    remove: async () => {
      await validateComposeOwnership();
      await validateResetRuntimes();
      await saveInstallationPhase("reset-intent");
      await disposeRuntimeStorageCheck(stateDirectory);
      await command([...composeArguments, "down", "--volumes"], { quiet: true });
      if (await lstat(resolve(stateDirectory, "openbao/identity.json")).catch(() => undefined)) {
        await (await localOpenBao(stateDirectory)).dispose();
      }
      await validateComposeOwnership(true);
    },
    persistOutcome: async () => {
      await saveInstallationPhase("reset");
    },
  });
  console.log(
    `Removed disposable installation ${installation?.name} containers and data volumes. Data deletion is not recoverable; local identity/diagnostics were retained. The developer installation and shared registry were untouched.`,
  );
}

let resetRuntimeNamespaces = installation?.resetRuntimeNamespaces ?? [];
async function validateResetRuntimes() {
  if (!installation) throw new Error("Disposable installation required");
  const containers = (
    await command(["docker", "ps", "--all", "--format", "{{.Names}}"], { quiet: true })
  ).split("\n");
  if (containers.includes(`${composeProject(installation)}-postgres-1`)) {
    const database = createDatabase(1);
    try {
      const pending = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.runtime_attempt WHERE state NOT IN ('stopped', 'failed') LIMIT 1`;
      if (pending.length)
        throw new Error("Reset refused: stop pending/active runtimes through Factory first");
      const namespaces = await database.client<Array<{ namespace: string }>>`
        SELECT kubernetes_namespace AS namespace FROM factory.runtime_attempt
        UNION SELECT kubernetes_namespace AS namespace FROM factory.development_workspace
      `;
      resetRuntimeNamespaces = namespaces.map((value) => value.namespace);
    } finally {
      await database.client.end();
    }
  } else if (installation.phase === "active") {
    throw new Error(
      "Reset cannot confirm product ownership without its disposable database or a persisted reset intent",
    );
  }
  await requireRuntimeNamespacesAbsent(resetRuntimeNamespaces, async (candidate) => {
    const existing = await kubectl(
      ["get", "namespace", candidate, "--ignore-not-found", "-o", "name"],
      undefined,
      true,
    );
    return Boolean(existing);
  });
}

async function saveInstallationPhase(phase: "reset-intent" | "reset") {
  if (!installation) throw new Error("Disposable installation required");
  await writeFile(
    resolve(stateDirectory, "installation.next.json"),
    `${JSON.stringify({ ...installation, phase, resetRuntimeNamespaces })}\n`,
    { mode: 0o600 },
  );
  await rename(
    resolve(stateDirectory, "installation.next.json"),
    resolve(stateDirectory, "installation.json"),
  );
}

async function validateComposeOwnership(expectAbsent = false) {
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

async function configureInstallation() {
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

await mkdir(stateDirectory, { recursive: true });
if (action === "container") {
  await requireContainerState(stateDirectory, process.env["COMPOSE_PROJECT_NAME"]);
  // This private state is mounted at its exact host path, also used by Docker
  // for the OpenBao configuration mount. Never mount the host source repository.
  await chmod(stateDirectory, 0o700);
  process.env["CAROOT"] = resolve(stateDirectory, "ca");
  process.env["FACTORY_LOCAL_DB_PASSWORD"] = await localSecret(
    resolve(stateDirectory, "database-password"),
  );
  process.env["FACTORY_LOCAL_ZERO_PASSWORD"] = await localSecret(
    resolve(stateDirectory, "zero-password"),
  );
  process.env["FACTORY_ADMIN_PASSWORD"] ||= await localSecret(
    resolve(stateDirectory, "admin-password"),
  );
  if (!process.env["FACTORY_ADMIN_EMAIL"]) delete process.env["FACTORY_ADMIN_EMAIL"];
  if (!process.env["FACTORY_HOST"]) delete process.env["FACTORY_HOST"];
  process.env["DATABASE_URL"] =
    `postgresql://factory:${process.env["FACTORY_LOCAL_DB_PASSWORD"]}@127.0.0.1:${process.env["FACTORY_LOCAL_POSTGRES_PORT"] || 57432}/factory`;
}
const lockFile = resolve(stateDirectory, "operation.lock");
const lock =
  action === "container"
    ? null
    : await open(lockFile, "wx", 0o600).catch(() => {
        throw new Error(
          "Another Factory operation owns this installation; inspect its operation.lock before retrying",
        );
      });
try {
  await lock?.writeFile(String(process.pid));
  await configureInstallation();
  if (action === "up" || action === "container") await up();
  else if (action === "publish-runtime") {
    await requireRegistryStorage();
    await kubectl(["get", "service/registry", "-n", namespace], undefined, true);
    await publishRuntimeHost();
    console.log(
      "Published exact execution, browser and independent source artifacts; Factory and existing runtimes unchanged",
    );
  } else if (action === "restart") await restart();
  else if (action === "status") await status();
  else if (action === "reset") await reset();
} catch (cause) {
  if (foregroundServer?.exitCode === null) {
    foregroundServer.kill("SIGTERM");
    await foregroundServer.exited;
  }
  throw cause;
} finally {
  if (lock) {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}
// Release the startup-operation lock before serving. Docker owns the long-lived
// foreground process; PID 1 forwards Stop and the child exit is observable.
if (action === "container" && foregroundServer) process.exitCode = await foregroundServer.exited;
