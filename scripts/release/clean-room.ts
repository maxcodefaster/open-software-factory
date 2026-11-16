// Clean-room install test. It installs a chart package on a fresh Namespace of the current kubectl
// context, proves the installation works through its public readiness, a browser sign-in, OpenBao
// and a backup, then removes exactly what it created.
//
//   mise exec -- bun run release:clean-room --factory-image REF@sha256:... --native-fixture FILE --node NODE
//   mise exec -- bun run release:clean-room --chart ./factory-0.1.0-beta.1.tgz --native-fixture FILE --node NODE
//   mise exec -- bun run release:clean-room --cleanup factory-cleanroom-<8 hex>
//
// The Namespace carries an owner label and its UID is recorded. Cleanup verifies both before it
// deletes anything, and every deletion requires the original resource UID. No retained installation, Namespace or
// volume is read for its identity or touched. The admin password is read from the new
// installation's Secret, handed to the browser and never printed or written.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { checkSet } from "../kubernetes/restore-check";
import { withDockerBackupReader } from "./clean-room-backup";
import { browserJourney } from "./clean-room-browser";
import {
  type Cluster,
  cluster,
  pipe,
  type RunOptions,
  removeCleanRoomContainer,
  run,
  testCleanRoomChart,
  until,
} from "./clean-room-cluster";
import {
  backupJobName,
  type Check,
  type CleanupState,
  capacityVerdict,
  chartName,
  classifyClaims,
  cleanRoomIDFromNamespace,
  cleanRoomNamespace,
  cleanRoomValues,
  clusterObjectNames,
  controlPlaneRequests,
  createReceipt,
  deepMerge,
  disappeared,
  emptyCleanup,
  finishReceipt,
  imageKind,
  listSetsScript,
  namespaceManifest,
  newestSet,
  type Options,
  openbaoVerdict,
  ownedClusterObjects,
  ownedRuntimeNamespaces,
  ownedVolumes,
  packageVersion,
  parseChartArgument,
  parseOptions,
  pinning,
  readinessVerdict,
  receiptPath,
  redact,
  releaseName,
  requireCleanRoomNativeInventory,
  requireNativeChart,
  runtimeNamespacesNotAttributed,
  serializeReceipt,
  totalMiB,
  usablePgRestore,
  type Values,
  verifyOwnedNamespace,
} from "./clean-room-model";
import {
  createNativeCleanRoomSecrets,
  prepareNativeCleanRoom,
  readNativeCleanRoomReadiness,
  requireFreshNativeIngress,
} from "./clean-room-native";
import { packageFactoryChart } from "./package-chart";

