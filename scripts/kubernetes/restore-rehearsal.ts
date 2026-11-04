// Restore rehearsal. It restores the newest complete backup set of a running installation into a
// scratch installation in its own Namespace, compares the two and deletes the scratch one.
//
//   mise exec -- bun run restore:rehearsal --namespace factory --release factory [--context NAME]
//
// The live installation is only read, apart from one manual backup Job when the newest set is older
// than --max-age-minutes. The scratch installation runs the same chart and image with backups off,
// small scheduling requests and a policy that keeps its Factory from writing outside its own
// Namespace, because the restored database names the live Factorybox worker. No Sandbox starts.
// `--cleanup NAMESPACE` removes what an interrupted run left behind, after checking its label.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSet } from "./restore-check";
import { type Cluster, cluster, pipe, run, until } from "./restore-rehearsal-cluster";
import {
  type BackupEntry,
  type Comparison,
  checksumSQL,
  compareMaps,
  factoryName,
  failedConstraints,
  holdPolicy,
  type Identity,
  jailPolicy,
  keyTables,
  memoryHeadroomMiB,
  namespaceRewriteSQL,
  newestCompleteSet,
  orphanedConstraints,
  parseObjectListing,
  parsePairs,
  receiptName,
  rehearsalIDFromNamespace,
  rehearsalManagedBy,
  rehearsalNamespace,
  rehearsalOwnerLabel,
  restoreErrorCount,
  rewriteInstallationIdentity,
  rewriteServiceNamespace,
  rowCountSQL,
  type Step,
  scratchRequestTotalMiB,
  scratchValues,
  setAgeMinutes,
  summarize,
  toolboxNetworkPolicy,
  toolboxPod,
} from "./restore-rehearsal-model";

const help = `Rehearse a restore of the newest complete backup set into a scratch installation:

  mise exec -- bun run restore:rehearsal [--namespace factory] [--release factory] [--context NAME]
    [--max-age-minutes 60] [--set TIMESTAMP --set-directory DIR] [--values FILE] [--keep]
    [--allow-orphans]
  mise exec -- bun run restore:rehearsal --cleanup factory-restore-rehearsal-<8 hex> [--context NAME]

--set-directory uses a copy of that set from an earlier run instead of copying it again.
--allow-orphans accepts a live database that already violates foreign keys, when the restore
fails on exactly those constraints.
--keep leaves the scratch installation and the temporary files for inspection.
Writes a receipt to .factory/test-results/restore-rehearsal/.`;

type Options = {
  namespace: string;
  release: string;
  context: string;
  maxAgeMinutes: number;
  set: string;
  values: string;
  setDirectory: string;
  keep: boolean;
  allowOrphans: boolean;
  cleanup: string;
};

export function parseOptions(args: string[]): Options {
  const options: Options = {
    namespace: "factory",
    release: "factory",
    context: "",
    maxAgeMinutes: 60,
    set: "",
    values: "",
    setDirectory: "",
    keep: false,
    allowOrphans: false,
    cleanup: "",
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--keep") {
      options.keep = true;
      continue;
    }
    if (flag === "--allow-orphans") {
      options.allowOrphans = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--") || /[\0\r\n]/.test(value)) throw new Error(help);
    if (flag === "--namespace") options.namespace = value;
    else if (flag === "--release") options.release = value;
    else if (flag === "--context") options.context = value;
    else if (flag === "--max-age-minutes") options.maxAgeMinutes = Number(value);
    else if (flag === "--set") options.set = value;
    else if (flag === "--values") options.values = value;
    else if (flag === "--set-directory") options.setDirectory = resolve(value);
    else if (flag === "--cleanup") options.cleanup = value;
    else throw new Error(help);
  }
  if (!Number.isFinite(options.maxAgeMinutes) || options.maxAgeMinutes < 0) throw new Error(help);
  if (Boolean(options.setDirectory) !== Boolean(options.set))
    throw new Error("--set and --set-directory go together.");
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.namespace) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(options.release)
  )
    throw new Error("Use a valid Kubernetes namespace and Helm release name.");
  return options;
}

