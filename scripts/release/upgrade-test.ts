// Release upgrade test. It installs a previous Factory build in a fresh namespace, seeds data through
// the product's own paths, upgrades the chart to the new build and proves that nothing was lost.
//
//   mise exec -- bun run release:upgrade-test --from-chart git:7b339b88 \
//     --from-image open-software-factory:release-7b339b88 --to-chart deploy/helm/factory \
//     --to-image open-software-factory:release-NEW --node orbstack --values private-values.yaml
//
// It owns one namespace, `factory-upgrade-<8 hex>`, labelled with this run's id. Cleanup deletes
// that namespace and its claims after checking the label, and touches nothing else. It starts no
// Factorybox worker and no Sandbox. See docs/development/README.md for what it promises.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { S3Client } from "bun";
import { type Cluster, cluster, pipe, run, until } from "../kubernetes/restore-rehearsal-cluster";
import { factoryName } from "../kubernetes/restore-rehearsal-model";
import { seedThroughBrowser, verifyThroughBrowser } from "./upgrade-test-browser";
import {
  assignmentSQL,
  type ChartSource,
  type Claim,
  catalogSQL,
  claimOwnership,
  type Diff,
  diffFingerprints,
  type Fingerprint,
  formatDiff,
  help,
  ignoredTable,
  managedByValue,
  type MemoryPlan,
  memoryPlan,
  newRuntimeNamespaces,
  noopRules,
  type Options,
  ownedVolumes,
  ownerLabel,
  parseCatalog,
  parseOptions,
  parsePaths,
  parseRowLines,
  requireOwnedNamespace,
  rollbackExpectation,
  secretKeysSQL,
  secretReadScript,
  secretWriteScript,
  seedSQL,
  snapshotSQL,
  summarize,
  unexpectedConsole,
  unreadableSecrets,
  upgradeIDFromNamespace,
  upgradeNamespace,
  upgradeRules,
  upgradeValues,
} from "./upgrade-test-model";

const root = resolve(import.meta.dir, "../..");
const outputDirectory = resolve(root, ".factory/test-results/upgrade-test");
const adminEmail = "admin@factory.local";
const projectSlug = "upgrade-starter";
const projectName = "Upgrade starter";

type Step = { name: string; ok: boolean; seconds: number; detail: string };
type Check = { name: string; ok: boolean; detail: string };
type Seeded = { what: string; how: string; detail: string };

const log = (message: string) => console.log(`[upgrade-test] ${message}`);
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const quietSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

async function freePorts(): Promise<[number, number, number, number]> {
  const reservations = Array.from({ length: 4 }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) }),
  );
  try {
    const [a, b, c, d] = reservations.map((server) => server.port ?? 0);
    if (!a || !b || !c || !d) throw new Error("No free ports");
    return [a, b, c, d];
  } finally {
    await Promise.all(reservations.map((server) => server.stop(true)));
  }
}

// ---- Cleanup