const root = resolve(import.meta.dir, "../..");
const log = (message: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const name = chartName(releaseName);

class StepFailed extends Error {}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// ---- Ownership and cleanup

type Ownership = {
  claims: { namespace: string; name: string; uid: string }[];
  runtime: { name: string; uid: string }[];
  cluster: { kind: "clusterrole" | "clusterrolebinding"; name: string; uid: string }[];
  unexpectedClaims: string[];
};

type Items<T> = { items: T[] };
type NamespaceItem = { metadata: { name: string; uid: string; labels?: Record<string, string> } };
type ClaimItem = { metadata: { name: string; uid: string } };

// Only independent IDEs are Kubernetes Namespaces. Native execution resources
// require a separate native cleanup proof, not a Kubernetes namespace sweep.
async function gatherOwnership(cl: Cluster, namespace: string): Promise<Ownership> {
  const listClaims = async (target: string) => {
    const found = await cl.kubectl(["-n", target, "get", "pvc", "-o", "json"], {
      allowFailure: true,
    });
    if (found.code !== 0)
      throw Error("Owned claim inventory is unavailable; installation retained");
    return (JSON.parse(found.stdout) as Items<ClaimItem>).items.map((item) => ({
      namespace: target,
      name: item.metadata.name,
      uid: item.metadata.uid,
    }));
  };
  const claims = await listClaims(namespace);
  const recorded = await cl.kubectl(
    [
      "exec",
      "-n",
      namespace,
      `${name}-postgres-0`,
      "--",
      "psql",
      "-U",
      "factory",
      "-d",
      "factory",
      "-X",
      "-At",
      "-c",
      `SELECT 'native-resources-present' WHERE EXISTS(
        SELECT 1 FROM factory.substrate_workspace UNION ALL SELECT 1 FROM factory.substrate_prebuild
        UNION ALL SELECT 1 FROM factory.substrate_verification UNION ALL SELECT 1 FROM factory.substrate_isolated
        UNION ALL SELECT 1 FROM factory.substrate_worker_capacity UNION ALL SELECT 1 FROM factory.substrate_binding)
        UNION SELECT namespace_uid FROM factory.developer_ide WHERE namespace_uid IS NOT NULL`,
    ],
    { allowFailure: true },
  );
  const uids = requireCleanRoomNativeInventory(recorded);
  const namespaces = uids.size
    ? ((await cl.json(["get", "namespaces"])) as Items<NamespaceItem>)
    : { items: [] };
  const runtime = uids.size ? ownedRuntimeNamespaces(namespaces.items, uids) : [];
  for (const item of runtime) claims.push(...(await listClaims(item.name)));
  const id = cleanRoomIDFromNamespace(namespace);
  if (!id) throw Error("Owned clean-room Namespace is missing");
  const names = clusterObjectNames(id, releaseName);
  const clusterObjects: Ownership["cluster"] = [];
  for (const [kind, expected] of [
    ["clusterrole", names.clusterRoles],
    ["clusterrolebinding", names.clusterRoleBindings],
  ] as const) {
    const listed = (await cl.json(["get", kind])) as Items<NamespaceItem>;
    for (const name of ownedClusterObjects(listed.items, expected, releaseName)) {
      const item = listed.items.find((item) => item.metadata.name === name);
      if (!item?.metadata.uid)
        throw Error("Owned cluster object UID is unavailable; installation retained");
      clusterObjects.push({ kind, name, uid: item.metadata.uid });
    }
  }
  return {
    claims,
    runtime,
    cluster: clusterObjects,
    unexpectedClaims: classifyClaims(
      claims.filter((claim) => claim.namespace === namespace).map((claim) => claim.name),
      releaseName,
    ).unexpected,
  };
}

// Removes one run's resources and nothing else. The Namespace is only deleted after its name,
// owner label and managed-by label match; every deletion requires the original resource UID.
async function removeRun(
  cl: Cluster,
  id: string,
  ownership: Ownership,
  namespaceUID: string,
): Promise<CleanupState> {
  if (!namespaceUID)
    throw Error("Original clean-room Namespace UID is unavailable; nothing deleted");
  if (ownership.unexpectedClaims.length)
    throw Error("Unexpected claims are present in the owned Namespace; nothing deleted");
  const namespace = cleanRoomNamespace(id);
  const state = emptyCleanup();
  const remove = async (label: string, path: string, uid: string) => {
    if (!uid) throw Error("Original cleanup resource UID is unavailable; nothing deleted");
    const result = await cl.kubectl(["delete", "--raw", path, "-f", "-"], {
      input: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid } }),
      allowFailure: true,
    });
    if (result.code === 0) state.deleted.push(label);
    else state.errors.push(`${label}: deletion outcome is unconfirmed`);
    return result.code === 0;
  };
  const found = await cl.kubectl(["get", "namespace", namespace, "-o", "json"], {
    allowFailure: true,
  });
  if (found.code !== 0)
    throw Error("Original Namespace observation is unavailable; nothing deleted");
  // Namespace GC removes its own release, claims and Secrets. Do not first
  // uninstall Helm by name: a same-name replacement could otherwise be harmed
  // before the UID-preconditioned Namespace deletion rejects it.
  verifyOwnedNamespace(JSON.parse(found.stdout), id, namespaceUID);
  for (const item of ownership.runtime) {
    const current = await cl.kubectl(["get", "namespace", item.name, "-o", "json"], {
      allowFailure: true,
    });
    if (current.code !== 0) throw Error("Original editor Namespace observation is unavailable");
    const parsed = JSON.parse(current.stdout) as NamespaceItem;
    if (
      parsed.metadata.uid !== item.uid ||
      parsed.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
    ) {
      state.errors.push(`${item.name} changed identity since it was attributed; left in place`);
      state.state = "failed";
      return state;
    }
    if (!(await remove(`namespace/${item.name}`, `/api/v1/namespaces/${item.name}`, item.uid)))
      throw Error("Original editor Namespace deletion is unconfirmed");
    await cl.kubectl(["wait", "--for=delete", `namespace/${item.name}`, "--timeout=10m"]);
  }
  verifyOwnedNamespace(await cl.json(["get", "namespace", namespace]), id, namespaceUID);
  if (!(await remove(`namespace/${namespace}`, `/api/v1/namespaces/${namespace}`, namespaceUID)))
    throw Error(
      "Original clean-room Namespace deletion is unconfirmed; no replacement was deleted",
    );
  await cl.kubectl(["wait", "--for=delete", `namespace/${namespace}`, "--timeout=10m"]);

  const owned = [namespace, ...ownership.runtime.map((item) => item.name)];
  const claimUIDs = new Set(ownership.claims.map((claim) => claim.uid));
  const volumes = (await cl.json(["get", "pv"])) as Items<{
    metadata: { name: string; uid: string };
    spec?: { claimRef?: { namespace?: string; uid?: string } };
  }>;
  for (const volume of volumes.items) {
    if (!ownedVolumes([volume], owned, claimUIDs).length) continue;
    if (
      !(await remove(
        `pv/${volume.metadata.name}`,
        `/api/v1/persistentvolumes/${volume.metadata.name}`,
        volume.metadata.uid,
      ))
    )
      throw Error("Original owned PV deletion is unconfirmed");
    await cl.kubectl(["wait", "--for=delete", `pv/${volume.metadata.name}`, "--timeout=2m"]);
  }
  for (const item of ownership.cluster) {
    const plural = item.kind === "clusterrole" ? "clusterroles" : "clusterrolebindings";
    await remove(
      `${item.kind}/${item.name}`,
      `/apis/rbac.authorization.k8s.io/v1/${plural}/${item.name}`,
      item.uid,
    );
  }

  // Verify rather than assume.
  const namespaceInventory = (await cl.json(["get", "namespaces"])) as Items<NamespaceItem>;
  for (const target of owned)
    if (namespaceInventory.items.some((item) => item.metadata.name === target))
      state.remaining.push(`namespace/${target}`);
  const after = (await cl.json(["get", "pv"])) as Items<never>;
  for (const volume of after.items)
    for (const leftover of ownedVolumes([volume], owned, claimUIDs))
      state.remaining.push(`pv/${leftover}`);
  const names = clusterObjectNames(id, releaseName);
  for (const [kind, expected] of [
    ["clusterrole", names.clusterRoles],
    ["clusterrolebinding", names.clusterRoleBindings],
  ] as const) {
    const listed = (await cl.json(["get", kind])) as Items<NamespaceItem>;
    for (const item of ownedClusterObjects(listed.items, expected, releaseName))
      state.remaining.push(`${kind}/${item}`);
  }
  state.state = state.errors.length || state.remaining.length ? "failed" : "removed";
  return state;
}

