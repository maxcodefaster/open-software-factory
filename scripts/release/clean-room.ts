// Clean-room install test. It installs a chart package on a fresh Namespace of the current kubectl
// context, proves the installation works through its public readiness, a browser sign-in, OpenBao
// and a backup, then removes exactly what it created.
//
//   mise exec -- bun run release:clean-room --factory-image REF@sha256:... --node NODE
//   mise exec -- bun run release:clean-room --chart ./factory-0.1.0-beta.1.tgz --node NODE
//   mise exec -- bun run release:clean-room --cleanup factory-cleanroom-<8 hex>
//
// The Namespace carries an owner label and its UID is recorded. Cleanup verifies both before it
// deletes anything, and it deletes by exact name only. No retained installation, Namespace or
// volume is read for its identity or touched. The admin password is read from the new
// installation's Secret, handed to the browser and never printed or written.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { connectLocalFactory } from "../kubernetes/connect";
import { checkSet } from "../kubernetes/restore-check";
import { type Cluster, cluster, pipe, run, until } from "../kubernetes/restore-rehearsal-cluster";
import { browserJourney } from "./clean-room-browser";
import {
  type Check,
  type CleanupState,
  type Options,
  backupJobName,
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
  runtimeNamespacesNotAttributed,
  serializeReceipt,
  totalMiB,
  usablePgRestore,
  type Values,
  verifyOwnedNamespace,
} from "./clean-room-model";
import { workerRelease } from "./package-chart";