const root = resolve(import.meta.dir, "../..");
const outputDirectory = resolve(root, ".factory/test-results/restore-rehearsal");
const log = (message: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Removes one rehearsal's resources and nothing else. Every deletion is by the exact name or the
// unique rehearsal label, and the Namespace is only deleted after its owner label matches.
async function removeScratch(
  { kubectl, json, helm }: Cluster,
  namespace: string,
  release: string,
  keepNamespaceOnMismatch = true,
) {
  const id = rehearsalIDFromNamespace(namespace);
  if (!id) throw new Error(`${namespace} is not a restore rehearsal Namespace`);
  const found = await kubectl(["get", "namespace", namespace, "-o", "json"], {
    allowFailure: true,
  });
  const removed: string[] = [];
  if (found.code === 0) {
    const labels = JSON.parse(found.stdout).metadata.labels ?? {};
    if (
      labels[rehearsalOwnerLabel] !== id ||
      labels["app.kubernetes.io/managed-by"] !== rehearsalManagedBy
    ) {
      if (keepNamespaceOnMismatch)
        throw new Error(`${namespace} does not carry the owner label ${id}; nothing was deleted`);
    }
    await run(helm("uninstall", release, "-n", namespace, "--wait", "--timeout", "5m"), {
      allowFailure: true,
    });
    removed.push("release");
  }
  await kubectl(
    [
      "delete",
      "validatingadmissionpolicybinding,validatingadmissionpolicy",
      "-l",
      `${rehearsalOwnerLabel}=${id}`,
      "--ignore-not-found",
    ],
    { allowFailure: true },
  );
  removed.push("policies");
  if (found.code === 0) {
    await kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=10m"]);
    removed.push("namespace");
  }
  const volumes = (await json(["get", "pv"])).items as Array<{
    metadata: { name: string };
    spec?: { claimRef?: { namespace?: string } };
  }>;
  for (const volume of volumes.filter((item) => item.spec?.claimRef?.namespace === namespace)) {
    await kubectl(["delete", "pv", volume.metadata.name, "--wait=false"], { allowFailure: true });
    removed.push(`pv/${volume.metadata.name}`);
  }
  await unlink(join(outputDirectory, `.intent-${id}.json`)).catch(() => undefined);
  return removed;
}

async function main(options: Options) {
  const cl = cluster(options.context);
  const { kube, helm, kubectl, json, apply, exists } = cl;
  if (options.cleanup) {
    const removed = await removeScratch(cl, options.cleanup, options.release);
    log(`Removed ${removed.join(", ")} for ${options.cleanup}`);
    return 0;
  }

  const name = factoryName(options.release);
  const live = {
    namespace: options.namespace,
    postgres: `${name}-postgres-0`,
    forgejo: `${name}-forgejo-0`,
    openbao: `${name}-openbao-0`,
    backupStore: `${name}-backup-store-0`,
  };
  const id = randomBytes(4).toString("hex");
  const scratch = rehearsalNamespace(id);
  const started = new Date();
  const timings: Record<string, number> = {};
  const steps: Step[] = [];
  const evidence: Record<string, unknown> = {};
  const temp = await mkdtemp(join(tmpdir(), "restore-rehearsal-"));
  const intentFile = join(outputDirectory, `.intent-${id}.json`);
  const forwards: Array<ReturnType<typeof Bun.spawn>> = [];
  let manualJob = "";
  let pendingCopy: Promise<unknown> = Promise.resolve();
  let quietBefore: { counts: Map<string, string>; sums: Map<string, string> } | undefined;
  let created = false;
  let failure = "";
  let cleanedUp = false;

  const timed = async <T>(label: string, work: () => Promise<T>) => {
    const begin = performance.now();
    try {
      return await work();
    } finally {
      timings[label] = Math.round(performance.now() - begin);
      log(`${label} took ${(timings[label] / 1000).toFixed(1)}s`);
    }
  };
  const record = (step: string, ok: boolean, detail: string) => {
    steps.push({ name: step, ok, detail });
    log(`${ok ? "ok  " : "FAIL"} ${step}: ${detail}`);
  };
  const compared = (step: string, result: Comparison, noun: string) => {
    record(
      step,
      result.equal,
      result.equal
        ? `${result.compared} ${noun} equal`
        : `${noun} differ: missing ${result.missing.join(",")}; extra ${result.extra.join(",")}; changed ${result.different.map((item) => item.key).join(",")}`,
    );
    return result;
  };
  const psql = async (namespace: string, pod: string, sql: string, database = "factory") =>
    (
      await kubectl([
        "exec",
        "-n",
        namespace,
        pod,
        "--",
        "psql",
        "-U",
        "factory",
        "-d",
        database,
        "-X",
        "-At",
        "-c",
        sql,
      ])
    ).stdout;
  const podReady = (namespace: string, pod: string, timeoutMs: number) =>
    until(`${pod} to be ready`, timeoutMs, async () => {
      const status = await kubectl(
        [
          "-n",
          namespace,
          "get",
          "pod",
          pod,
          "-o",
          'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
        ],
        { allowFailure: true },
      );
      return status.stdout === "True";
    });

  try {
    await mkdir(outputDirectory, { recursive: true });

    // ---- The live installation and its newest complete backup set.
    const jsonpath = (target: string[], path: string) =>
      kubectl(["-n", live.namespace, "get", ...target, "-o", `jsonpath=${path}`]).then((result) =>
        result.stdout.trim(),
      );
    const image = await jsonpath(["deploy", name], "{.spec.template.spec.containers[0].image}");
    const rcloneImage = await jsonpath(
      ["sts", `${name}-backup-store`],
      "{.spec.template.spec.containers[0].image}",
    );
    if (!image || !rcloneImage) throw new Error("The live image or backup store was not found");
    const liveValues: Record<string, unknown> = options.values
      ? (Bun.YAML.parse(await readFile(options.values, "utf8")) as Record<string, unknown>)
      : JSON.parse(
          (await run(helm("get", "values", options.release, "-n", live.namespace, "-o", "json")))
            .stdout,
        );

    const databaseFacts = async (namespace: string, pod: string) => ({
      counts: parsePairs(await psql(namespace, pod, rowCountSQL)),
      sums: parsePairs(await psql(namespace, pod, checksumSQL(keyTables))),
    });

    // A bulk delete with triggers disabled leaves rows whose parents are gone. pg_dump still
    // writes them and pg_restore then fails to recreate the foreign key, so look first.
    const foreignKeysSQL = await readFile(
      join(root, "deploy/helm/factory/files/backup/foreign-keys.sql"),
      "utf8",
    );
    const orphans = orphanedConstraints(await psql(live.namespace, live.postgres, foreignKeysSQL));
    evidence["liveForeignKeyViolations"] = orphans;
    record(
      "live foreign keys",
      orphans.length === 0 || options.allowOrphans,
      orphans.length
        ? `${orphans.map((item) => `${item.constraint}: ${item.rows} rows`).join("; ")}${options.allowOrphans ? " (accepted by --allow-orphans)" : ""}`
        : "every row has its parent rows",
    );
    if (orphans.length && !options.set && !options.allowOrphans)
      throw new Error(
        "The live database has rows that violate its foreign keys, so its backup cannot be restored cleanly. Repair them, or name an earlier set with --set.",
      );

    const listSets = async () =>
      (
        await kubectl([
          "exec",
          "-n",
          live.namespace,
          live.backupStore,
          "--",
          "sh",
          "-c",
          'for d in /backup/[0-9]*T*Z; do [ -d "$d" ] && printf "%s %s\\n" "$(basename "$d")" "$([ -f "$d/COMPLETE" ] && echo 1 || echo 0)"; done; true',
        ])
      ).stdout
        .split("\n")
        .filter(Boolean)
        .map((line): BackupEntry => {
          const [setName = "", complete = "0"] = line.split(" ");
          return { name: setName, complete: complete === "1" };
        });
    let set = options.set || newestCompleteSet(await listSets());
    if (!options.set && (!set || setAgeMinutes(set, new Date()) > options.maxAgeMinutes)) {
      manualJob = `backup-rehearsal-${id}`;
      quietBefore = await databaseFacts(live.namespace, live.postgres);
      await timed("backup", async () => {
        log(`The newest complete set is ${set ?? "missing"}; taking a backup with ${manualJob}`);
        await kubectl([
          "-n",
          live.namespace,
          "create",
          "job",
          manualJob,
          `--from=cronjob/${name}-backup`,
        ]);
        await kubectl([
          "-n",
          live.namespace,
          "wait",
          "--for=condition=complete",
          `job/${manualJob}`,
          "--timeout=30m",
        ]);
      });
      set = newestCompleteSet(await listSets());
    }
    if (!set) throw new Error("The live installation has no complete backup set");
    const age = setAgeMinutes(set, new Date());

    // ---- Copy it to the workstation. The Forgejo archive is most of the bytes and kubectl exec is
    // slow, so it travels while the scratch installation is being created.
    const setDirectory = options.setDirectory || join(temp, "set");
    if (!options.setDirectory) {
      await mkdir(setDirectory);
      const fromStore = (...command: string[]) =>
        kube("exec", "-n", live.namespace, live.backupStore, "--", ...command);
      const archiveName = "forgejo.tar.gz";
      await timed("copy", () =>
        pipe(
          fromStore(
            "sh",
            "-c",
            `cd /backup/${set} && tar -cf - $(ls | grep -v '^${archiveName}$')`,
          ),
          ["tar", "-xf", "-", "-C", setDirectory],
        ),
      );
      pendingCopy = timed("copy-forgejo-archive", () =>
        pipe(fromStore("tar", "-C", `/backup/${set}`, "-cf", "-", archiveName), [
          "tar",
          "-xf",
          "-",
          "-C",
          setDirectory,
        ]),
      );
    }

    const member = async (archive: string, path: string) =>
      (await run(["tar", "-xzOf", join(setDirectory, archive), path])).stdout;
    const bootstrap = JSON.parse(await member("state.tar.gz", "./openbao/bootstrap.json")) as {
      keys_base64: string[];
    };
    const factoryLogin = JSON.parse(
      await member("state.tar.gz", "./openbao/factory-login.json"),
    ) as {
      role_id: string;
      secret_id: string;
    };
    const retainedIdentity = await member("state.tar.gz", "./kubernetes-installation.json");

    // ---- What the live installation holds, read straight after the backup.
    const forgejoFacts = async (namespace: string, pod: string) =>
      parsePairs(
        (
          await kubectl(["exec", "-i", "-n", namespace, pod, "-c", "forgejo", "--", "sh", "-s"], {
            input: `set -eu
cd /var/lib/gitea/git/repositories
repos=$(find . -maxdepth 2 -name '*.git' | sort)
for r in $repos; do
  echo "repo:$r|$(git --git-dir="$r" rev-parse HEAD)|$(git --git-dir="$r" for-each-ref --format='%(objectname) %(refname)' | sort | sha256sum | cut -c1-16)"
done
echo "users|$(forgejo admin user list | sha256sum | cut -c1-16)"
T=$(cat /var/lib/gitea/factory-bootstrap/factory-mutation)
for r in $repos; do
  repo=$(echo "$r" | sed 's#^\\./##; s#\\.git$##')
  body=$(wget -qO- --header "Authorization: token $T" "http://127.0.0.1:3000/api/v1/repos/$repo/branches/main" || echo '{}')
  echo "api:$repo|$(printf '%s' "$body" | sed -n 's/.*"commit":{"id":"\\([0-9a-f]*\\)".*/\\1/p')"
done
`,
          })
        ).stdout,
      );
    const secretKeys = (
      await psql(
        live.namespace,
        live.postgres,
        "SELECT k FROM (SELECT secret_key AS k FROM factory.model_connection_version UNION SELECT secret_key FROM factory.mcp_connection UNION SELECT secret_key FROM factory.project_environment UNION SELECT secret_key FROM factory.release_access) s WHERE k IS NOT NULL ORDER BY 1",
      )
    )
      .split("\n")
      .filter(Boolean);
    // Reads every stored secret path as Factory's own AppRole and prints a digest per path, never
    // the value. That AppRole may not revoke its token, so the 24 hour token expires by itself.
    const secretFacts = async (namespace: string, pod: string) =>
      parsePairs(
        (
          await kubectl(["exec", "-i", "-n", namespace, pod, "-c", "openbao", "--", "sh", "-s"], {
            input: `set -eu
export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt
BAO_TOKEN=$(bao write -field=token auth/approle/login role_id=${quote(factoryLogin.role_id)} secret_id=${quote(factoryLogin.secret_id)})
export BAO_TOKEN
${secretKeys.map((key) => `echo ${quote(`${key}|`)}"$(bao kv get -mount=factory ${quote(key)} 2>/dev/null | sha256sum | cut -c1-16)"`).join("\n")}
`,
          })
        ).stdout,
      );
    const liveDatabase = await databaseFacts(live.namespace, live.postgres);
    if (quietBefore) {
      const moved = compareMaps(quietBefore.sums, liveDatabase.sums).different;
      if (moved.length)
        throw new Error(
          `The live database changed while it was backed up (${moved.map((item) => item.key).join(", ")}); run the rehearsal again when it is idle.`,
        );
    }
    const liveForgejo = await forgejoFacts(live.namespace, live.forgejo);
    // The holder container has a 32 MiB limit, too little for rclone, so find lists the mirror.
    const liveObjects = parseObjectListing(
      (
        await kubectl([
          "exec",
          "-n",
          live.namespace,
          live.backupStore,
          "--",
          "sh",
          "-c",
          "cd /backup/objects && find . -type f -exec stat -c '%s;%n' {} + | sed 's#;\\./#;#'",
        ])
      ).stdout,
    );
    const liveSecrets = await secretFacts(live.namespace, live.openbao);
    log(
      `Live: ${liveDatabase.counts.size} tables, ${liveObjects.size} objects, ${liveForgejo.size} Forgejo facts, ${secretKeys.length} secret paths`,
    );

    // Pods and claims of every Sandbox, worker and editor Namespace. The scratch Factory must not
    // touch them, and the jail policy is what guarantees that, so compare them afterwards.
    const runtimeFingerprint = async () => {
      const namespaces = (
        (
          await json([
            "get",
            "namespaces",
            "-l",
            "app.kubernetes.io/managed-by=open-software-factory",
          ])
        ).items as Array<{ metadata: { name: string } }>
      )
        .map((item) => item.metadata.name)
        .filter((item) => !item.startsWith("factory-storage-check-"));
      const lines: string[] = [];
      for (const namespace of namespaces) {
        const items = (await json(["-n", namespace, "get", "pods,pvc"])).items as Array<{
          kind: string;
          metadata: { name: string; uid: string };
        }>;
        for (const item of items)
          lines.push(`${namespace}/${item.kind}/${item.metadata.name}/${item.metadata.uid}`);
      }
      return lines.sort();
    };
    const runtimeBefore = await runtimeFingerprint();

    // ---- The node must have room for the scratch installation.
    const nodeName =
      (liveValues["factorybox"] as { nodeName?: string } | undefined)?.nodeName ||
      (await json(["get", "nodes"])).items[0].metadata.name;
    const node = await json(["get", "node", nodeName]);
    const pods = (
      await json(["get", "pods", "-A", "--field-selector", `spec.nodeName=${nodeName}`])
    ).items;
    const headroom = Math.round(memoryHeadroomMiB(node.status.allocatable.memory, pods));
    const needed = scratchRequestTotalMiB() + 128;
    evidence["scheduling"] = { node: nodeName, headroomMiB: headroom, neededMiB: needed };
    if (headroom < needed)
      throw new Error(
        `Node ${nodeName} has ${headroom} MiB of unrequested memory; the scratch installation needs ${needed} MiB`,
      );

    // ---- The scratch Namespace, its policies, copied Secrets and the chart.
    const freePort = () => {
      const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = server.port;
      server.stop(true);
      return port;
    };
    const values = scratchValues(liveValues, { release: options.release, image });
    const valuesFile = join(temp, "values.yaml");
    await writeFile(valuesFile, Bun.YAML.stringify(values, null, 2), { mode: 0o600 });
    const identity: Identity = {
      namespace: scratch,
      release: options.release,
      factoryURL: String(values["publicURL"]),
      forgeURL: String(values["forgejoPublicURL"]),
      storageClass: String(values["storageClass"] ?? ""),
    };
    const inScratch = (manifest: { metadata: Record<string, unknown> }) =>
      apply({ ...manifest, metadata: { ...manifest.metadata, namespace: scratch } });
    const asFactory = (target: string) =>
      kubectl(
        [
          "--as",
          `system:serviceaccount:${scratch}:${name}`,
          "-n",
          target,
          "create",
          "secret",
          "generic",
          "rehearsal-jail-probe",
          "--dry-run=server",
        ],
        { allowFailure: true },
      );

    await writeFile(
      intentFile,
      JSON.stringify({
        id,
        namespace: scratch,
        release: options.release,
        context: options.context,
        startedAt: started.toISOString(),
      }),
    );
    created = true;
    await timed("install", async () => {
      await apply({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: scratch,
          labels: { [rehearsalOwnerLabel]: id, "app.kubernetes.io/managed-by": rehearsalManagedBy },
        },
      });
      for (const manifest of [...holdPolicy(id), ...jailPolicy(id, scratch, name)])
        await apply(manifest);
      const holdProbe = JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "rehearsal-hold-probe",
          namespace: scratch,
          labels: { "app.kubernetes.io/component": "factory" },
        },
        spec: { containers: [{ name: "probe", image: "probe" }] },
      });
      await until(
        "the hold policy",
        60_000,
        async () =>
          (
            await kubectl(["create", "--dry-run=server", "-f", "-"], {
              input: holdProbe,
              allowFailure: true,
            })
          ).code !== 0,
      );
      for (const secret of [
        `${name}-credentials`,
        `${name}-objects`,
        String(liveValues["registryCASecret"] ?? ""),
      ].filter(Boolean)) {
        const source = await json(["-n", live.namespace, "get", "secret", secret]);
        await inScratch({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: secret, labels: { [rehearsalOwnerLabel]: id } },
          type: source.type,
          data: source.data,
        } as never);
      }
      await run(
        helm(
          "install",
          options.release,
          join(root, "deploy/helm/factory"),
          "-n",
          scratch,
          "--values",
          valuesFile,
          "--timeout",
          "10m",
        ),
        { cwd: root },
      );
      await inScratch(toolboxNetworkPolicy(id, options.release));
      await until(
        "the jail policy",
        60_000,
        async () => (await asFactory(live.namespace)).code !== 0,
      );
      if ((await asFactory(scratch)).code !== 0)
        throw new Error("The jail policy also blocks the scratch Namespace");
      for (const pod of [
        `${name}-postgres-0`,
        `${name}-objects-0`,
        `${name}-forgejo-0`,
        `${name}-openbao-0`,
      ])
        await podReady(scratch, pod, 600_000);
    });
    record(
      "isolation",
      true,
      `Factory's ServiceAccount cannot write to ${live.namespace}; Factory and Zero stay held until the data is restored`,
    );

    await pendingCopy;
    let bytes = 0;
    for (const file of await readdir(setDirectory))
      bytes += (await stat(join(setDirectory, file))).size;
    let pgRestore = process.env["PG_RESTORE"];
    if (!pgRestore && (await run(["which", "pg_restore"], { allowFailure: true })).code !== 0) {
      pgRestore = join(temp, "pg_restore");
      await writeFile(
        pgRestore,
        `#!/bin/sh\nexec docker run --rm -i --network host -v "${setDirectory}:${setDirectory}:ro" postgres:16.14-bookworm pg_restore "$@"\n`,
        { mode: 0o755 },
      );
    }
    const checks = await checkSet(setDirectory, pgRestore);
    record(
      "set check",
      checks.every((check) => check.ok),
      checks.map((check) => `${check.name}: ${check.detail}`).join("; "),
    );
    if (!checks.every((check) => check.ok)) throw new Error("The backup set failed its own check");
    evidence["source"] = {
      namespace: live.namespace,
      release: options.release,
      set,
      ageMinutes: Number(age.toFixed(1)),
      bytes,
      manualBackup: Boolean(manualJob),
    };

    // ---- Restore in the documented order, with the owning workloads stopped.
    const scale = async (kind: string, replicas: number, ...targets: string[]) => {
      for (const target of targets)
        await kubectl(["-n", scratch, "scale", kind, target, `--replicas=${replicas}`]);
    };
    await timed("stop", async () => {
      await scale("sts", 0, `${name}-forgejo`, `${name}-openbao`);
      await until("Forgejo and OpenBao to stop", 180_000, async () => {
        const pods = await json([
          "-n",
          scratch,
          "get",
          "pods",
          "-l",
          "app.kubernetes.io/component in (forgejo,openbao,factory,zero)",
        ]);
        return pods.items.length === 0;
      });
      for (const claim of [
        `data-${name}-zero-0`,
        `data-${name}-forgejo-0`,
        `config-${name}-forgejo-0`,
        `data-${name}-openbao-0`,
        `${name}-state`,
      ])
        await until(`claim ${claim}`, 60_000, () => exists(["-n", scratch, "pvc", claim]));
    });

    await timed("postgres", async () => {
      await kubectl([
        "exec",
        "-n",
        scratch,
        `${name}-postgres-0`,
        "--",
        "psql",
        "-U",
        "factory",
        "-d",
        "postgres",
        "-c",
        "DROP DATABASE factory WITH (FORCE)",
        "-c",
        "CREATE DATABASE factory OWNER factory",
      ]);
      const restored = await run(
        kube(
          "exec",
          "-i",
          "-n",
          scratch,
          `${name}-postgres-0`,
          "--",
          "pg_restore",
          "--no-owner",
          "-U",
          "factory",
          "-d",
          "factory",
        ),
        { input: Bun.file(join(setDirectory, "postgres.dump")), allowFailure: true },
      );
      const failed = failedConstraints(restored.stderr);
      const errors = restoreErrorCount(restored.stderr);
      evidence["pgRestore"] = {
        exitCode: restored.code,
        errors,
        foreignKeysNotRecreated: failed,
        diagnostics: restored.stderr.trim().split("\n").filter(Boolean).slice(0, 10),
      };
      if (restored.code === 0) return;
      // A source that already violates its foreign keys restores as faithfully as it can: exactly
      // those constraints fail to come back and nothing else does.
      const known = orphans.map((item) => item.constraint).sort();
      if (
        !options.allowOrphans ||
        errors !== failed.length ||
        JSON.stringify(failed) !== JSON.stringify(known)
      )
        throw new Error(
          `pg_restore exited ${restored.code}: ${restored.stderr.trim().split("\n").slice(0, 3).join(" | ")}`,
        );
      record(
        "restore matches live integrity",
        true,
        `pg_restore could not recreate ${failed.length} foreign keys, the same ones the live database violates`,
      );
    });
    const restoredDatabase = await databaseFacts(scratch, `${name}-postgres-0`);
    // The restored rows record in-cluster addresses of the live Namespace. A restore into the same
    // Namespace needs none of this.
    const rewritten = await kubectl(
      [
        "exec",
        "-i",
        "-n",
        scratch,
        `${name}-postgres-0`,
        "--",
        "psql",
        "-U",
        "factory",
        "-d",
        "factory",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: namespaceRewriteSQL(live.namespace, scratch) },
    );
    evidence["namespaceRewrite"] = rewritten.stdout
      .split("\n")
      .filter((line) => line.startsWith("UPDATE"))
      .map((line) => Number(line.split(" ")[1]));

    const toolbox = "restore-toolbox";
    const inToolbox = (...command: string[]) =>
      kube("exec", "-i", "-n", scratch, toolbox, "--", ...command);
    let restoredObjects = new Map<string, string>();
    await timed("files", async () => {
      const objectsKiB = Number(
        (
          await kubectl([
            "exec",
            "-n",
            live.namespace,
            live.backupStore,
            "--",
            "du",
            "-sk",
            "/backup/objects",
          ])
        ).stdout.split("\t")[0] ?? "0",
      );
      await inScratch(
        toolboxPod({
          id,
          name: toolbox,
          image: rcloneImage,
          release: options.release,
          scratchGiB: Math.ceil((objectsKiB * 2) / 1024 / 1024 + bytes / 1024 ** 3) + 1,
          objectsSecret: `${name}-objects`,
          objectsEndpoint: `http://${name}-objects.${scratch}.svc:3900`,
        }),
      );
      await podReady(scratch, toolbox, 300_000);
      // These claims belong to a new installation. Empty them so nothing from its first start mixes
      // with the restored files.
      await run(
        inToolbox(
          "sh",
          "-c",
          "find /var/lib/gitea /etc/gitea /zero /bao/data /var/lib/factory -mindepth 1 -delete",
        ),
      );

      // Forgejo. The SQL dump rebuilds the database; the raw copy was taken while Forgejo ran.
      const forgejoDatabase = join(temp, "forgejo.db");
      const forgejoSQL = (
        await run(["tar", "-xzOf", join(setDirectory, "forgejo.tar.gz"), "forgejo-db.sql"])
      ).stdout;
      await run(["sqlite3", forgejoDatabase], {
        input: rewriteServiceNamespace(forgejoSQL, live.namespace, scratch),
      });
      const archive = "/restore/forgejo.tar.gz";
      await run(inToolbox("sh", "-c", `cat > ${archive}`), {
        input: Bun.file(join(setDirectory, "forgejo.tar.gz")),
      });
      // BusyBox tar matches --exclude patterns against the whole member name, and cannot select a
      // directory by name, so each part excludes the others.
      await run(
        inToolbox(
          "tar",
          "-xzf",
          archive,
          "-C",
          "/var/lib/gitea",
          "--strip-components=1",
          "--exclude",
          "repos*",
          "--exclude",
          "app.ini",
          "--exclude",
          "forgejo-db.sql",
          "--exclude",
          "data/data/forgejo.db*",
        ),
      );
      await run(
        inToolbox(
          "sh",
          "-c",
          `mkdir -p /var/lib/gitea/git/repositories && tar -xzf ${archive} -C /var/lib/gitea/git/repositories --strip-components=1 --exclude 'data*' --exclude app.ini --exclude forgejo-db.sql`,
        ),
      );
      await run(inToolbox("tar", "-xzf", archive, "-C", "/etc/gitea", "app.ini"));
      await run(inToolbox("rm", archive));
      await run(inToolbox("sh", "-c", "cat > /var/lib/gitea/data/forgejo.db"), {
        input: Bun.file(forgejoDatabase),
      });
      await run(inToolbox("chown", "-R", "1000:1000", "/var/lib/gitea", "/etc/gitea"));

      // Objects. The mirror sits beside the sets, so it is streamed rather than copied with one.
      await pipe(
        kube(
          "exec",
          "-n",
          live.namespace,
          live.backupStore,
          "--",
          "tar",
          "-C",
          "/backup",
          "-cf",
          "-",
          "objects",
        ),
        inToolbox("tar", "-xf", "-", "-C", "/restore"),
      );
      await run(
        inToolbox("rclone", "sync", "/restore/objects", "s3:factory", "--create-empty-src-dirs"),
      );
      await run(inToolbox("rclone", "check", "/restore/objects", "s3:factory", "--size-only"));
      restoredObjects = parseObjectListing(
        (
          await run(
            inToolbox("rclone", "lsf", "-R", "--files-only", "--format", "sp", "s3:factory"),
          )
        ).stdout,
      );

      // Factory state. A rehearsal runs in another Namespace, so the identity file is rewritten.
      await run(inToolbox("tar", "-xzf", "-", "-C", "/var/lib/factory"), {
        input: Bun.file(join(setDirectory, "state.tar.gz")),
      });
      const identityFile = "/var/lib/factory/kubernetes-installation.json";
      await run(
        inToolbox(
          "sh",
          "-c",
          `cat > ${identityFile} && chmod 600 ${identityFile} && chown 1000:1000 ${identityFile}`,
        ),
        { input: rewriteInstallationIdentity(retainedIdentity, identity) },
      );
      await kubectl(["-n", scratch, "delete", "pod", toolbox, "--wait=true"]);
    });

    await timed("openbao", async () => {
      await scale("sts", 1, `${name}-openbao`);
      const pod = `${name}-openbao-0`;
      const bao = (script: string, input?: string | Blob) =>
        kubectl(["exec", "-i", "-n", scratch, pod, "-c", "openbao", "--", "sh", "-s"], {
          input: `export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt\n${script}\n${input ?? ""}`,
          allowFailure: true,
        });
      const status = async () =>
        JSON.parse((await bao("bao status -format=json || true")).stdout || "{}") as {
          initialized?: boolean;
          sealed?: boolean;
        };
      await until("OpenBao to answer", 180_000, async () => "initialized" in (await status()));
      const init = JSON.parse(
        (await bao("exec bao operator init -key-shares=1 -key-threshold=1 -format=json")).stdout,
      ) as { unseal_keys_b64: string[]; root_token: string };
      await run(
        kube(
          "exec",
          "-i",
          "-n",
          scratch,
          pod,
          "-c",
          "openbao",
          "--",
          "sh",
          "-c",
          "cat > /tmp/openbao.snap",
        ),
        {
          input: Bun.file(join(setDirectory, "openbao.snap")),
        },
      );
      const restored = await bao(
        `set -eu\nbao operator unseal ${quote(init.unseal_keys_b64[0] ?? "")} >/dev/null\nBAO_TOKEN=${quote(init.root_token)} bao operator raft snapshot restore -force /tmp/openbao.snap`,
      );
      if (restored.code !== 0)
        throw new Error(
          `The OpenBao snapshot restore failed: ${restored.stderr.trim().split("\n").slice(-2).join(" | ")}`,
        );
      // The restore reseals OpenBao and drops the temporary key and root token.
      await until("OpenBao to reseal", 60_000, async () => (await status()).sealed === true);
      const original = bootstrap.keys_base64[0] ?? "";
      const unsealed = await bao(
        `bao operator unseal ${quote(original)} >/dev/null && rm /tmp/openbao.snap`,
      );
      if (unsealed.code !== 0)
        throw new Error("The original unseal key did not open the restored OpenBao");
      await until("OpenBao to unseal", 60_000, async () => (await status()).sealed === false);
    });

    // ---- Start everything and wait for readiness.
    await timed("start", async () => {
      await kubectl(["delete", "validatingadmissionpolicybinding", `restore-rehearsal-hold-${id}`]);
      await scale("sts", 1, `${name}-forgejo`, `${name}-zero`);
      await scale("deploy", 0, name);
      await scale("deploy", 1, name);
      await podReady(scratch, `${name}-forgejo-0`, 300_000);
      await kubectl(["-n", scratch, "rollout", "status", `deploy/${name}`, "--timeout=20m"], {});
    });

    // ---- Compare.
    const forward = async (pod: string, port: number) => {
      const child = Bun.spawn(kube("port-forward", "-n", scratch, `pod/${pod}`, `${port}:3000`), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      forwards.push(child);
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const deadline = Date.now() + 30_000;
      while (!seen.includes("Forwarding") && Date.now() < deadline) {
        const read = await reader.read();
        if (read.done) break;
        seen += decoder.decode(read.value);
      }
      reader.releaseLock();
    };
    await timed("verify", async () => {
      // Tables that changed while the backup ran (sessions, read versions, lifecycle records of the
      // running installation) are expected to differ. Everything else, and every key table, must not.
      const changing = new Set(
        quietBefore
          ? compareMaps(quietBefore.counts, liveDatabase.counts).different.map((item) => item.key)
          : [],
      );
      const stable = (facts: Map<string, string>) =>
        new Map([...facts].filter(([table]) => !changing.has(table)));
      const keyOnly = (facts: Map<string, string>) =>
        new Map([...facts].filter(([table]) => (keyTables as readonly string[]).includes(table)));
      const tables = compared(
        "postgres row counts",
        compareMaps(stable(liveDatabase.counts), stable(restoredDatabase.counts)),
        quietBefore ? "tables outside the ones that were changing" : "tables",
      );
      const keyCounts = compared(
        "postgres key table counts",
        compareMaps(keyOnly(liveDatabase.counts), keyOnly(restoredDatabase.counts)),
        "key tables",
      );
      const keyRows = compared(
        "postgres key table rows",
        compareMaps(liveDatabase.sums, restoredDatabase.sums),
        "key table checksums",
      );
      evidence["postgres"] = {
        tables: liveDatabase.counts.size,
        tablesChangingDuringBackup: [...changing],
        keyTables: Object.fromEntries(
          keyTables.map((table) => [
            table,
            {
              live: Number(liveDatabase.counts.get(table)),
              restored: Number(restoredDatabase.counts.get(table)),
              rowsEqual: liveDatabase.sums.get(table) === restoredDatabase.sums.get(table),
            },
          ]),
        ),
        tablesDiffering: compareMaps(liveDatabase.counts, restoredDatabase.counts).different.map(
          (item) => ({ table: item.key, live: Number(item.live), restored: Number(item.scratch) }),
        ),
        allEqual: tables.equal && keyCounts.equal && keyRows.equal,
      };

      const scratchForgejo = await forgejoFacts(scratch, `${name}-forgejo-0`);
      const forgejo = compared(
        "forgejo repositories, heads and users",
        compareMaps(liveForgejo, scratchForgejo),
        "facts",
      );
      evidence["forgejo"] = {
        facts: liveForgejo.size,
        equal: forgejo.equal,
        repositories: [...liveForgejo.keys()].filter((key) => key.startsWith("repo:")).length,
      };

      const objects = compared(
        "object store listing",
        compareMaps(liveObjects, restoredObjects),
        "objects",
      );
      evidence["objects"] = { count: liveObjects.size, equal: objects.equal };

      const scratchSecrets = await secretFacts(scratch, `${name}-openbao-0`);
      const readable = [...scratchSecrets.values()].filter(
        (digest) => digest !== "e3b0c44298fc1c14",
      ).length;
      compared("openbao secrets", compareMaps(liveSecrets, scratchSecrets), "secret paths");
      record(
        "openbao readable",
        readable > 0 && readable === secretKeys.length,
        `${readable} of ${secretKeys.length} stored secret paths read as Factory's AppRole`,
      );
      evidence["openbao"] = { secretPaths: secretKeys.length, readable };

      const logs = (await kubectl(["-n", scratch, "logs", `deploy/${name}`, "--tail=-1"])).stdout;
      const openbaoErrors = logs
        .split("\n")
        .filter(
          (line) =>
            /openbao/i.test(line) && /(error|fail|denied|refused|sealed|forbidden)/i.test(line),
        );
      record(
        "factory log",
        openbaoErrors.length === 0 && logs.includes("installation is ready"),
        `${openbaoErrors.length} OpenBao error lines; ready line ${logs.includes("installation is ready") ? "present" : "missing"}`,
      );

      const localPort = freePort();
      await forward(
        (await json(["-n", scratch, "get", "pods", "-l", "app.kubernetes.io/component=factory"]))
          .items[0].metadata.name,
        localPort,
      );
      const origin = `http://127.0.0.1:${localPort}`;
      const health = await fetch(`${origin}/health/ready?installation=complete`, {
        signal: AbortSignal.timeout(10_000),
      });
      await health.body?.cancel();
      record("factory health", health.ok, `/health/ready answered ${health.status}`);
      const password = Buffer.from(
        (await json(["-n", scratch, "get", "secret", `${name}-credentials`])).data[
          "admin-password"
        ],
        "base64",
      ).toString();
      const email = String(liveValues["adminEmail"] ?? "admin@factory.local");
      const login = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: String(identity.factoryURL), "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(20_000),
      });
      await login.body?.cancel();
      record(
        "admin sign-in",
        login.ok && login.headers.getSetCookie().length > 0,
        `${email} signed in with HTTP ${login.status}`,
      );

      const denials = logs
        .split("\n")
        .filter((line) => line.includes("restore-rehearsal-jail")).length;
      const runtimeAfter = await runtimeFingerprint();
      record(
        "live runtime untouched",
        JSON.stringify(runtimeBefore) === JSON.stringify(runtimeAfter),
        `${runtimeAfter.length} Sandbox, worker and editor Pods and claims unchanged; the scratch Factory's attempts were denied (${denials} log lines)`,
      );
      evidence["isolation"] = { jailDeniedLogLines: denials, runtimeObjects: runtimeBefore.length };

      const afterStart = await databaseFacts(scratch, `${name}-postgres-0`);
      const keyAfter = compareMaps(keyOnly(restoredDatabase.counts), keyOnly(afterStart.counts));
      compared("key table counts after start", keyAfter, "key tables");
    });
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
    log(`FAILED: ${failure}`);
  }

  for (const child of forwards) child.kill();
  await pendingCopy.catch(() => undefined);
  const cleanupStart = performance.now();
  const cleanupErrors: string[] = [];
  if (manualJob)
    await kubectl(["-n", live.namespace, "delete", "job", manualJob, "--ignore-not-found"], {
      allowFailure: true,
    }).catch((cause) => cleanupErrors.push(String(cause)));
  if (created && !options.keep) {
    try {
      const removed = await removeScratch(cl, scratch, options.release);
      cleanedUp = true;
      log(`Removed ${removed.join(", ")}`);
    } catch (cause) {
      cleanupErrors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (!options.keep) await rm(temp, { recursive: true, force: true });
  timings["cleanup"] = Math.round(performance.now() - cleanupStart);
  const finished = new Date();
  const summary = summarize(steps);
  const ok =
    summary.ok && !failure && cleanupErrors.length === 0 && (!created || cleanedUp || options.keep);
  const receipt = {
    ok,
    id,
    scratchNamespace: created ? scratch : null,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    timingsMs: timings,
    ...evidence,
    steps,
    failure: failure || undefined,
    cleanup: {
      namespaceDeleted: cleanedUp,
      errors: cleanupErrors,
      manualBackupJob: manualJob || undefined,
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const file = join(outputDirectory, receiptName(finished));
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  log(`${ok ? "PASS" : "FAIL"}: ${summary.passed}/${steps.length} checks; receipt ${file}`);
  return ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(parseOptions(process.argv.slice(2)));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