// ---- The run

async function main(options: Options) {
  const context =
    options.context || (await run(["kubectl", "config", "current-context"])).stdout.trim();
  if (!context) throw new Error("kubectl has no current context; pass --context NAME");
  const cl = cluster(context);
  const { helm } = cl;
  let activeSignal: AbortSignal | undefined;
  const kubectl = (args: string[], options: RunOptions = {}) =>
    cl.kubectl(args, { ...options, signal: activeSignal });
  const json = (args: string[]) => cl.json(args, { signal: activeSignal });
  const liveRun = (args: string[], options: RunOptions = {}) =>
    run(args, { ...options, signal: activeSignal });
  const outputDirectory = resolve(root, ".factory/test-results/clean-room");
  await mkdir(outputDirectory, { recursive: true });

  if (options.cleanup) {
    const id = cleanRoomIDFromNamespace(options.cleanup) ?? "";
    const file = resolve(root, receiptPath(options.cleanup));
    const previous = await readFile(file, "utf8").then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      () => null,
    );
    const namespaceUID = previous?.["namespaceUID"];
    if (
      typeof namespaceUID !== "string" ||
      !namespaceUID ||
      previous?.["context"] !== context ||
      previous?.["namespace"] !== options.cleanup
    )
      throw Error("Original clean-room Namespace UID/context is unavailable; nothing deleted");
    verifyOwnedNamespace(await json(["get", "namespace", options.cleanup]), id, namespaceUID);
    const ownership = await gatherOwnership(cl, options.cleanup);
    const cleanup = await removeRun(cl, id, ownership, namespaceUID);
    log(`${cleanup.state}: deleted ${cleanup.deleted.join(", ") || "nothing"}`);
    await writeFile(
      file,
      `${JSON.stringify({ ...(previous ?? { schema: 1, id, namespace: options.cleanup }), cleanupRerun: cleanup }, null, 2)}\n`,
    );
    return cleanup.state === "removed" ? 0 : 1;
  }

  const startedAt = new Date();
  const id = randomBytes(4).toString("hex");
  const namespace = cleanRoomNamespace(id);
  const receipt = createReceipt({
    id,
    context,
    startedAt,
    options: {
      keep: options.keep,
      withSandbox: options.withSandbox,
      smallRequests: options.smallRequests,
      extraValues: Boolean(options.values),
    },
  });
  const secrets: string[] = [];
  const file = resolve(root, receiptPath(namespace));
  await writeFile(file, serializeReceipt(receipt, secrets), { flag: "wx", mode: 0o600 });
  const persist = () => writeFile(file, serializeReceipt(receipt, secrets), { mode: 0o600 });
  const temp = await mkdtemp(join(tmpdir(), "factory-clean-room-"));
  const connection = new AbortController();
  activeSignal = connection.signal;
  let interrupted = false;
  let created = false;
  let ownership: Ownership = { claims: [], runtime: [], cluster: [], unexpectedClaims: [] };
  let failure = "";
  let preserveTemp = false;
  const beforeNamespaces: string[] = [];
  const beforeRuntime: string[] = [];
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    receipt.interrupted = true;
    log("Interrupted. Waiting for owned clients and cleanup to finish.");
    connection.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const timed = async <T>(label: string, work: () => Promise<T>) => {
    const begin = performance.now();
    try {
      return await work();
    } finally {
      receipt.timingsMs[label] = Math.round(performance.now() - begin);
    }
  };
  const record_ = (check: Check) => {
    receipt.checks.push(check);
    log(
      `${check.status === "passed" ? "ok  " : check.status === "skipped" ? "skip" : "FAIL"} ${check.name}: ${check.detail}`,
    );
  };
  const step = async (
    label: string,
    work: () => Promise<string | { skipped: string }>,
  ): Promise<void> => {
    if (interrupted) throw new StepFailed("Interrupted");
    const begin = performance.now();
    try {
      const result = await work();
      connection.signal.throwIfAborted();
      record_({
        name: label,
        status: typeof result === "string" ? "passed" : "skipped",
        detail: redact(typeof result === "string" ? result : result.skipped, secrets),
        durationMs: Math.round(performance.now() - begin),
      });
    } catch (cause) {
      const detail = redact(cause instanceof Error ? cause.message : String(cause), secrets);
      record_({
        name: label,
        status: "failed",
        detail,
        durationMs: Math.round(performance.now() - begin),
      });
      throw new StepFailed(`${label}: ${detail}`);
    } finally {
      receipt.timingsMs[label] = Math.round(performance.now() - begin);
      await persist().catch(() => undefined);
    }
  };

  const chartInput: {
    image: string | undefined;
  } = { image: undefined };
  let chartTarget = "";
  let versionArgs: string[] = [];
  let defaults: Values = {};
  let valuesFile = "";
  let nodeName = options.node;
  let origin = "";
  let adminPassword = "";
  let adminEmail = "admin@factory.local";
  let native: Awaited<ReturnType<typeof prepareNativeCleanRoom>> | undefined;

  try {
    await step("native-inputs", async () => {
      native = await prepareNativeCleanRoom(options.nativeFixture, namespace, releaseName, {
        signal: connection.signal,
      });
      secrets.push(...native.redactions);
      receipt.native = native.metadata;
      return "Fresh native identity, separate provisioner credential and TLS bundle validated; no cluster resource created";
    });
    await step("tools", async () => {
      const helmVersion = (
        await liveRun(["helm", "version", "--template", "{{.Version}}"])
      ).stdout.trim();
      const kubectlClient = JSON.parse(
        (await liveRun(["kubectl", "version", "--client", "-o", "json"])).stdout,
      ).clientVersion.gitVersion as string;
      const server = await liveRun(["kubectl", "--context", context, "version", "-o", "json"], {
        allowFailure: true,
      });
      const serverVersion =
        server.code === 0
          ? ((JSON.parse(server.stdout).serverVersion?.gitVersion as string | undefined) ?? "")
          : "";
      if (!serverVersion) throw new Error(`Cannot reach the cluster of context ${context}`);
      receipt.tools = {
        helm: helmVersion,
        kubectl: kubectlClient,
        kubernetes: serverVersion,
        bun: Bun.version,
      };
      return `context ${context}; helm ${helmVersion}, kubectl ${kubectlClient}, Kubernetes ${serverVersion}`;
    });

    await persist();
    await step("chart", async () => {
      const source = parseChartArgument(options.chart);
      let sourceLabel: string = source.kind;
      let sum = "";
      if (source.kind === "working-tree") {
        if (!options.factoryImage)
          throw new Error("Packaging the working tree needs --factory-image");
        const version = packageVersion(id);
        const directory = join(temp, "package");
        await mkdir(directory);
        if (imageKind(options.factoryImage) !== "digest")
          throw new Error("Native chart packaging requires the immutable Factory image digest");
        const catalogContainer = `factory-cleanroom-artifacts-${id}`;
        receipt.images["catalogContainer"] = { name: catalogContainer, owner: id };
        await persist();
        const catalog = await liveRun([
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
        ]).then(
          (output) => ({ output }),
          (error: unknown) => ({ error }),
        );
        await removeCleanRoomContainer(catalogContainer, id);
        receipt.images["catalogContainerRemoved"] = true;
        if ("error" in catalog) throw catalog.error;
        chartTarget = (
          await packageFactoryChart({
            version,
            factoryImage: options.factoryImage,
            output: directory,
            artifacts: JSON.parse(catalog.output.stdout),
          })
        ).chart;
        sum = await sha256(chartTarget);
        sourceLabel = "working-tree (packaged by this run)";
      } else if (source.kind === "package") {
        chartTarget = resolve(source.path);
        if (
          !(await stat(chartTarget).then(
            (info) => info.isFile(),
            () => false,
          ))
        )
          throw new Error(`${source.path} is not a file`);
        sum = await sha256(chartTarget);
      } else {
        chartTarget = source.reference;
        versionArgs = source.version ? ["--version", source.version] : [];
      }
      const shown = Bun.YAML.parse(
        (await liveRun(["helm", "show", "chart", chartTarget, ...versionArgs])).stdout,
      ) as Values;
      defaults = Bun.YAML.parse(
        (await liveRun(["helm", "show", "values", chartTarget, ...versionArgs])).stdout,
      ) as Values;
      requireNativeChart(defaults);
      const pin = pinning(defaults);
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
      chartInput.image = overrideImage || !pin.imagePinned ? image : undefined;
      return `${shown["name"]} ${shown["version"]} (${imageKind(image)} image ${image.split("@")[0]})`;
    });

    await step("capacity", async () => {
      const nodes = (await json(["get", "nodes"])).items as Array<{
        metadata: { name: string };
        status: { allocatable: { memory: string; cpu: string } };
      }>;
      if (!nodeName) {
        if (nodes.length !== 1)
          throw new Error(
            `The cluster has ${nodes.length} nodes (${nodes.map((node) => node.metadata.name).join(", ")}); pass --node`,
          );
        nodeName = nodes[0]?.metadata.name ?? "";
      }
      const node = nodes.find((item) => item.metadata.name === nodeName);
      if (!node) throw new Error(`Node ${nodeName} was not found`);
      if (!native) throw Error("Native commissioning inputs are unavailable");
      const generated = cleanRoomValues(
        {
          node: nodeName,
          native: native.values,
          ...(chartInput.image ? { image: chartInput.image } : {}),
          ...(options.values
            ? { extra: Bun.YAML.parse(await readFile(resolve(options.values), "utf8")) }
            : {}),
          smallRequests: options.smallRequests,
        },
        defaults,
      );
      receipt.values.ignoredKeys = generated.ignored;
      origin = String(generated.values["publicURL"]);
      valuesFile = join(temp, "values.yaml");
      await writeFile(valuesFile, Bun.YAML.stringify(generated.values, null, 2), { mode: 0o600 });
      const pods = (
        await json(["get", "pods", "-A", "--field-selector", `spec.nodeName=${nodeName}`])
      ).items;
      const lines = controlPlaneRequests(deepMerge(defaults, generated.values));
      const verdict = capacityVerdict({
        node: nodeName,
        allocatable: node.status.allocatable.memory,
        allocatableCPU: node.status.allocatable.cpu,
        pods,
        needed: lines,
        smallRequests: options.smallRequests,
      });
      receipt.node = nodeName;
      receipt.scheduling = {
        node: nodeName,
        allocatableMemory: node.status.allocatable.memory,
        allocatableCPU: node.status.allocatable.cpu,
        headroomMiB: verdict.headroomMiB,
        headroomMilliCPU: verdict.headroomMilliCPU,
        neededMiB: totalMiB(lines),
        neededMilliCPU: verdict.neededMilliCPU,
        breakdown: lines,
        smallRequests: options.smallRequests,
      };
      if (!verdict.fits) throw new Error(verdict.detail);
      return verdict.detail;
    });

    await step("chart-configuration", async () => {
      // Validate required native installation inputs before creating a
      // Namespace, claims, credentials or any installed service.
      const rendered = await liveRun(
        helm(
          "template",
          releaseName,
          chartTarget,
          ...versionArgs,
          "--namespace",
          namespace,
          "--values",
          valuesFile,
        ),
        { cwd: root, allowFailure: true },
      );
      if (rendered.code !== 0)
        throw new Error(
          `Native chart configuration refused before installation: ${redact(rendered.stderr, secrets).trim().split("\n").filter(Boolean).slice(-4).join(" | ")}`,
        );
      if (!native) throw Error("Native commissioning inputs are unavailable");
      requireFreshNativeIngress(
        await json(["get", "ingresses", "--all-namespaces"]),
        native.values,
      );
      return "Native chart configuration rendered; no installation resources created";
    });

    // Snapshots let the receipt show that nothing else disappeared and which runtime Namespaces
    // appeared that this run cannot attribute to itself.
    const namespaces = (await json(["get", "namespaces"])).items as NamespaceItem[];
    beforeNamespaces.push(...namespaces.map((item) => item.metadata.name));
    beforeRuntime.push(
      ...namespaces
        .map((item) => item.metadata.name)
        .filter((item) => /^factory-editor-[a-f0-9]{32}$/.test(item)),
    );

    await step("namespace", async () => {
      if (await cl.exists(["namespace", namespace], { signal: connection.signal }))
        throw new Error(`${namespace} already exists; refusing to use it`);
      // Intent first: an interrupted run leaves a receipt that names what to clean up.
      await persist();
      created = true;
      const createdNamespace = await kubectl(["create", "-f", "-", "-o", "json"], {
        input: JSON.stringify(namespaceManifest(id, startedAt)),
      });
      const uid = verifyOwnedNamespace(JSON.parse(createdNamespace.stdout), id);
      receipt.namespaceUID = uid;
      await persist();
      return `${namespace} created with owner label ${id} (uid ${uid})`;
    });

    await step("native-secrets", async () => {
      if (!native || !receipt.namespaceUID)
        throw Error("Original native installation identity is unavailable");
      await persist();
      await createNativeCleanRoomSecrets(cl, native, receipt.namespaceUID, connection.signal);
      return "Created only this fresh Namespace's native configuration, provisioner and Ingress Secrets";
    });

    await step("install", async () => {
      log("Installing the chart; this waits for every service and can take up to 20 minutes");
      const result = await timed("install-helm", () =>
        liveRun(
          helm(
            "install",
            releaseName,
            chartTarget,
            ...versionArgs,
            "--namespace",
            namespace,
            "--values",
            valuesFile,
            "--wait=legacy",
            "--timeout",
            "20m",
          ),
          { cwd: root, allowFailure: true },
        ),
      );
      if (result.code !== 0)
        throw new Error(
          `helm install failed: ${redact(result.stderr, secrets).trim().split("\n").slice(-4).join(" | ")}`,
        );
      return `release ${releaseName} installed with --wait=legacy --timeout 20m`;
    });

    await step("helm-test", async () => {
      log("Running helm test (read-only native preflight, not Actor or product acceptance)");
      return testCleanRoomChart(cl, releaseName, namespace, connection.signal);
    });

    await step("readiness", async () => {
      if (!native) throw Error("Native public readiness trust is unavailable");
      const ca = native.ca;
      let startupID = "";
      await until(
        "public readiness",
        600_000,
        async () => {
          connection.signal.throwIfAborted();
          const response = await readNativeCleanRoomReadiness(origin, ca, connection.signal);
          await response.body?.cancel();
          const verdict = readinessVerdict(response);
          startupID = verdict.startupID;
          return verdict.ready;
        },
        connection.signal,
      );
      const pods = (await json(["-n", namespace, "get", "pods"])).items as Array<{
        metadata: { name: string };
        status: { containerStatuses?: Array<{ name: string; image: string; imageID: string }> };
      }>;
      (receipt.images as Record<string, unknown>)["running"] = pods.flatMap((pod) =>
        (pod.status.containerStatuses ?? []).map((container) => ({
          pod: pod.metadata.name,
          container: container.name,
          image: container.image,
          imageID: container.imageID,
        })),
      );
      return `/health/ready?installation=complete answered 200 with the ready header (startup ${startupID.slice(0, 8)})`;
    });

    await step("admin-credential", async () => {
      const secret = await json(["-n", namespace, "get", "secret", `${name}-credentials`]);
      adminPassword = Buffer.from(
        String(secret.data?.["admin-password"] ?? ""),
        "base64",
      ).toString();
      if (adminPassword.length < 12)
        throw new Error("The generated admin password is missing or short");
      secrets.push(adminPassword);
      adminEmail = String(defaults["adminEmail"] ?? adminEmail);
      return `read from ${name}-credentials; never printed or written`;
    });

    await step("openbao", async () => {
      const status = await kubectl(
        ["exec", "-i", "-n", namespace, `${name}-openbao-0`, "-c", "openbao", "--", "sh", "-s"],
        {
          input:
            "export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt\nbao status -format=json || true\n",
          allowFailure: true,
        },
      );
      const verdict = openbaoVerdict(status.stdout);
      if (!verdict.ok) throw new Error(verdict.detail);
      return verdict.detail;
    });

    await timed("browser", async () => {
      const journey = await browserJourney({
        origin,
        email: adminEmail,
        password: adminPassword,
        id,
        withSandbox: options.withSandbox,
        directory: join(outputDirectory, namespace),
        signal: connection.signal,
      });
      for (const check of journey.checks) record_(check);
      receipt.limits.push(...journey.limits);
      receipt.screenshots = journey.screenshots.map((path) => path.replace(`${root}/`, ""));
    });
    await persist();

    const jobName = backupJobName(id);
    await step("backup-job", async () => {
      log("Taking a manual backup with the chart's CronJob template");
      await kubectl(["-n", namespace, "create", "job", jobName, `--from=cronjob/${name}-backup`]);
      const waited = await kubectl(
        ["-n", namespace, "wait", "--for=condition=complete", `job/${jobName}`, "--timeout=30m"],
        { allowFailure: true },
      );
      if (waited.code !== 0) {
        const logs = await kubectl(
          ["-n", namespace, "logs", `job/${jobName}`, "--all-containers", "--tail=15"],
          { allowFailure: true },
        );
        throw new Error(
          `Backup Job did not complete: ${(logs.stdout || logs.stderr).trim().split("\n").slice(-4).join(" | ")}`,
        );
      }
      const job = await json(["-n", namespace, "get", "job", jobName]);
      if (job.status?.succeeded !== 1) throw new Error("The backup Job reports no success");
      return `${jobName} completed`;
    });

    await step("backup-check", async () => {
      const store = `${name}-backup-store-0`;
      const listed = (
        await kubectl(["exec", "-n", namespace, store, "--", "sh", "-c", listSetsScript()])
      ).stdout;
      const set = newestSet(listed);
      if (!set) throw new Error("The backup store holds no complete set");
      const directory = join(temp, "set");
      await mkdir(directory);
      await pipe(
        cl.kube(
          "exec",
          "-n",
          namespace,
          store,
          "--",
          "tar",
          "-C",
          `/backup/${set}`,
          "-cf",
          "-",
          ".",
        ),
        ["tar", "-xf", "-", "-C", directory],
        connection.signal,
      );
      const files = await readdir(directory);
      if (!files.includes("openbao.snap"))
        throw new Error(`Set ${set} has no openbao.snap although OpenBao bootstrapped`);
      const optionalClient = (args: string[]) =>
        liveRun(args, { allowFailure: true }).catch(() => {
          connection.signal.throwIfAborted();
          return null;
        });
      const pgRestore = process.env["PG_RESTORE"] ?? "pg_restore";
      const local = await optionalClient([pgRestore, "--version"]);
      let checks: Awaited<ReturnType<typeof checkSet>>;
      if (local?.code === 0 && usablePgRestore(local.stdout))
        checks = await checkSet(directory, pgRestore, connection.signal);
      else if (process.env["PG_RESTORE"])
        throw Error("The selected PG_RESTORE must be a working PostgreSQL 16 executable");
      else if ((await optionalClient(["docker", "version"]))?.code === 0) {
        const postgres = await json(["-n", namespace, "get", "pod", `${name}-postgres-0`]);
        const image = postgres.spec?.containers?.find(
          (container: { name: string; image: string }) => container.name === "postgres",
        )?.image;
        checks = await withDockerBackupReader(
          {
            id,
            directory,
            temporaryDirectory: temp,
            image: typeof image === "string" ? image : "",
            signal: connection.signal,
            async record(resource) {
              receipt.images["backupReader"] = resource;
              preserveTemp = resource.state === "unconfirmed";
              await persist();
            },
          },
          (command) => checkSet(directory, command, connection.signal),
        ).catch((cause: unknown) => {
          if (cause instanceof AggregateError) preserveTemp = true;
          throw cause;
        });
      } else
        return {
          skipped: `Set ${set} was copied and has openbao.snap, but restore-check needs pg_restore 16 or Docker, and neither is available`,
        };
      const failed = checks.filter((check) => !check.ok);
      if (failed.length)
        throw new Error(
          `restore-check failed: ${failed.map((check) => `${check.name}: ${check.detail}`).join("; ")}`,
        );
      return `set ${set} passed restore-check (${checks.length} parts)`;
    });
  } catch (cause) {
    failure =
      cause instanceof StepFailed
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    log(`FAILED: ${redact(failure, secrets)}`);
  }

  connection.abort();
  activeSignal = undefined;
  const cleanupBegin = performance.now();
  if (created && options.keep) {
    receipt.cleanup.state = "kept";
    log(
      `--keep: ${namespace} stays at ${origin}. Native inventory is retained.\nCleanup may be requested with: mise exec -- bun run release:clean-room --cleanup ${namespace} --context ${context}`,
    );
  } else if (created) {
    try {
      if (!receipt.namespaceUID)
        throw Error("Original Namespace create outcome is unconfirmed; nothing deleted");
      verifyOwnedNamespace(await json(["get", "namespace", namespace]), id, receipt.namespaceUID);
      ownership = await gatherOwnership(cl, namespace);
      const done = await removeRun(cl, id, ownership, receipt.namespaceUID);
      const after = (await json(["get", "namespaces"]).catch(() => ({
        items: [],
      }))) as Items<NamespaceItem>;
      receipt.cleanup = {
        ...done,
        unexpectedClaims: ownership.unexpectedClaims,
        unattributedRuntimeNamespaces: runtimeNamespacesNotAttributed(
          beforeRuntime,
          after.items,
          ownership.runtime.map((item) => item.name),
        ),
        disappeared: disappeared(
          beforeNamespaces,
          after.items.map((item) => item.metadata.name),
          done.deleted
            .filter((item) => item.startsWith("namespace/"))
            .map((item) => item.slice(10)),
        ),
      };
      log(`Cleanup ${done.state}: deleted ${done.deleted.join(", ") || "nothing"}`);
    } catch (cause) {
      receipt.cleanup.state = "failed";
      receipt.cleanup.errors.push(cause instanceof Error ? cause.message : String(cause));
      log(`Cleanup refused: ${receipt.cleanup.errors.at(-1)}`);
    }
  }
  receipt.timingsMs["cleanup"] = Math.round(performance.now() - cleanupBegin);
  if (preserveTemp) {
    receipt.limits.push(
      `Backup reader cleanup or recording is unconfirmed; private copied files kept at ${temp}`,
    );
    log("Backup reader cleanup or recording is unconfirmed; private files and intent are retained");
  } else await rm(temp, { recursive: true, force: true });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  const finished = finishReceipt(
    receipt,
    new Date(),
    failure ? redact(failure, secrets) : undefined,
  );
  await persist().catch(() => undefined);
  await writeFile(file, serializeReceipt(finished, secrets));
  const passed = finished.checks.filter((check) => check.status === "passed").length;
  log(
    `${finished.passed ? "PASS" : "FAIL"}: ${passed}/${finished.checks.length} checks passed, ${finished.checks.filter((check) => check.status === "skipped").length} skipped; receipt ${file}`,
  );
  return finished.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(parseOptions(process.argv.slice(2)));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