const root = resolve(import.meta.dir, "../..");
const log = (message: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const name = chartName(releaseName);

class StepFailed extends Error {}

function freePorts(count: number) {
  const servers = Array.from({ length: count }, () =>
    Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
  );
  const ports = servers.map((server) => server.port);
  for (const server of servers) server.stop(true);
  return ports;
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// ---- Ownership and cleanup

type Ownership = {
  claims: { namespace: string; name: string; uid: string }[];
  runtime: { name: string; uid: string }[];
  unexpectedClaims: string[];
};

type Items<T> = { items: T[] };
type NamespaceItem = { metadata: { name: string; uid: string; labels?: Record<string, string> } };
type ClaimItem = { metadata: { name: string; uid: string } };

// The installation's own database records the UID of every Namespace it asked Kubernetes for. That
// UID is the only thing that ties a Factory-created worker or editor Namespace to this run.
async function gatherOwnership(cl: Cluster, namespace: string): Promise<Ownership> {
  const listClaims = async (target: string) => {
    const found = await cl.kubectl(["-n", target, "get", "pvc", "-o", "json"], {
      allowFailure: true,
    });
    return found.code === 0
      ? (JSON.parse(found.stdout) as Items<ClaimItem>).items.map((item) => ({
          namespace: target,
          name: item.metadata.name,
          uid: item.metadata.uid,
        }))
      : [];
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
      "SELECT namespace_uid FROM factory.factorybox_worker WHERE namespace_uid IS NOT NULL UNION SELECT namespace_uid FROM factory.workspace_source WHERE namespace_uid IS NOT NULL UNION SELECT namespace_uid FROM factory.developer_ide WHERE namespace_uid IS NOT NULL",
    ],
    { allowFailure: true },
  );
  const uids = new Set(recorded.stdout.split("\n").filter(Boolean));
  const namespaces = await cl.kubectl(["get", "namespaces", "-o", "json"], { allowFailure: true });
  const runtime = uids.size
    ? ownedRuntimeNamespaces(
        namespaces.code === 0 ? (JSON.parse(namespaces.stdout) as Items<NamespaceItem>).items : [],
        uids,
      )
    : [];
  for (const item of runtime) claims.push(...(await listClaims(item.name)));
  return {
    claims,
    runtime,
    unexpectedClaims: classifyClaims(
      claims.filter((claim) => claim.namespace === namespace).map((claim) => claim.name),
      releaseName,
    ).unexpected,
  };
}

// Removes one run's resources and nothing else. The Namespace is only deleted after its name,
// owner label and managed-by label match; every deletion is by exact name.
async function removeRun(cl: Cluster, id: string, ownership: Ownership): Promise<CleanupState> {
  const namespace = cleanRoomNamespace(id);
  const state = emptyCleanup();
  const remove = async (label: string, args: string[]) => {
    const result = await cl.kubectl(args, { allowFailure: true });
    if (result.code === 0) state.deleted.push(label);
    else state.errors.push(`${label}: ${result.stderr.trim().split("\n").at(-1) ?? "failed"}`);
    return result.code === 0;
  };
  const found = await cl.kubectl(["get", "namespace", namespace, "-o", "json"], {
    allowFailure: true,
  });
  if (found.code === 0) {
    // Throws, deleting nothing, unless this is exactly the Namespace the run created.
    verifyOwnedNamespace(JSON.parse(found.stdout), id);
    const uninstalled = await run(
      cl.helm("uninstall", releaseName, "-n", namespace, "--wait", "--timeout", "10m"),
      { allowFailure: true },
    );
    if (uninstalled.code === 0) state.deleted.push(`release/${releaseName}`);
    else if (!/not found/i.test(uninstalled.stderr))
      state.errors.push(`helm uninstall: ${uninstalled.stderr.trim().split("\n").at(-1)}`);
  }
  for (const item of ownership.runtime) {
    const current = await cl.kubectl(["get", "namespace", item.name, "-o", "json"], {
      allowFailure: true,
    });
    if (current.code !== 0) continue;
    const parsed = JSON.parse(current.stdout) as NamespaceItem;
    if (
      parsed.metadata.uid !== item.uid ||
      parsed.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
    ) {
      state.errors.push(`${item.name} changed identity since it was attributed; left in place`);
      continue;
    }
    await remove(`namespace/${item.name}`, [
      "delete",
      "namespace",
      item.name,
      "--wait=true",
      "--timeout=10m",
    ]);
  }
  if (found.code === 0) {
    const claims = ownership.claims.filter((claim) => claim.namespace === namespace);
    if (claims.length)
      await remove(`pvc/${namespace}/*`, [
        "-n",
        namespace,
        "delete",
        "pvc",
        ...claims.map((claim) => claim.name),
        "--ignore-not-found",
        "--wait=true",
        "--timeout=5m",
      ]);
    await remove(`namespace/${namespace}`, [
      "delete",
      "namespace",
      namespace,
      "--wait=true",
      "--timeout=10m",
    ]);
  }

  const owned = [namespace, ...ownership.runtime.map((item) => item.name)];
  const claimUIDs = new Set(ownership.claims.map((claim) => claim.uid));
  const volumes = await cl.kubectl(["get", "pv", "-o", "json"], { allowFailure: true });
  const volumeItems = volumes.code === 0 ? (JSON.parse(volumes.stdout) as Items<never>).items : [];
  for (const volume of ownedVolumes(volumeItems, owned, claimUIDs))
    await remove(`pv/${volume}`, [
      "delete",
      "pv",
      volume,
      "--ignore-not-found",
      "--wait=true",
      "--timeout=2m",
    ]);

  const names = clusterObjectNames(id, releaseName);
  for (const [kind, expected] of [
    ["clusterrole", names.clusterRoles],
    ["clusterrolebinding", names.clusterRoleBindings],
  ] as const) {
    const listed = await cl.kubectl(["get", kind, "-o", "json"], { allowFailure: true });
    const items = listed.code === 0 ? (JSON.parse(listed.stdout) as Items<never>).items : [];
    for (const item of ownedClusterObjects(items, expected, releaseName))
      await remove(`${kind}/${item}`, ["delete", kind, item, "--ignore-not-found"]);
  }

  // Verify rather than assume.
  for (const target of owned)
    if ((await cl.kubectl(["get", "namespace", target], { allowFailure: true })).code === 0)
      state.remaining.push(`namespace/${target}`);
  const after = await cl.kubectl(["get", "pv", "-o", "json"], { allowFailure: true });
  for (const volume of after.code === 0 ? (JSON.parse(after.stdout) as Items<never>).items : [])
    for (const leftover of ownedVolumes([volume], owned, claimUIDs))
      state.remaining.push(`pv/${leftover}`);
  for (const [kind, expected] of [
    ["clusterrole", names.clusterRoles],
    ["clusterrolebinding", names.clusterRoleBindings],
  ] as const) {
    const listed = await cl.kubectl(["get", kind, "-o", "json"], { allowFailure: true });
    const items = listed.code === 0 ? (JSON.parse(listed.stdout) as Items<never>).items : [];
    for (const item of ownedClusterObjects(items, expected, releaseName))
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
  const { kubectl, json, helm } = cl;
  const outputDirectory = resolve(root, ".factory/test-results/clean-room");
  await mkdir(outputDirectory, { recursive: true });

  if (options.cleanup) {
    const id = cleanRoomIDFromNamespace(options.cleanup) ?? "";
    const file = resolve(root, receiptPath(options.cleanup));
    const ownership = await gatherOwnership(cl, options.cleanup);
    const cleanup = await removeRun(cl, id, ownership);
    log(`${cleanup.state}: deleted ${cleanup.deleted.join(", ") || "nothing"}`);
    const previous = await readFile(file, "utf8").then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      () => null,
    );
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
  const persist = () => writeFile(file, serializeReceipt(receipt, secrets));
  const temp = await mkdtemp(join(tmpdir(), "factory-clean-room-"));
  const connection = new AbortController();
  let interrupted = false;
  let created = false;
  let ownership: Ownership = { claims: [], runtime: [], unexpectedClaims: [] };
  let connecting: Promise<void> = Promise.resolve();
  let failure = "";
  const beforeNamespaces: string[] = [];
  const beforeRuntime: string[] = [];
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("Interrupted. Cleaning up what this run created; press Ctrl+C again to stop at once.");
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
    worker: { image: string; executableSHA256: string; architecture: string } | undefined;
  } = { image: undefined, worker: undefined };
  let chartTarget = "";
  let versionArgs: string[] = [];
  let defaults: Values = {};
  let valuesFile = "";
  let nodeName = options.node;
  let origin = "";
  let adminPassword = "";
  let adminEmail = "admin@factory.local";

  try {
    await step("tools", async () => {
      const helmVersion = (
        await run(["helm", "version", "--template", "{{.Version}}"])
      ).stdout.trim();
      const kubectlClient = JSON.parse(
        (await run(["kubectl", "version", "--client", "-o", "json"])).stdout,
      ).clientVersion.gitVersion as string;
      const server = await run(["kubectl", "--context", context, "version", "-o", "json"], {
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
      const release = async () =>
        workerRelease.parse(
          JSON.parse(
            await readFile(join(root, "deploy/factorybox/release.json"), "utf8").catch(() => {
              throw new Error(
                "deploy/factorybox/release.json is missing, so the worker pin is unknown. Pass --chart with a released chart.",
              );
            }),
          ),
        );
      let worker: Awaited<ReturnType<typeof release>> | undefined;
      let sourceLabel: string = source.kind;
      let sum = "";
      if (source.kind === "working-tree") {
        if (!options.factoryImage)
          throw new Error("Packaging the working tree needs --factory-image");
        worker = await release();
        const version = packageVersion(id);
        const directory = join(temp, "package");
        await mkdir(directory);
        if (imageKind(options.factoryImage) === "digest")
          await run(
            [
              "bun",
              join(root, "scripts/release/package-chart.ts"),
              "--version",
              version,
              "--factory-image",
              options.factoryImage,
              "--output",
              directory,
            ],
            { cwd: root },
          );
        else
          await run([
            "helm",
            "package",
            join(root, "deploy/helm/factory"),
            "--version",
            version,
            "--app-version",
            version,
            "--destination",
            directory,
          ]);
        const packaged = (await readdir(directory)).find((entry) => entry.endsWith(".tgz"));
        if (!packaged) throw new Error("helm package produced no chart file");
        chartTarget = join(directory, packaged);
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
        (await run(["helm", "show", "chart", chartTarget, ...versionArgs])).stdout,
      ) as Values;
      defaults = Bun.YAML.parse(
        (await run(["helm", "show", "values", chartTarget, ...versionArgs])).stdout,
      ) as Values;
      const pin = pinning(defaults);
      const overrideImage = options.factoryImage && options.factoryImage !== pin.image;
      if (!pin.imagePinned && !options.factoryImage)
        throw new Error("The chart pins no Factory image; pass --factory-image");
      if (!pin.workerPinned && !worker) worker = await release();
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
        factory: image,
        factoryKind: imageKind(image),
        factoryPinnedByChart: pin.imagePinned,
        factoryOverridden: Boolean(overrideImage && pin.imagePinned),
        worker: pin.workerPinned
          ? { ...pin.worker, source: "chart" }
          : { ...worker, source: "deploy/factorybox/release.json" },
      };
      chartInput.image = overrideImage || !pin.imagePinned ? image : undefined;
      chartInput.worker = pin.workerPinned ? undefined : worker;
      return `${shown["name"]} ${shown["version"]} (${imageKind(image)} image ${image.split("@")[0]})`;
    });

    await step("capacity", async () => {
      const nodes = (await json(["get", "nodes"])).items as Array<{
        metadata: { name: string };
        status: { allocatable: { memory: string } };
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
      const ports = freePorts(3);
      const generated = cleanRoomValues(
        {
          node: nodeName,
          ports: { factory: ports[0] ?? 0, forgejo: ports[1] ?? 0, zero: ports[2] ?? 0 },
          ...(chartInput.image ? { image: chartInput.image } : {}),
          ...(chartInput.worker ? { worker: chartInput.worker } : {}),
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
        pods,
        needed: lines,
        smallRequests: options.smallRequests,
      });
      receipt.node = nodeName;
      receipt.scheduling = {
        node: nodeName,
        allocatableMemory: node.status.allocatable.memory,
        headroomMiB: verdict.headroomMiB,
        neededMiB: totalMiB(lines),
        breakdown: lines,
        smallRequests: options.smallRequests,
      };
      if (!verdict.fits) throw new Error(verdict.detail);
      return verdict.detail;
    });

    // Snapshots let the receipt show that nothing else disappeared and which runtime Namespaces
    // appeared that this run cannot attribute to itself.
    const namespaces = (await json(["get", "namespaces"])).items as NamespaceItem[];
    beforeNamespaces.push(...namespaces.map((item) => item.metadata.name));
    beforeRuntime.push(
      ...namespaces
        .map((item) => item.metadata.name)
        .filter((item) => /^factory-(box|editor)-[a-f0-9]{32}$/.test(item)),
    );

    await step("namespace", async () => {
      if (await cl.exists(["namespace", namespace]))
        throw new Error(`${namespace} already exists; refusing to use it`);
      // Intent first: an interrupted run leaves a receipt that names what to clean up.
      await persist();
      created = true;
      await kubectl(["create", "-f", "-"], {
        input: JSON.stringify(namespaceManifest(id, startedAt)),
      });
      const uid = verifyOwnedNamespace(await json(["get", "namespace", namespace]), id);
      return `${namespace} created with owner label ${id} (uid ${uid})`;
    });

    await step("install", async () => {
      log("Installing the chart; this waits for every service and can take up to 20 minutes");
      const result = await timed("install-helm", () =>
        run(
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
      log("Running helm test (the chart's preflight; it starts a short probe Pod, not a worker)");
      // Helm deletes a passing hook Job, so only a failure leaves logs to read.
      const result = await run(helm("test", releaseName, "-n", namespace, "--timeout", "25m"), {
        cwd: root,
        allowFailure: true,
      });
      if (result.code === 0) return "helm test passed (the preflight Job succeeded)";
      const logs = await run(
        ["kubectl", "--context", context, "-n", namespace, "logs", `job/${releaseName}-preflight`],
        { cwd: root, allowFailure: true },
      );
      const lines = logs.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(WARN|FAIL)\b/.test(line));
      // Another installation on a shared node can hold every byte a new worker would need. That
      // is the node's state, not the chart's, so it alone does not fail the install.
      const failed = lines.filter((line) => line.startsWith("FAIL"));
      if (failed.length > 0 && failed.every((line) => /^FAIL\s+node\.budget\b/.test(line)))
        return "helm test passed except node.budget: other installations hold the node's memory";
      throw new Error(
        `helm test failed: ${lines.slice(0, 4).join(" | ") || result.stderr.trim().split("\n").at(-1)}`,
      );
    });

    await step("readiness", async () => {
      const ready = Promise.withResolvers<void>();
      connecting = connectLocalFactory(
        { namespace, release: releaseName, context },
        connection.signal,
        (message) => {
          log(message);
          if (message.startsWith("Local access connected")) ready.resolve();
        },
      );
      connecting.catch((cause: unknown) => ready.reject(cause));
      const timer = setTimeout(
        () => ready.reject(new Error("Port forwards did not connect within five minutes")),
        300_000,
      );
      try {
        await ready.promise;
      } finally {
        clearTimeout(timer);
      }
      let startupID = "";
      await until("public readiness", 600_000, async () => {
        const response = await fetch(`${origin}/health/ready?installation=complete`, {
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });
        await response.body?.cancel();
        const verdict = readinessVerdict(response);
        startupID = verdict.startupID;
        return verdict.ready;
      });
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
      );
      const files = await readdir(directory);
      if (!files.includes("openbao.snap"))
        throw new Error(`Set ${set} has no openbao.snap although OpenBao bootstrapped`);
      let pgRestore = process.env["PG_RESTORE"];
      if (!pgRestore) {
        const local = await run(["pg_restore", "--version"], { allowFailure: true }).catch(
          () => null,
        );
        if (local && local.code === 0 && usablePgRestore(local.stdout)) pgRestore = "pg_restore";
        else if (
          (await run(["docker", "version"], { allowFailure: true }).catch(() => null))?.code === 0
        ) {
          pgRestore = join(temp, "pg_restore");
          await writeFile(
            pgRestore,
            `#!/bin/sh\nexec docker run --rm -i --network none -v "${directory}:${directory}:ro" postgres:16.14-bookworm pg_restore "$@"\n`,
            { mode: 0o755 },
          );
        } else
          return {
            skipped: `Set ${set} was copied and has openbao.snap, but restore-check needs pg_restore 16 or Docker, and neither is available`,
          };
      }
      const checks = await checkSet(directory, pgRestore);
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
  await connecting.catch(() => undefined);
  const cleanupBegin = performance.now();
  if (created && options.keep) {
    receipt.cleanup.state = "kept";
    log(
      `--keep: ${namespace} stays. Reach it with: mise exec -- bun run factory:connect --namespace ${namespace} --release ${releaseName} --context ${context}\nRemove it with: mise exec -- bun run release:clean-room --cleanup ${namespace}`,
    );
  } else if (created) {
    try {
      ownership = await gatherOwnership(cl, namespace);
      const done = await removeRun(cl, id, ownership);
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
  await rm(temp, { recursive: true, force: true });
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