// Removes one run's resources and nothing else. The namespace is only deleted after its owner and
// managed-by labels match, every claim is this run's, and each deletion names the run's label.
async function removeRun(cl: Cluster, release: string, namespace: string) {
  const id = upgradeIDFromNamespace(namespace);
  if (!id) throw new Error(`${namespace} is not an upgrade test namespace`);
  const { kubectl, json, helm } = cl;
  const found = await kubectl(["get", "namespace", namespace, "-o", "json"], {
    allowFailure: true,
  });
  const removed: string[] = [];
  if (found.code !== 0) {
    log(`${namespace} does not exist; nothing to remove`);
    return removed;
  }
  requireOwnedNamespace(id, namespace, JSON.parse(found.stdout).metadata.labels);
  const claims = (
    (await json(["get", "pvc", "-n", namespace])).items as Array<{
      metadata: { name: string; namespace: string; labels?: Record<string, string> };
    }>
  ).map(
    (item): Claim => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      labels: item.metadata.labels ?? {},
    }),
  );
  const ownership = claimOwnership(id, namespace, claims);
  if (ownership.foreign.length)
    throw new Error(
      `${namespace} holds claims labelled for another owner (${ownership.foreign.join(", ")}); nothing was deleted`,
    );
  await run(helm("uninstall", release, "--namespace", namespace, "--wait", "--timeout", "10m"), {
    allowFailure: true,
  });
  removed.push("release");
  if (ownership.unlabelled.length)
    await kubectl([
      "label",
      "pvc",
      ...ownership.unlabelled,
      "-n",
      namespace,
      `${ownerLabel}=${id}`,
      "--overwrite",
    ]);
  const claimNames = [...ownership.owned, ...ownership.unlabelled];
  await kubectl(["delete", "pvc", "-n", namespace, "-l", `${ownerLabel}=${id}`, "--wait=false"], {
    allowFailure: true,
  });
  removed.push(`pvc/${claimNames.join(",")}`);
  // Helm removes the chart's cluster roles. These are the ones left that this release owns.
  for (const kind of ["clusterrolebinding", "clusterrole"]) {
    const items = (await json(["get", kind])).items as Array<{
      metadata: { name: string; annotations?: Record<string, string> };
    }>;
    for (const item of items.filter(
      (entry) =>
        entry.metadata.name.startsWith(`${namespace}-`) &&
        entry.metadata.annotations?.["meta.helm.sh/release-namespace"] === namespace,
    )) {
      await kubectl(["delete", kind, item.metadata.name, "--wait=false"], { allowFailure: true });
      removed.push(`${kind}/${item.metadata.name}`);
    }
  }
  await kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=10m"]);
  removed.push("namespace");
  const volumes = (await json(["get", "pv"])).items as Array<{
    metadata: { name: string };
    spec?: { claimRef?: { namespace?: string; name?: string } };
  }>;
  for (const name of ownedVolumes(
    namespace,
    claimNames,
    volumes.map((volume) => ({
      name: volume.metadata.name,
      ...(volume.spec?.claimRef?.namespace
        ? { claimNamespace: volume.spec.claimRef.namespace }
        : {}),
      ...(volume.spec?.claimRef?.name ? { claimName: volume.spec.claimRef.name } : {}),
    })),
  )) {
    await kubectl(["delete", "pv", name, "--wait=false"], { allowFailure: true });
    removed.push(`pv/${name}`);
  }
  if (await cl.exists(["namespace", namespace]))
    throw new Error(`${namespace} still exists after its deletion`);
  const leftover = await kubectl(["get", "pvc", "-A", "-l", `${ownerLabel}=${id}`, "-o", "name"]);
  if (leftover.stdout.trim()) throw new Error(`Claims remain for ${id}: ${leftover.stdout.trim()}`);
  return removed;
}

// ---- Run

