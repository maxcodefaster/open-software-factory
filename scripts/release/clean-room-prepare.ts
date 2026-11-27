// Shared run context and pre-installation validation stages for clean-room qualification.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  type Cluster,
  type Output,
  type RunOptions,
  removeCleanRoomContainer,
} from "./clean-room-cluster";
import {
  type Check,
  capacityVerdict,
  cleanRoomValues,
  controlPlaneRequests,
  deepMerge,
  imageKind,
  type Options,
  packageVersion,
  parseChartArgument,
  pinning,
  type Receipt,
  redact,
  releaseName,
  requireNativeChart,
  totalMiB,
  type Values,
} from "./clean-room-model";
import { prepareNativeCleanRoom, requireFreshNativeIngress } from "./clean-room-native";
import { packageFactoryChart } from "./package-chart";

export class StepFailed extends Error {}

export type CleanRoomRunContext = {
  root: string;
  id: string;
  namespace: string;
  context: string;
  startedAt: Date;
  options: Options;
  cl: Cluster;
  outputDirectory: string;
  temp: string;
  receipt: Receipt;
  secrets: string[];
  signal: AbortSignal;
  kubectl: (args: string[], options?: RunOptions) => Promise<Output>;
  json: (args: string[]) => Promise<Record<string, unknown> & { items?: unknown[] }>;
  liveRun: (args: string[], options?: RunOptions) => Promise<Output>;
  log: (message: string) => void;
  persist: () => Promise<void>;
  timed: <T>(label: string, work: () => Promise<T>) => Promise<T>;
  record: (check: Check) => void;
  // Mutable stage outputs populated sequentially across phases.
  created: boolean;
  preserveTemp: boolean;
  chartImage: string | undefined;
  chartTarget: string;
  versionArgs: string[];
  defaults: Values;
  valuesFile: string;
  nodeName: string | undefined;
  origin: string;
  adminPassword: string;
  adminEmail: string;
  native: Awaited<ReturnType<typeof prepareNativeCleanRoom>> | undefined;
  publicCA: string | undefined;
};

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function validateNativeInputsStage(ctx: CleanRoomRunContext) {
  ctx.native = await prepareNativeCleanRoom(ctx.options.nativeFixture, ctx.namespace, releaseName, {
    signal: ctx.signal,
  });
  ctx.secrets.push(...ctx.native.redactions);
  ctx.receipt.native = ctx.native.metadata;
  return `Fresh native identity and separate provisioner credential validated; ${ctx.native.metadata.tlsMode === "managed" ? "chart-managed TLS selected" : "external TLS bundle validated"}; no cluster resource created`;
}

export async function checkToolsStage(ctx: CleanRoomRunContext) {
  const helmVersion = (
    await ctx.liveRun(["helm", "version", "--template", "{{.Version}}"])
  ).stdout.trim();
  const kubectlClient = JSON.parse(
    (await ctx.liveRun(["kubectl", "version", "--client", "-o", "json"])).stdout,
  ).clientVersion.gitVersion as string;
  const server = await ctx.liveRun(["kubectl", "--context", ctx.context, "version", "-o", "json"], {
    allowFailure: true,
  });
  const serverVersion =
    server.code === 0
      ? ((JSON.parse(server.stdout).serverVersion?.gitVersion as string | undefined) ?? "")
      : "";
  if (!serverVersion) throw new Error(`Cannot reach the cluster of context ${ctx.context}`);
  ctx.receipt.tools = {
    helm: helmVersion,
    kubectl: kubectlClient,
    kubernetes: serverVersion,
    bun: Bun.version,
  };
  return `context ${ctx.context}; helm ${helmVersion}, kubectl ${kubectlClient}, Kubernetes ${serverVersion}`;
}

