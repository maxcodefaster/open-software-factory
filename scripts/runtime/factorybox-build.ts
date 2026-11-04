import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { factoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";

const artifact = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[a-f0-9]{32}$`));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const factoryboxBuildRequest = z
  .strictObject({
    repository: z.string().refine(isAbsolute, "Factorybox repository must use an absolute path"),
    commit: z.string().regex(/^[a-f0-9]{40}$/, "Factorybox build requires an exact 40-hex commit"),
    upstreamVersion: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "Factorybox build requires an upstream version"),
    platform: z.enum(["linux/arm64", "linux/amd64"]),
    nativeBaseBuild: artifact("factorybox-build-native-base-"),
    sysboxBuild: artifact("factorybox-build-sysbox-").optional(),
    retainedCandidate: artifact("factorybox-build-criu-retained-").optional(),
    builder: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
    boundedBuild: z.boolean().default(true),
    network: z.enum(["default", "host"]).default("default"),
    dockerContext: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    nodeName: factoryboxRuntimeProfile.shape.nodeName,
    kernel: factoryboxRuntimeProfile.shape.kernel,
  })
  .refine((request) => !request.boundedBuild || request.sysboxBuild || request.builder, {
    message: "A bounded component build requires an explicit builder or completed Sysbox build",
  });
type BuildRequest = z.infer<typeof factoryboxBuildRequest>;
const buildReceipt = z.object({
  schema: z.literal(1),
  passed: z.literal(true),
  platform: z.enum(["linux/arm64", "linux/amd64"]),
  worker_build: artifact("factorybox-build-worker-"),
  image: factoryboxRuntimeProfile.shape.image,
  executable_sha256: digest,
  native_lifecycle_qualified: z.literal(false),
  production_qualified: z.literal(false),
});

export function factoryboxBuildCommand(request: BuildRequest) {
  return [
    "mise",
    "exec",
    "--",
    "python3",
    "tools/build_worker_pipeline.py",
    "--platform",
    request.platform,
    "--native-base-build",
    request.nativeBaseBuild,
    "--network",
    request.network,
    ...(request.sysboxBuild ? ["--sysbox-build", request.sysboxBuild] : []),
    ...(request.retainedCandidate ? ["--retained-candidate", request.retainedCandidate] : []),
    ...(request.builder ? ["--builder", request.builder] : []),
    ...(request.boundedBuild ? ["--bounded-build"] : []),
  ];
}

export function factoryboxBuildCandidate(request: BuildRequest, value: unknown) {
  const receipt = buildReceipt.parse(value);
  if (receipt.platform !== request.platform)
    throw new Error("Factorybox build target differs from the requested architecture");
  return {
    receipt,
    profile: factoryboxRuntimeProfile.parse({
      image: receipt.image,
      executableSHA256: receipt.executable_sha256,
      filesystemLayout: 2,
      architecture: request.platform.split("/")[1],
      nodeName: request.nodeName,
      kernel: request.kernel,
      boundedBytes: 64 * 1024 ** 3,
      minimumBoundedBytes: 8 * 1024 ** 3,
      claimGiB: 128,
    }),
  };
}

async function readJSON(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 ** 2)
      throw new Error("Expected one bounded regular JSON file");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

async function saveNew(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

const allowedEnvironment = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "DOCKER_CONFIG",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

// The build tool receives only what mise, Docker and Go need, never ambient credentials.
export function factoryboxBuildEnvironment(
  dockerContext: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && (allowedEnvironment.has(name) || name.startsWith("MISE_")))
      environment[name] = value;
  return {
    ...environment,
    FACTORYBOX_DOCKER_CONTEXT: dockerContext,
    FACTORYBOX_DOCKER_ELEVATION: "",
  };
}

async function run(args: string[], cwd: string, dockerContext: string) {
  const child = Bun.spawn(args, {
    cwd,
    env: factoryboxBuildEnvironment(dockerContext),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

type Ports = { run: typeof run };

// Refuse to build from anything but the exact requested commit with no local changes.
export async function verifyFactoryboxSource(request: BuildRequest, ports: Ports) {
  const git = (...args: string[]) =>
    ports.run(
      ["git", "-C", request.repository, ...args],
      request.repository,
      request.dockerContext,
    );
  const head = await git("rev-parse", "HEAD");
  if (head.exitCode !== 0) throw new Error("Cannot read the Factorybox repository commit");
  const observed = head.stdout.trim();
  if (observed !== request.commit)
    throw new Error(
      `Factorybox repository is at ${observed}, not the requested commit ${request.commit}`,
    );
  const status = await git("status", "--porcelain", "--untracked-files=all");
  if (status.exitCode !== 0) throw new Error("Cannot read the Factorybox repository state");
  if (status.stdout.trim() !== "")
    throw new Error(
      "Factorybox repository has uncommitted or untracked changes; refusing to build",
    );
  return { repository: request.repository, commit: observed, treeClean: true as const };
}

async function toolVersions(request: BuildRequest, ports: Ports) {
  const probe = async (args: string[]) => {
    const result = await ports
      .run(args, request.repository, request.dockerContext)
      .catch(() => null);
    return result?.exitCode === 0 ? result.stdout.trim() || result.stderr.trim() : "unavailable";
  };
  return {
    bun: Bun.version,
    git: await probe(["git", "--version"]),
    mise: await probe(["mise", "--version"]),
    python3: await probe(["mise", "exec", "--", "python3", "--version"]),
    docker: await probe([
      "docker",
      "--context",
      request.dockerContext,
      "version",
      "--format",
      "client {{.Client.Version}} server {{.Server.Version}}",
    ]),
  };
}

export async function main(args: string[], ports: Ports = { run }) {
  if (args.length !== 1 || !args[0]) throw new Error("Usage: factorybox:build REQUEST_JSON");
  const request = factoryboxBuildRequest.parse(await readJSON(args[0]));
  request.repository = await realpath(request.repository);
  const root = resolve(import.meta.dir, "../..");
  const parent = resolve(root, ".factory/test-results");
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(resolve(parent, "factorybox-build-"));
  const command = factoryboxBuildCommand(request);
  // Record intent before any external build. Nothing here selects an installed profile.
  await saveNew(resolve(evidence, "intent.json"), { request, command });
  console.log(JSON.stringify({ building: evidence }));
  const source = await verifyFactoryboxSource(request, ports);
  const startedAt = new Date().toISOString();
  const tools = await toolVersions(request, ports);
  const built = await ports.run(command, request.repository, request.dockerContext);
  const finishedAt = new Date().toISOString();
  await saveNew(resolve(evidence, "build.json"), built);
  if (built.exitCode !== 0) throw new Error(`Factorybox build failed; inspect ${evidence}`);
  const after = await ports.run(
    ["git", "-C", request.repository, "rev-parse", "HEAD"],
    request.repository,
    request.dockerContext,
  );
  if (after.exitCode !== 0 || after.stdout.trim() !== request.commit)
    throw new Error("Factorybox repository changed during the build");
  const provenance = {
    ...source,
    upstreamVersion: request.upstreamVersion,
    tools,
    startedAt,
    finishedAt,
  };
  await saveNew(resolve(evidence, "provenance.json"), provenance);
  let last: unknown;
  for (const line of built.stdout.trim().split("\n").reverse()) {
    try {
      last = JSON.parse(line);
      break;
    } catch {}
  }
  const candidate = factoryboxBuildCandidate(request, last);
  const docker = ["docker", "--context", request.dockerContext];
  const inspect = await ports.run(
    [...docker, "image", "inspect", candidate.profile.image],
    root,
    request.dockerContext,
  );
  await saveNew(resolve(evidence, "image.json"), inspect);
  if (inspect.exitCode !== 0) throw new Error("Built Factorybox image is unavailable");
  const [image] = JSON.parse(inspect.stdout);
  if (image.Os !== "linux" || image.Architecture !== candidate.profile.architecture)
    throw new Error("Built Factorybox image has a different architecture");
  const probe = async (entrypoint: string, trailing: string[]) =>
    ports.run(
      [
        ...docker,
        "run",
        "--rm",
        "--pull=never",
        "--name",
        `factorybox-build-probe-${crypto.randomUUID()}`,
        "--label",
        `io.factory.build-evidence=${evidence}`,
        "--cpus=1",
        "--memory=128m",
        "--pids-limit=32",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `--platform=${request.platform}`,
        "--entrypoint",
        entrypoint,
        candidate.profile.image,
        ...trailing,
      ],
      root,
      request.dockerContext,
    );
  const hash = await probe("/usr/bin/sha256sum", ["/opt/factorybox/factorybox"]);
  await saveNew(resolve(evidence, "executable.json"), hash);
  if (
    hash.exitCode !== 0 ||
    hash.stdout.trim() !== `${candidate.profile.executableSHA256}  /opt/factorybox/factorybox`
  )
    throw new Error("Factorybox image executable differs from its build receipt");
  const host = await ports.run(
    [...docker, "info", "--format", "{{json .}}"],
    root,
    request.dockerContext,
  );
  if (host.exitCode !== 0) throw new Error("Cannot observe the Docker host architecture");
  const info = JSON.parse(host.stdout);
  const machines =
    candidate.profile.architecture === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"];
  const nativeHost = info.OSType === "linux" && machines.includes(info.Architecture);
  const doctor = nativeHost ? await probe("/opt/factorybox/factorybox", ["doctor"]) : null;
  await saveNew(resolve(evidence, "doctor.json"), { nativeHost, host: info, result: doctor });
  if (doctor?.exitCode === 0) {
    const observed = JSON.parse(doctor.stdout).platform;
    if (
      observed?.os !== "linux" ||
      observed.architecture !== candidate.profile.architecture ||
      observed.page_size !== 4096 ||
      observed.kernel !== request.kernel
    )
      throw new Error("Factorybox doctor differs from the requested native worker profile");
  }
  // A successful build or doctor is not a lifecycle proof. Preserve the installed profile.
  await saveNew(resolve(evidence, "profile.candidate.json"), candidate.profile);
  const result = {
    passed: true,
    image: candidate.profile.image,
    executableSHA256: candidate.profile.executableSHA256,
    architecture: candidate.profile.architecture,
    workerBuild: candidate.receipt.worker_build,
    nativeHost,
    platformMatches: doctor?.exitCode === 0,
    nativeLifecycleQualified: false,
    installed: false,
    provenance,
    evidence,
  };
  await saveNew(resolve(evidence, "result.json"), result);
  console.log(JSON.stringify(result));
  return result;
}

if (import.meta.main) await main(process.argv.slice(2));