async function main(options: Options) {
  const cl = cluster(options.context);
  const { kube, helm, kubectl, json, exists } = cl;
  if (options.cleanup) {
    const removed = await removeRun(cl, options.release, options.cleanup);
    log(`Removed ${removed.join(", ")}`);
    return 0;
  }

  const id = hex(4);
  const namespace = upgradeNamespace(id);
  const release = options.release;
  const name = factoryName(release);
  const started = new Date();
  const steps: Step[] = [];
  const checks: Check[] = [];
  const seeded: Seeded[] = [];
  const receipt: Record<string, unknown> = {
    schema: 1,
    namespace,
    owner: id,
    phase: "starting",
    startedAt: started.toISOString(),
    node: options.node,
    release,
    context:
      options.context ||
      (await run(["kubectl", "config", "current-context"], { allowFailure: true })).stdout.trim(),
    passed: false,
    steps,
    checks,
    seeded,
    rollback: { performed: false, expectation: rollbackExpectation },
  };
  await mkdir(outputDirectory, { recursive: true });
  const receiptFile = resolve(outputDirectory, `${namespace}.json`);
  const save = () => writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  const phase = async (value: string) => {
    receipt["phase"] = value;
    await save();
  };
  const step = async <T>(label: string, work: () => Promise<T>) => {
    const begin = performance.now();
    log(`${label}...`);
    try {
      const value = await work();
      steps.push({
        name: label,
        ok: true,
        seconds: Math.round((performance.now() - begin) / 100) / 10,
        detail: "",
      });
      await save();
      return value;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      steps.push({
        name: label,
        ok: false,
        seconds: Math.round((performance.now() - begin) / 100) / 10,
        detail,
      });
      log(`FAILED ${label}: ${detail}`);
      await save();
      throw cause;
    }
  };
  const check = (label: string, ok: boolean, detail: string) => {
    checks.push({ name: label, ok, detail });
    log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  };

  const temp = await mkdtemp(join(tmpdir(), "upgrade-test-"));
  const forwards: Array<ReturnType<typeof Bun.spawn>> = [];
  let created = false;
  let failure = "";
  let passed = false;
  const stopForwards = () => {
    for (const child of forwards.splice(0)) child.kill();
  };

  async function cleanup() {
    stopForwards();
    if (options.keep) {
      log(`--keep: ${namespace} stays; remove it with --cleanup ${namespace}`);
      receipt["cleanup"] = { kept: true };
      return;
    }
    if (!created) return;
    try {
      const removed = await removeRun(cl, release, namespace);
      receipt["cleanup"] = { kept: false, removed };
      log(`Cleaned up ${namespace}`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      receipt["cleanup"] = { kept: false, error: detail };
      log(`CLEANUP FAILED: ${detail}. Re-run with --cleanup ${namespace}`);
    }
  }
  const interrupted = async () => {
    log("Interrupted");
    failure ||= "interrupted";
    await cleanup();
    receipt["finishedAt"] = new Date().toISOString();
    await save();
    process.exit(130);
  };
  process.once("SIGINT", () => void interrupted());
  process.once("SIGTERM", () => void interrupted());

  try {
    // ---- Inputs
    const charts = await step("resolve charts", async () => {
      for (const file of options.values)
        if (!(await stat(resolve(file)).catch(() => null))?.isFile())
          throw new Error(`The values file ${file} does not exist`);
      const resolveChart = async (source: ChartSource, label: string) => {
        if (source.kind === "path") {
          const path = resolve(source.path);
          if (!(await stat(join(path, "Chart.yaml")).catch(() => null)))
            throw new Error(`${path} is not a Helm chart (no Chart.yaml)`);
          return { path, description: path };
        }
        const commit = (
          await run(["git", "-C", root, "rev-parse", "--verify", `${source.commit}^{commit}`])
        ).stdout.trim();
        const target = join(temp, label);
        await mkdir(target, { recursive: true });
        await pipe(
          ["git", "-C", root, "archive", commit, "deploy/helm/factory"],
          ["tar", "-x", "-C", target],
        );
        return { path: join(target, "deploy/helm/factory"), description: `git ${commit}` };
      };
      return {
        from: await resolveChart(options.fromChart, "from"),
        to: await resolveChart(options.toChart, "to"),
      };
    });
    receipt["from"] = { chart: charts.from.description, image: options.fromImage };
    receipt["to"] = { chart: charts.to.description, image: options.toImage };

    // ---- Capacity
    const plan: MemoryPlan = await step("check memory", async () => {
      const node = await json(["get", "node", options.node]);
      const ready = (node.status.conditions as Array<{ type: string; status: string }>).find(
        (condition) => condition.type === "Ready",
      );
      if (ready?.status !== "True") throw new Error(`Node ${options.node} is not Ready`);
      const pods = (
        await json(["get", "pods", "-A", "--field-selector", `spec.nodeName=${options.node}`])
      ).items;
      const verdict = memoryPlan(node.status.allocatable.memory, pods);
      log(verdict.advice);
      if (!verdict.fits) throw new Error(verdict.advice);
      return verdict;
    });
    receipt["memory"] = plan;
    for (const image of [options.fromImage, options.toImage]) {
      const present = await run(["docker", "image", "inspect", image], {
        allowFailure: true,
      }).catch(() => ({ code: 1 }));
      if (present.code !== 0)
        log(
          `WARNING: docker has no image ${image}. A cluster that does not share it will fail to pull.`,
        );
    }
    const namespacesBefore = (
      (await json(["get", "namespaces"])).items as Array<{ metadata: { name: string } }>
    ).map((item) => item.metadata.name);

    // ---- Install the previous build
    const [factoryPort, forgejoPort, zeroPort, objectsPort] = await freePorts();
    const origin = `http://127.0.0.1:${factoryPort}`;
    receipt["origin"] = origin;
    const valuesFile = join(temp, "generated-values.json");
    await writeFile(
      valuesFile,
      JSON.stringify(
        upgradeValues({
          node: options.node,
          ports: { factory: factoryPort, forgejo: forgejoPort, zero: zeroPort },
        }),
      ),
      { mode: 0o600 },
    );
    const valueFlags = [...options.values, valuesFile].flatMap((file) => [
      "--values",
      resolve(file),
    ]);
    const deploy = (verb: "install" | "upgrade", chart: string, image: string) =>
      run(
        helm(
          verb,
          release,
          chart,
          "--namespace",
          namespace,
          ...valueFlags,
          "--set-string",
          `image=${image}`,
          "--wait=legacy",
          "--timeout",
          "20m",
        ),
      );

    await step("create namespace", async () => {
      if (await exists(["namespace", namespace]))
        throw new Error(`${namespace} already exists; refusing to reuse it`);
      // The intent is saved before the namespace exists, so an interrupted run can be cleaned up.
      await phase("namespace-intended");
      await run(kube("create", "-f", "-"), {
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: namespace,
            labels: { [ownerLabel]: id, "app.kubernetes.io/managed-by": managedByValue },
          },
        }),
      });
      created = true;
      await phase("namespace-created");
    });

    const labelClaims = async () => {
      const claims = (
        (await json(["get", "pvc", "-n", namespace])).items as Array<{
          metadata: { name: string; namespace: string; labels?: Record<string, string> };
        }>
      ).map(
        (item): Claim => ({
          name: item.metadata.name,
          namespace: item.metadata.namespace,
          labels: item.metadata.labels ?? {},
        }),
      );
      const ownership = claimOwnership(id, namespace, claims);
      if (ownership.foreign.length)
        throw new Error(`Claims labelled for another owner: ${ownership.foreign.join(", ")}`);
      if (ownership.unlabelled.length)
        await kubectl([
          "label",
          "pvc",
          ...ownership.unlabelled,
          "-n",
          namespace,
          `${ownerLabel}=${id}`,
          "--overwrite",
        ]);
    };
    const claimIdentities = async () =>
      Object.fromEntries(
        (
          (await json(["get", "pvc", "-n", namespace])).items as Array<{
            metadata: { name: string; uid: string };
            spec: { volumeName?: string };
          }>
        )
          .map((item) => [item.metadata.name, `${item.metadata.uid}|${item.spec.volumeName ?? ""}`])
          .sort(([a], [b]) => (a as string).localeCompare(b as string)),
      ) as Record<string, string>;
    const secretDigests = async () => {
      const result: Record<string, string> = {};
      for (const secret of [`${name}-credentials`, `${name}-objects`, `${name}-openbao-tls`])
        result[secret] = quietSecret(
          JSON.stringify((await json(["get", "secret", "-n", namespace, secret])).data),
        );
      return result;
    };
    const deployedImage = async () =>
      (
        await kubectl([
          "-n",
          namespace,
          "get",
          "deploy",
          name,
          "-o",
          "jsonpath={.spec.template.spec.containers[0].image}",
        ])
      ).stdout.trim();

    // ---- Connections
    async function portAnswers(port: number) {
      return fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(3_000),
        redirect: "manual",
      }).then(
        (response) => {
          void response.body?.cancel();
          return true;
        },
        () => false,
      );
    }
    async function connect() {
      stopForwards();
      for (const [service, local, remote] of [
        [`${name}-factory`, factoryPort, 3000],
        [`${name}-forgejo`, forgejoPort, 3000],
        [`${name}-zero`, zeroPort, 4848],
        [`${name}-objects`, objectsPort, 3900],
      ] as const) {
        forwards.push(
          Bun.spawn(
            [
              ...kube(
                "-n",
                namespace,
                "port-forward",
                "--address",
                "127.0.0.1",
                "--pod-running-timeout=120s",
                `service/${service}`,
                `${local}:${remote}`,
              ),
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          ),
        );
        await until(`port ${local} to answer`, 120_000, () => portAnswers(local));
      }
    }
    async function waitReady() {
      await kubectl(["-n", namespace, "rollout", "status", `deploy/${name}`, "--timeout=20m"]);
      await connect();
      await until("Factory readiness", 15 * 60_000, async () => {
        const response = await fetch(`${origin}/health/ready?installation=complete`, {
          signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
        return response.ok;
      });
    }
    const psql = async (sql: string) =>
      (
        await run(
          kube(
            "exec",
            "-i",
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
            "-q",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
          ),
          { input: sql },
        )
      ).stdout;
    const inPod = (pod: string, container: string, script: string) =>
      run(kube("exec", "-i", "-n", namespace, pod, "-c", container, "--", "sh", "-s"), {
        input: script,
      });
    const openbaoLogin = async () => {
      const text = (
        await run(
          kube(
            "exec",
            "-n",
            namespace,
            `deploy/${name}`,
            "-c",
            "factory",
            "--",
            "cat",
            "/var/lib/factory/openbao/factory-login.json",
          ),
        )
      ).stdout;
      const parsed = JSON.parse(text) as { role_id: string; secret_id: string };
      return { roleID: parsed.role_id, secretID: parsed.secret_id };
    };
    const adminPassword = async () =>
      Buffer.from(
        (await json(["get", "secret", "-n", namespace, `${name}-credentials`])).data[
          "admin-password"
        ],
        "base64",
      ).toString();

    const forgejoToken = async () =>
      (
        await run(
          kube(
            "exec",
            "-n",
            namespace,
            `${name}-forgejo-0`,
            "-c",
            "forgejo",
            "--",
            "cat",
            "/var/lib/gitea/factory-bootstrap/factory-mutation",
          ),
        )
      ).stdout.trim();
    const forgejoApi = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await fetch(`http://127.0.0.1:${forgejoPort}/api/v1${path}`, {
        ...init,
        headers: {
          authorization: `token ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `Forgejo ${init.method ?? "GET"} ${path.split("?")[0]} answered ${response.status}`,
        );
      return (text ? JSON.parse(text) : null) as unknown;
    };
    const objectClient = async () => {
      const secret = (await json(["get", "secret", "-n", namespace, `${name}-objects`]))
        .data as Record<string, string>;
      const decode = (key: string) => Buffer.from(secret[key] ?? "", "base64").toString();
      return new S3Client({
        bucket: "factory",
        endpoint: `http://127.0.0.1:${objectsPort}`,
        region: "garage",
        accessKeyId: decode("access-key-id"),
        secretAccessKey: decode("secret-access-key"),
      });
    };

    // ---- Fingerprint
    async function fingerprint(
      label: string,
      ignoreTables: string[],
      ignoreColumns: string[],
    ): Promise<Fingerprint> {
      return step(`fingerprint ${label}`, async () => {
        const migrations = (
          await psql("SELECT version FROM factory.schema_migration ORDER BY version;")
        )
          .split("\n")
          .filter(Boolean)
          .map(Number);
        const tables = parseCatalog(await psql(`${catalogSQL};`)).filter(
          (table) => !ignoredTable(table.name, ignoreTables),
        );
        const data = parseRowLines(
          await psql(snapshotSQL(tables, ignoreColumns)),
          tables,
          ignoreColumns,
        );

        const token = await forgejoToken();
        const forgejo: Record<string, string> = {};
        for (let page = 1; ; page++) {
          const found = (await forgejoApi(token, `/repos/search?limit=50&page=${page}`)) as {
            data: Array<{ full_name: string }>;
          };
          for (const repository of found.data) {
            const full = repository.full_name;
            const branches = (await forgejoApi(
              token,
              `/repos/${full}/branches?limit=50`,
            )) as Array<{ name: string; commit: { id: string } }>;
            for (const branch of branches) {
              forgejo[`${full}|head:${branch.name}`] = branch.commit.id;
              for (let treePage = 1; ; treePage++) {
                const tree = (await forgejoApi(
                  token,
                  `/repos/${full}/git/trees/${branch.commit.id}?recursive=true&per_page=1000&page=${treePage}`,
                )) as {
                  tree: Array<{ path: string; type: string; sha: string }>;
                  truncated?: boolean;
                };
                for (const entry of tree.tree)
                  if (entry.type === "blob")
                    forgejo[`${full}|file:${branch.name}:${entry.path}`] = entry.sha;
                if (!tree.truncated || !tree.tree.length) break;
              }
            }
          }
          if (found.data.length < 50) break;
        }

        const keys = (await psql(`${secretKeysSQL};`)).split("\n").filter(Boolean);
        const login = await openbaoLogin();
        const paths = parsePaths(
          (await inPod(`${name}-openbao-0`, "openbao", secretReadScript(login, keys))).stdout,
        );
        const status = (
          await run(
            kube(
              "exec",
              "-n",
              namespace,
              `${name}-openbao-0`,
              "-c",
              "openbao",
              "--",
              "sh",
              "-c",
              "export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt; bao status -format=json || true",
            ),
            { allowFailure: true },
          )
        ).stdout;
        const sealed = (JSON.parse(status.slice(status.indexOf("{"))) as { sealed: boolean })
          .sealed;

        const objects: Record<string, string> = {};
        const client = await objectClient();
        let startAfter: string | undefined;
        for (;;) {
          const listing = await client.list({
            maxKeys: 1000,
            ...(startAfter ? { startAfter } : {}),
          });
          for (const entry of listing.contents ?? [])
            objects[entry.key] = `${entry.size ?? 0}:${entry.eTag ?? ""}`;
          if (!listing.isTruncated || !listing.contents?.length) break;
          startAfter = listing.contents.at(-1)?.key;
        }
        return { migrations, tables: data, forgejo, openbao: { sealed, paths }, objects };
      });
    }

    // ---- Install
    await step("install previous build", async () => {
      await phase("installing");
      await deploy("install", charts.from.path, options.fromImage);
      await labelClaims();
    });
    await step("wait for readiness (previous build)", waitReady);
    const claimsBefore = await claimIdentities();
    const secretsBefore = await secretDigests();
    const imageBefore = await deployedImage();
    check("previous build runs the previous image", imageBefore === options.fromImage, imageBefore);

    // ---- Seed
    const password = await adminPassword();
    const userEmail = `upgrade-user-${id}@factory.local`;
    const userPassword = `${hex(12)}Aa1`;
    const seedState = await step("seed data", async () => {
      await phase("seeding");
      const httpSignIn = async (email: string, secret: string) => {
        const response = await fetch(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email, password: secret }),
          signal: AbortSignal.timeout(30_000),
        });
        await response.body?.cancel();
        return response.ok && response.headers.getSetCookie().length > 0;
      };
      if (!(await httpSignIn(adminEmail, password)))
        throw new Error("The generated administrator password was refused");

      const adminID = (
        await psql(`SELECT id FROM auth."user" WHERE email = '${adminEmail}';`)
      ).trim();
      if (!adminID) throw new Error("The administrator has no user row");

      // Forgejo repository with the starter scaffold. Creating a Project from the Starter template
      // in the UI prepares a runtime image, which needs a worker and is out of scope here.
      const token = await forgejoToken();
      const repository = (await forgejoApi(token, "/user/repos", {
        method: "POST",
        body: JSON.stringify({
          name: projectSlug,
          auto_init: true,
          default_branch: "main",
          private: true,
          description: "Upgrade test starter scaffold",
        }),
      })) as { full_name: string };
      const tracked = (
        await run(["git", "-C", root, "ls-files", "-z", "templates/starter-app"])
      ).stdout
        .split("\0")
        .filter((file) => file && !file.endsWith("/README.md"));
      if (tracked.length < 5 || tracked.length > 300)
        throw new Error(`Unexpected starter scaffold size: ${tracked.length} files`);
      const files = await Promise.all(
        tracked.map(async (file) => ({
          operation: "create",
          path: file.replace(/^templates\/starter-app\//, ""),
          content: Buffer.from(await readFile(resolve(root, file))).toString("base64"),
        })),
      );
      await forgejoApi(token, `/repos/${repository.full_name}/contents`, {
        method: "POST",
        body: JSON.stringify({ branch: "main", message: "Starter scaffold", files }),
      });
      const head = (
        (await forgejoApi(token, `/repos/${repository.full_name}/branches/main`)) as {
          commit: { id: string };
        }
      ).commit.id;
      seeded.push({
        what: "Forgejo repository with the starter scaffold",
        how: "forgejo-api",
        detail: `${repository.full_name}, ${files.length} files`,
      });

      // A model connection placeholder: the secret goes to OpenBao as Factory's own AppRole and
      // the rows name it. Saving a connection in Settings probes the provider, which needs a model.
      const projectID = crypto.randomUUID();
      const model = { connectionID: crypto.randomUUID(), commandID: crypto.randomUUID() };
      const secretKey = `models/${model.connectionID}/${model.commandID}`;
      const fingerprint = createHash("sha256").update(secretKey).digest("hex");
      await inPod(
        `${name}-openbao-0`,
        "openbao",
        secretWriteScript(
          await openbaoLogin(),
          secretKey,
          JSON.stringify({
            ...model,
            provider: "openai",
            endpoint: "https://api.openai.com/v1",
            fingerprint,
            apiKey: "placeholder-not-a-key",
          }),
        ),
      );
      seeded.push({
        what: "model connection placeholder",
        how: "openbao-cli+sql",
        detail: "no model call; the key is a placeholder",
      });

      const tickets = [
        {
          id: crypto.randomUUID(),
          title: "Upgrade backlog item",
          description: "Waits in the backlog.",
          state: "backlog",
        },
        {
          id: crypto.randomUUID(),
          title: "Upgrade ready item",
          description: "Ready to implement.",
          state: "ready",
        },
        {
          id: crypto.randomUUID(),
          title: "Upgrade cancelled item",
          description: "Was cancelled.",
          state: "cancelled",
        },
        {
          id: crypto.randomUUID(),
          title: "Upgrade done item",
          description: "Already delivered.",
          state: "done",
        },
      ];
      const wiki = {
        pageID: crypto.randomUUID(),
        slug: "upgrade-notes",
        title: "Upgrade notes",
        first: "# Upgrade notes\n\nThe first draft lists the services.",
        second: "# Upgrade notes\n\nThe second revision records the rollout order.",
      };
      await psql(
        seedSQL({
          adminID,
          projectID,
          slug: projectSlug,
          name: projectName,
          repositoryURL: `http://${name}-forgejo.${namespace}.svc:3000/${repository.full_name}.git`,
          commitSha: head,
          tickets,
          wiki,
          revisionIDs: [crypto.randomUUID(), crypto.randomUUID()],
          model: { ...model, secretKey, fingerprint },
        }),
      );
      seeded.push({
        what: "Project, Tickets in four states, Wiki page with two revisions",
        how: "sql (factory role)",
        detail: "creating them in the UI needs a runtime or a model",
      });

      const ticketTitles = ["Upgrade idea one", "Upgrade idea two"];
      await seedThroughBrowser({
        origin,
        email: adminEmail,
        password,
        evidence: resolve(outputDirectory, namespace),
        projectID,
        projectSlug,
        user: { name: "Upgrade test user", email: userEmail, password: userPassword },
        ticketTitles,
      });
      seeded.push({
        what: "administrator sign-in, a managed account, two Tickets as ideas",
        how: "ui (playwright)",
        detail: userEmail,
      });

      const userID = (
        await psql(`SELECT id FROM auth."user" WHERE email = '${userEmail}';`)
      ).trim();
      if (!userID) throw new Error("The account created in the UI has no user row");
      const created = (
        await psql(
          `SELECT id || '|' || title FROM factory.ticket WHERE project_id = '${projectID}' ORDER BY created_at;`,
        )
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ id: line.slice(0, 36), title: line.slice(37) }));
      for (const title of ticketTitles)
        if (!created.some((ticket) => ticket.title === title))
          throw new Error(`The Ticket ${title} was not created`);
      const ready = tickets.find((ticket) => ticket.state === "ready");
      const idea = created.find((ticket) => ticket.title === ticketTitles[0]);
      if (!ready || !idea) throw new Error("Seeded Tickets are missing");
      for (const ticketID of [ready.id, idea.id])
        await psql(
          assignmentSQL({ ticketID, userID, actorID: adminID, eventID: crypto.randomUUID() }),
        );
      seeded.push({
        what: "Inbox items for the new account",
        how: "sql (factory role)",
        detail: "two Tickets assigned to it",
      });

      const client = await objectClient();
      const url = client.presign(`upgrade-test/${id}.txt`, { method: "PUT", expiresIn: 60 });
      const put = await fetch(url, {
        method: "PUT",
        body: `upgrade test fixture ${id}\n`,
        signal: AbortSignal.timeout(30_000),
      });
      if (!put.ok) throw new Error(`The object fixture was refused (${put.status})`);
      seeded.push({
        what: "object fixture",
        how: "s3",
        detail: "a plain object, not an attachment row; attachments need a Ticket upload in the UI",
      });

      if (!(await httpSignIn(userEmail, userPassword)))
        throw new Error("The new account cannot sign in");
      return { projectID, tickets: created, wiki };
    });
    receipt["seed"] = {
      project: seedState.projectID,
      tickets: seedState.tickets.length,
      wikiRevisions: 2,
    };

    const ignoreTables = options.ignoreTables;
    const ignoreColumns = options.ignoreColumns;
    const verifyOptions = (label: string) => ({
      origin,
      email: adminEmail,
      password,
      evidence: resolve(outputDirectory, namespace),
      label,
      projectID: seedState.projectID,
      projectName,
      tickets: seedState.tickets,
      wiki: {
        pageID: seedState.wiki.pageID,
        text: "The second revision records the rollout order.",
      },
    });
    const consoleReport: Record<string, string[]> = {};
    const verify = async (label: string, mustBeClean: boolean) =>
      step(`browser check ${label}`, async () => {
        const result = await verifyThroughBrowser(verifyOptions(label));
        const messages = unexpectedConsole(result.consoleMessages, options.ignoreConsole);
        consoleReport[label] = messages;
        for (const loaded of result.loaded)
          if (mustBeClean)
            check(`${label}: ${loaded.name}`, loaded.ok, loaded.ok ? "" : loaded.detail);
          else if (!loaded.ok) log(`${label}: ${loaded.name} did not load (${loaded.detail})`);
        if (mustBeClean)
          check(
            `${label}: zero console errors`,
            messages.length === 0,
            messages.slice(0, 5).join(" | "),
          );
        else if (messages.length)
          log(`${label}: ${messages.length} console errors on the previous build`);
        return result;
      });

    await verify("before", false);
    const before = await fingerprint("before upgrade", ignoreTables, ignoreColumns);
    const unreadableBefore = unreadableSecrets(before);
    check(
      "seeded secrets are readable before the upgrade",
      unreadableBefore.length === 0,
      unreadableBefore.join(", "),
    );
    check(
      "seed produced rows to compare",
      Object.keys(before.tables["factory.ticket"]?.rows ?? {}).length >= 6 &&
        Object.keys(before.tables["factory.knowledge_revision"]?.rows ?? {}).length >= 2 &&
        Object.keys(before.forgejo).length > 0 &&
        Object.keys(before.objects).length > 0,
      "",
    );
    receipt["fingerprintBefore"] = summarize(before);

    // ---- First upgrade
    await step("upgrade to new build", async () => {
      await phase("upgrading");
      await deploy("upgrade", charts.to.path, options.toImage);
      await labelClaims();
    });
    await step("wait for readiness (new build)", waitReady);
    const afterUpgrade = await fingerprint("after upgrade", ignoreTables, ignoreColumns);
    receipt["fingerprintAfterUpgrade"] = summarize(afterUpgrade);
    const upgradeDiff: Diff = diffFingerprints(before, afterUpgrade, upgradeRules(options.allow));
    receipt["upgradeDiff"] = upgradeDiff;
    check(
      "upgrade lost or changed nothing",
      upgradeDiff.ok,
      upgradeDiff.ok ? `${upgradeDiff.allowed.length} allowed additions` : "",
    );
    if (!upgradeDiff.ok) console.log(formatDiff("upgrade diff", upgradeDiff));
    const imageAfter = await deployedImage();
    check("new build runs the new image", imageAfter === options.toImage, imageAfter);
    check("OpenBao is unsealed", !afterUpgrade.openbao.sealed, "");
    const unreadableAfter = unreadableSecrets(afterUpgrade);
    check(
      "stored secrets still read and decrypt",
      unreadableAfter.length === 0,
      unreadableAfter.join(", "),
    );
    const claimsAfter = await claimIdentities();
    check(
      "claims keep their identity and volume",
      JSON.stringify(claimsBefore) === JSON.stringify(claimsAfter),
      "",
    );
    const secretsAfter = await secretDigests();
    check(
      "generated Secrets are unchanged",
      JSON.stringify(secretsBefore) === JSON.stringify(secretsAfter),
      "",
    );
    check("same administrator password", (await adminPassword()) === password, "");
    const userSignIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: userPassword }),
      signal: AbortSignal.timeout(30_000),
    });
    await userSignIn.body?.cancel();
    check(
      "the account created before the upgrade still signs in",
      userSignIn.ok,
      `HTTP ${userSignIn.status}`,
    );
    await verify("after", true);
    const settled = await fingerprint("after browser check", ignoreTables, ignoreColumns);

    // ---- Second upgrade, same build
    await step("second upgrade to the same build", async () => {
      await phase("upgrading-again");
      await deploy("upgrade", charts.to.path, options.toImage);
      await labelClaims();
    });
    await step("wait for readiness (second upgrade)", waitReady);
    const again = await fingerprint("after second upgrade", ignoreTables, ignoreColumns);
    receipt["fingerprintAfterSecondUpgrade"] = summarize(again);
    const noopDiff: Diff = diffFingerprints(settled, again, noopRules);
    receipt["noopDiff"] = noopDiff;
    check("second upgrade to the same build is a no-op", noopDiff.ok, "");
    if (!noopDiff.ok) console.log(formatDiff("second upgrade diff", noopDiff));
    check(
      "second upgrade applied no migration",
      JSON.stringify(settled.migrations) === JSON.stringify(again.migrations),
      again.migrations.join(","),
    );
    check(
      "second upgrade kept the claims",
      JSON.stringify(claimsAfter) === JSON.stringify(await claimIdentities()),
      "",
    );
    check("OpenBao is still unsealed", !again.openbao.sealed, "");

    const namespacesAfter = (
      (await json(["get", "namespaces"])).items as Array<{ metadata: { name: string } }>
    ).map((item) => item.metadata.name);
    const runtime = newRuntimeNamespaces(namespacesBefore, namespacesAfter);
    check(
      "no worker, editor or Sandbox namespace appeared",
      runtime.length === 0,
      runtime.join(", "),
    );
    receipt["console"] = consoleReport;
    receipt["helmHistory"] = JSON.parse(
      (await run(helm("history", release, "--namespace", namespace, "-o", "json"))).stdout,
    );
    passed = checks.every((entry) => entry.ok);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  await cleanup();
  await rm(temp, { recursive: true, force: true });
  receipt["passed"] = passed && !failure;
  receipt["failure"] = failure || undefined;
  receipt["finishedAt"] = new Date().toISOString();
  await phase(passed && !failure ? "passed" : "failed");
  const failed = checks.filter((entry) => !entry.ok);
  log(`Receipt: ${receiptFile}`);
  if (failure) log(`FAILED: ${failure}`);
  if (failed.length)
    log(`${failed.length} checks failed: ${failed.map((entry) => entry.name).join("; ")}`);
  log(receipt["passed"] ? "Upgrade test passed." : "Upgrade test failed.");
  return receipt["passed"] ? 0 : 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    process.exit(0);
  }
  let options: Options;
  try {
    options = parseOptions(args);
  } catch (cause) {
    console.error(`${cause instanceof Error ? cause.message : String(cause)}\n\n${help}`);
    process.exit(2);
  }
  process.exit(await main(options));
}