export async function prepareChartStage(ctx: CleanRoomRunContext) {
  const { options, id, temp, receipt } = ctx;
  const source = parseChartArgument(options.chart);
  let sourceLabel: string = source.kind;
  let sum = "";
  if (source.kind === "working-tree") {
    if (!options.factoryImage) throw new Error("Packaging the working tree needs --factory-image");
    const version = packageVersion(id);
    const directory = join(temp, "package");
    await mkdir(directory);
    if (imageKind(options.factoryImage) !== "digest")
      throw new Error("Native chart packaging requires the immutable Factory image digest");
    const catalogContainer = `factory-cleanroom-artifacts-${id}`;
    receipt.images["catalogContainer"] = { name: catalogContainer, owner: id };
    await ctx.persist();
    const catalog = await ctx
      .liveRun([
        "docker",
        "run",
        "--rm",
        "--name",
        catalogContainer,
        "--label",
        `factory.clean-room-owner=${id}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--user",
        "1000:1000",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp",
        "--entrypoint",
        "bun",
        options.factoryImage,
        "-e",
        'process.stdout.write(await Bun.file("/opt/factory/runtime-artifacts.json").text())',
      ])
      .then(
        (output) => ({ output }),
        (error: unknown) => ({ error }),
      );
    await removeCleanRoomContainer(catalogContainer, id);
    receipt.images["catalogContainerRemoved"] = true;
    if ("error" in catalog) throw catalog.error;
    ctx.chartTarget = (
      await packageFactoryChart({
        version,
        factoryImage: options.factoryImage,
        output: directory,
        artifacts: JSON.parse(catalog.output.stdout),
      })
    ).chart;
    sum = await sha256(ctx.chartTarget);
    sourceLabel = "working-tree (packaged by this run)";
  } else if (source.kind === "package") {
    ctx.chartTarget = resolve(source.path);
    if (
      !(await stat(ctx.chartTarget).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      throw new Error(`${source.path} is not a file`);
    sum = await sha256(ctx.chartTarget);
  } else {
    ctx.chartTarget = source.reference;
    ctx.versionArgs = source.version ? ["--version", source.version] : [];
  }
  const shown = Bun.YAML.parse(
    (await ctx.liveRun(["helm", "show", "chart", ctx.chartTarget, ...ctx.versionArgs])).stdout,
  ) as Values;
  ctx.defaults = Bun.YAML.parse(
    (await ctx.liveRun(["helm", "show", "values", ctx.chartTarget, ...ctx.versionArgs])).stdout,
  ) as Values;
  requireNativeChart(ctx.defaults);
  const pin = pinning(ctx.defaults);
  const overrideImage = options.factoryImage && options.factoryImage !== pin.image;
  if (!pin.imagePinned && !options.factoryImage)
    throw new Error("The chart pins no Factory image; pass --factory-image");
  const image = overrideImage ? options.factoryImage : pin.image;
  receipt.chart = {
    source: sourceLabel,
    reference:
      source.kind === "package"
        ? basename(source.path)
        : source.kind === "oci"
          ? source.reference
          : "working tree",
    name: shown["name"],
    version: shown["version"],
    appVersion: shown["appVersion"],
    sha256: sum || undefined,
  };
  receipt.images = {
    ...receipt.images,
    factory: image,
    factoryKind: imageKind(image),
    factoryPinnedByChart: pin.imagePinned,
    factoryOverridden: Boolean(overrideImage && pin.imagePinned),
  };
  ctx.chartImage = overrideImage || !pin.imagePinned ? image : undefined;
  return `${shown["name"]} ${shown["version"]} (${imageKind(image)} image ${image.split("@")[0]})`;
}

export async function checkCapacityStage(ctx: CleanRoomRunContext) {
  const nodes = (await ctx.json(["get", "nodes"])).items as Array<{
    metadata: { name: string };
    status: { allocatable: { memory: string; cpu: string } };
  }>;
  if (!ctx.nodeName) {
    if (nodes.length !== 1)
      throw new Error(
        `The cluster has ${nodes.length} nodes (${nodes.map((node) => node.metadata.name).join(", ")}); pass --node`,
      );
    ctx.nodeName = nodes[0]?.metadata.name ?? "";
  }
  const node = nodes.find((item) => item.metadata.name === ctx.nodeName);
  if (!node) throw new Error(`Node ${ctx.nodeName} was not found`);
  if (!ctx.native) throw Error("Native commissioning inputs are unavailable");
  const generated = cleanRoomValues(
    {
      node: ctx.nodeName,
      native: ctx.native.values,
      ...(ctx.chartImage ? { image: ctx.chartImage } : {}),
      ...(ctx.options.values
        ? { extra: Bun.YAML.parse(await readFile(resolve(ctx.options.values), "utf8")) }
        : {}),
      smallRequests: ctx.options.smallRequests,
    },
    ctx.defaults,
  );
  ctx.receipt.values.ignoredKeys = generated.ignored;
  ctx.origin = String(generated.values["publicURL"]);
  ctx.valuesFile = join(ctx.temp, "values.yaml");
  await writeFile(ctx.valuesFile, Bun.YAML.stringify(generated.values, null, 2), { mode: 0o600 });
  const pods = (
    await ctx.json(["get", "pods", "-A", "--field-selector", `spec.nodeName=${ctx.nodeName}`])
  ).items as Parameters<typeof capacityVerdict>[0]["pods"];
  const lines = controlPlaneRequests(deepMerge(ctx.defaults, generated.values));
  const verdict = capacityVerdict({
    node: ctx.nodeName,
    allocatable: node.status.allocatable.memory,
    allocatableCPU: node.status.allocatable.cpu,
    pods,
    needed: lines,
    smallRequests: ctx.options.smallRequests,
  });
  ctx.receipt.node = ctx.nodeName;
  ctx.receipt.scheduling = {
    node: ctx.nodeName,
    allocatableMemory: node.status.allocatable.memory,
    allocatableCPU: node.status.allocatable.cpu,
    headroomMiB: verdict.headroomMiB,
    headroomMilliCPU: verdict.headroomMilliCPU,
    neededMiB: totalMiB(lines),
    neededMilliCPU: verdict.neededMilliCPU,
    breakdown: lines,
    smallRequests: ctx.options.smallRequests,
  };
  if (!verdict.fits) throw new Error(verdict.detail);
  return verdict.detail;
}

export async function validateChartConfigurationStage(ctx: CleanRoomRunContext) {
  // Validate required native installation inputs before creating a
  // Namespace, claims, credentials or any installed service.
  const rendered = await ctx.liveRun(
    ctx.cl.helm(
      "template",
      releaseName,
      ctx.chartTarget,
      ...ctx.versionArgs,
      "--namespace",
      ctx.namespace,
      "--values",
      ctx.valuesFile,
    ),
    { cwd: ctx.root, allowFailure: true },
  );
  if (rendered.code !== 0)
    throw new Error(
      `Native chart configuration refused before installation: ${redact(rendered.stderr, ctx.secrets).trim().split("\n").filter(Boolean).slice(-4).join(" | ")}`,
    );
  if (!ctx.native) throw Error("Native commissioning inputs are unavailable");
  requireFreshNativeIngress(
    await ctx.json(["get", "ingresses", "--all-namespaces"]),
    ctx.native.values,
  );
  return "Native chart configuration rendered; no installation resources created";
}
