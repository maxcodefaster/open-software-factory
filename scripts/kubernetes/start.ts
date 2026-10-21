import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { finishInstallationMaintenance } from "../../apps/factory/src/installation/maintenance";
import { createDatabase } from "../../packages/db/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { serviceAccountConfiguration } from "../../packages/runtime-kubernetes/src/service-account";
import { runtimeVolumeClaimSpec } from "../../packages/runtime-kubernetes/src/storage";
import { runtimeArtifactsSchema } from "../factory/artifacts";
import { ensureLocalForgeIdentity } from "../factory/forge-identity";
import { installForgeBrowserLogout } from "../factory/forge-logout";
import { waitForFactory } from "../factory/readiness";
import { requireWritableRuntimeStorage } from "../factory/storage-readiness";
import { bootstrapOpenBao } from "../factory/openbao-bootstrap";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configure ${name} before Kubernetes startup`);
  return value;
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function waitHTTP(url: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    const ready = response?.ok;
    await response?.body?.cancel();
    if (ready) return;
    await Bun.sleep(500);
  }
  throw new Error(`Service at ${new URL(url).origin} did not become ready`);
}

async function execute(args: readonly string[], input?: string) {
  const result = await runCommand(kubernetesCommand(args), input, {
    timeoutMS: 60_000,
    outputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw new Error("Kubernetes bootstrap operation failed; sensitive diagnostics suppressed");
  return result.stdout.trim();
}

const directory = required("FACTORY_STATE_DIRECTORY");
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
if ((await realpath(directory)) !== resolve(directory))
  throw new Error("Factory state must not be redirected");
await rm(resolve(directory, "kubernetes-ready.json"), { force: true });
const connectionDirectory = "/tmp/factory-kubernetes";
await mkdir(connectionDirectory, { recursive: true, mode: 0o700 });
const kubeconfig = resolve(connectionDirectory, "config.json");
await writeFile(kubeconfig, JSON.stringify(serviceAccountConfiguration()), { mode: 0o600 });
if (required("KUBECONFIG") !== kubeconfig || required("FACTORY_KUBERNETES_CONTEXT") !== "factory")
  throw new Error("Use the chart's projected ServiceAccount connection configuration");
runtimeVolumeClaimSpec();
const namespace = required("FACTORY_NAMESPACE");
const release = required("FACTORY_HELM_RELEASE");
const forgePod = required("FACTORY_FORGEJO_POD");
if (![namespace, release, forgePod].every((value) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)))
  throw new Error("Invalid Kubernetes installation identity");
const factoryURL = required("FACTORY_BASE_URL");
const internalURL = required("FACTORY_INTERNAL_URL");
const forgeURL = required("FACTORY_FORGEJO_PUBLIC_URL");
const apiURL = required("FACTORY_FORGEJO_API_URL");
const identity = {
  namespace,
  release,
  factoryURL,
  forgeURL,
  storageClass: process.env["FACTORY_STORAGE_CLASS"] ?? "",
};
const identityFile = resolve(directory, "kubernetes-installation.json");
const previousIdentity = await readFile(identityFile, "utf8").catch(
  (cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  },
);
if (previousIdentity === null)
  await writeFile(identityFile, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
else if (previousIdentity !== JSON.stringify(identity))
  throw new Error("Kubernetes installation identity changed; retained state was not adopted");

const artifacts = runtimeArtifactsSchema.parse(
  JSON.parse(await readFile(resolve("runtime-artifacts.json"), "utf8")),
);
const roleVariables = {
  "runtime-host": "FACTORY_RUNTIME_HOST_IMAGE",
  "build-runtime-host": "FACTORY_BUILD_RUNTIME_HOST_IMAGE",
  "verification-runtime-host": "FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE",
  "browser-tools": "FACTORY_BROWSER_TOOLS_IMAGE",
  "workspace-files": "FACTORY_WORKSPACE_FILES_IMAGE",
  "developer-ide": "FACTORY_DEVELOPER_IDE_IMAGE",
} as const;
const runtimeEnvironment = Object.fromEntries(
  Object.entries(roleVariables).map(([role, variable]) => [
    variable,
    artifacts[role as keyof typeof roleVariables],
  ]),
);

console.log("Checking the installation's actual writable runtime storage");
await requireWritableRuntimeStorage({
  stateDirectory: directory,
  image: artifacts["workspace-files"],
});
console.log("Preparing encrypted secrets and retained data services");
const openbao = await bootstrapOpenBao({
  directory: resolve(directory, "openbao"),
  address: required("FACTORY_OPENBAO_URL"),
  caFile: required("FACTORY_OPENBAO_CA_FILE"),
});
const migrated = Bun.spawn([process.execPath, "packages/db/src/migrate.ts"], {
  env: process.env,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
if ((await migrated.exited) !== 0)
  throw new Error("Database migration failed; retained data was preserved");
await waitHTTP(new URL("/api/healthz", apiURL).href);

async function observedForgePod() {
  const pod = z
    .object({
      metadata: z.object({
        uid: z.string(),
        labels: z.record(z.string(), z.string()),
      }),
    })
    .parse(JSON.parse(await execute(["get", "pod", forgePod, "-n", namespace, "-o", "json"])));
  if (
    pod.metadata.labels["app.kubernetes.io/instance"] !== release ||
    pod.metadata.labels["app.kubernetes.io/component"] !== "forgejo"
  )
    throw new Error("Forgejo bootstrap refused a Pod outside this installation");
  return pod;
}
async function shell(script: string) {
  await observedForgePod();
  return execute(
    ["exec", "-i", forgePod, "-n", namespace, "-c", "forgejo", "--", "sh", "-s"],
    `set -eu\n${script}\n`,
  );
}
const forge = (args: string[]) => shell(`exec forgejo ${args.map(quote).join(" ")}`);
const users = (await forge(["admin", "user", "list"]))
  .split("\n")
  .map((line) => line.trim().split(/\s+/));
let forgejoToken = "";
let forgejoAdminToken = "";
for (const [username, admin] of [
  ["factory-mutation", false],
  ["factory-identity-control", true],
] as const) {
  if (!users.some((columns) => columns.includes(username)))
    await forge([
      "admin",
      "user",
      "create",
      "--username",
      username,
      "--random-password",
      "--email",
      `${username}@factory.invalid`,
      "--must-change-password=false",
      ...(admin ? ["--admin"] : []),
    ]);
  const file = `/var/lib/gitea/factory-bootstrap/${username}`;
  const args = [
    "admin",
    "user",
    "generate-access-token",
    "--username",
    username,
    "--token-name",
    "factory-kubernetes",
    "--scopes",
    admin ? "all" : "write:repository,write:user",
    "--raw",
  ];
  // The native container writes its credential before acknowledgement. A lost
  // exec response is recovered from that file, never another token creation.
  const token = await shell(`umask 077
