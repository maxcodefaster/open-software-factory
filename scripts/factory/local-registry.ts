// Local startup preflight, cluster registry provisioning, and runtime artifact publication.
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { kubernetesCommand } from "#runtime-kubernetes/config";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import upstream from "../../upstream.json";
import { inspectRegistryArtifact, requireAvailableRuntimeArtifacts } from "./artifact-availability";
import { installRuntimeArtifacts, publishedRuntimeArtifacts } from "./artifacts";
import { type LocalFactoryContext, validateComposeOwnership } from "./local-context";
import {
  requireNativeBrowserImage,
  requireNativeForgeOrigin,
  requireNativeInstallation,
  requireNativeStarterImages,
} from "./native-installation";
import { requireComposePins, requireModelConfiguration, requirePinnedImage } from "./preflight";
import { waitForRegistry } from "./registry-readiness";
import { requireSafeRegistryStorage } from "./registry-storage";
import { publishRuntimeImage } from "./runtime-publication";
import { requireStarterImageConfiguration } from "./starter-images";

export async function preflight(ctx: LocalFactoryContext) {
  const {
    action,
    sharedStateDirectory,
    installation,
    namespace,
    composeArguments,
    command,
    kubectl,
  } = ctx;
  if (process.platform === "linux" && !process.env["FACTORY_RUNTIME_HOST"])
    throw new Error(
      "Set FACTORY_RUNTIME_HOST to this host's address reachable from Kubernetes Pods",
    );
  if (Bun.version !== "1.4.5") throw new Error("Factory startup requires Bun 1.4.5");
  const nativeConfiguration = requireNativeInstallation();
  if (process.env["FACTORY_STARTER_IMAGES"])
    process.env["FACTORY_STARTER_IMAGES"] = JSON.stringify(requireNativeStarterImages());
  requireNativeForgeOrigin(process.env, nativeConfiguration);
  if (action === "publish-runtime" || !(await publishedRuntimeArtifacts(sharedStateDirectory)))
    requireNativeBrowserImage(process.env);
  for (const value of [upstream.docker.image, upstream.nodeDevelopment.image])
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
    await validateComposeOwnership(ctx);
  }
  console.log(
    "Startup prerequisites and exact pins passed; sensitive configuration was not printed",
  );
}

export async function requireRegistryStorage(ctx: LocalFactoryContext) {
  const { namespace, kubectl } = ctx;
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

export async function ensureRegistry(ctx: LocalFactoryContext) {
  const { namespace, stateDirectory, command, kubectl } = ctx;
  await requireRegistryStorage(ctx);
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

export async function publishRuntimeHost(ctx: LocalFactoryContext) {
  const { root, namespace, stateDirectory, sharedStateDirectory, command } = ctx;
  const nativeBrowserImage = requireNativeBrowserImage(process.env);
  const starterPlatform =
    `linux/${nativeRuntimeArchitecture(requireNativeInstallation().runtime)}` as const;
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const registryPort = reservation.port;
  const registryHost = `registry.localhost:${registryPort}`;
  await reservation.stop(true);
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
    const published: Record<string, string> = {};
    const specs = [
      {
        name: "runtime-host",
        repository: `${registryHost}/open-factory/runtime-host`,
        metadata: resolve(stateDirectory, "runtime-host-metadata.json"),
        dockerfile: "deploy/runtime-host/Dockerfile",
        target: "runtime-host",
      },
      {
        name: "developer-ide",
        repository: `${registryHost}/open-factory/developer-ide`,
        metadata: resolve(sharedStateDirectory, "developer-ide-metadata.json"),
        dockerfile: "deploy/runtime-host/Dockerfile",
        target: "developer-ide",
      },
      {
        name: "starter-work",
        repository: `${registryHost}/open-factory/starter-work`,
        metadata: resolve(sharedStateDirectory, "starter-work-metadata.json"),
        dockerfile: "templates/starter-app/.factory/images/work/Dockerfile",
        target: undefined,
        platform: starterPlatform,
      },
      {
        name: "starter-postgres",
        repository: `${registryHost}/open-factory/starter-postgres`,
        metadata: resolve(sharedStateDirectory, "starter-postgres-metadata.json"),
        dockerfile: "templates/starter-app/.factory/images/postgres/Dockerfile",
        target: undefined,
        platform: starterPlatform,
      },
    ];
    for (const artifact of specs) {
      await publishRuntimeImage(artifact, command);
      if (artifact.name === "starter-work" || artifact.name === "starter-postgres") {
        const [image] = JSON.parse(
          await command(["docker", "image", "inspect", `${artifact.repository}:local`], {
            quiet: true,
          }),
        );
        requireStarterImageConfiguration(image, artifact.name, starterPlatform);
      }
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
    }
    // Adopt the complete remotely observed generation atomically.
    published["substrate-runtime"] = requireNativeInstallation().workloadImage;
    published["browser-tools"] = nativeBrowserImage;
    await requireAvailableRuntimeArtifacts(published);
    return installRuntimeArtifacts(sharedStateDirectory, published);
  } finally {
    forward.kill();
  }
}

export async function runPublishRuntime(ctx: LocalFactoryContext) {
  await requireRegistryStorage(ctx);
  await ctx.kubectl(["get", "service/registry", "-n", ctx.namespace], undefined, true);
  await publishRuntimeHost(ctx);
  console.log(
    "Published the complete runtime artifact bundle; Factory and existing runtimes unchanged",
  );
}