mkdir -p /var/lib/gitea/factory-bootstrap
if test ! -s ${quote(file)}; then
  if test -s ${quote(`${file}.pending`)}; then
    mv ${quote(`${file}.pending`)} ${quote(file)}
  else
    test ! -e ${quote(`${file}.intended`)} || { echo 'Token creation is unconfirmed' >&2; exit 1; }
    : > ${quote(`${file}.intended`)}
    forgejo ${args.map(quote).join(" ")} > ${quote(`${file}.pending`)}
    test -s ${quote(`${file}.pending`)}
    mv ${quote(`${file}.pending`)} ${quote(file)}
  fi
fi
cat ${quote(file)}`);
  if (!/^[a-zA-Z0-9_-]{20,256}$/.test(token))
    throw new Error("Forgejo did not confirm a valid retained service token");
  if (admin) forgejoAdminToken = token;
  else forgejoToken = token;
}
const startupID = crypto.randomUUID();
// Recreate and the state-directory lock have retired the old application.
// Public traffic remains excluded until this startup's readiness marker exists.
const database = createDatabase(1);
try {
  await finishInstallationMaintenance(database);
} finally {
  await database.client.end();
}
const child = Bun.spawn([process.execPath, "apps/factory/src/server.ts"], {
  env: {
    ...process.env,
    ...runtimeEnvironment,
    FACTORY_OPENBAO_TOKEN_FILE: openbao.tokenFile,
    FACTORY_OPENBAO_MOUNT: "factory",
    FACTORY_WIKI_WEBHOOK_URL: internalURL,
    FACTORY_FORGEJO_TOKEN: forgejoToken,
    FACTORY_FORGEJO_ADMIN_TOKEN: forgejoAdminToken,
    FACTORY_STARTUP_ID: startupID,
  },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => {
  if (child.exitCode === null) child.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const loopback = `http://127.0.0.1:${process.env["FACTORY_PORT"] ?? "3000"}`;
  await waitForFactory({ server: child, baseURL: loopback, startupID });
  const sourceFile = resolve(directory, "forge-identity.json");
  const retainedSource = await readFile(sourceFile, "utf8").catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    },
  );
  const configured = await ensureLocalForgeIdentity({
    factoryURL,
    transportURL: loopback,
    forgeURL,
    discoveryURL: required("FACTORY_FORGE_DISCOVERY_URL"),
    email: required("FACTORY_ADMIN_EMAIL"),
    password: required("FACTORY_ADMIN_PASSWORD"),
    signingKey: required("FACTORY_AUTH_SECRET"),
    ...(retainedSource
      ? {
          retainedSourceID: z
            .object({ sourceID: z.number().int().positive() })
            .parse(JSON.parse(retainedSource)).sourceID,
        }
      : {}),
    execute: forge,
    reload: async () => {
      const previous = await observedForgePod();
      await execute(
        ["delete", "--raw", `/api/v1/namespaces/${namespace}/pods/${forgePod}`, "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: previous.metadata.uid },
        }),
      );
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const current = await observedForgePod().catch(() => null);
        if (current && current.metadata.uid !== previous.metadata.uid) {
          await waitHTTP(new URL("/api/healthz", apiURL).href);
          return;
        }
        await Bun.sleep(500);
      }
      throw new Error("Forgejo did not confirm its owned identity reload");
    },
    installLogout: () =>
      installForgeBrowserLogout({
        factoryURL,
        execute: (args) => shell(args.map(quote).join(" ")),
        copy: async (source, destination) => {
          await shell(
            `printf '%s' ${quote(await readFile(source, "utf8"))} > ${quote(destination)}`,
          );
        },
      }),
  });
  await writeFile(sourceFile, JSON.stringify(configured), { mode: 0o600 });
  await waitHTTP(new URL("/keepalive", required("FACTORY_ZERO_CACHE_URL")).href);
  await writeFile(resolve(directory, "kubernetes-ready.json"), JSON.stringify({ startupID }), {
    mode: 0o600,
  });
  console.log("Factory Kubernetes installation is ready");
  process.exitCode = await child.exited;
} finally {
  await rm(resolve(directory, "kubernetes-ready.json"), { force: true });
  stop();
  await child.exited;
}
