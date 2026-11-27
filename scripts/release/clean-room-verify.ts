// Installation, readiness, browser qualification, and backup verification stages.
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkSet } from "../kubernetes/restore-check";
import { withDockerBackupReader } from "./clean-room-backup";
import { browserJourney } from "./clean-room-browser";
import { pipe, testCleanRoomChart, until } from "./clean-room-cluster";
import {
  backupJobName,
  chartName,
  listSetsScript,
  managedBrowserTrustLimit,
  namespaceManifest,
  newestSet,
  openbaoVerdict,
  readinessVerdict,
  redact,
  releaseName,
  usablePgRestore,
  verifyOwnedNamespace,
} from "./clean-room-model";
import {
  createNativeCleanRoomSecrets,
  readManagedCleanRoomCA,
  readNativeCleanRoomReadiness,
} from "./clean-room-native";
import type { CleanRoomRunContext } from "./clean-room-prepare";

const name = chartName(releaseName);

export async function createNamespaceStage(ctx: CleanRoomRunContext) {
  if (await ctx.cl.exists(["namespace", ctx.namespace], { signal: ctx.signal }))
    throw new Error(`${ctx.namespace} already exists; refusing to use it`);
  // Intent first: an interrupted run leaves a receipt that names what to clean up.
  await ctx.persist();
  ctx.created = true;
  const createdNamespace = await ctx.kubectl(["create", "-f", "-", "-o", "json"], {
    input: JSON.stringify(namespaceManifest(ctx.id, ctx.startedAt)),
  });
  const uid = verifyOwnedNamespace(JSON.parse(createdNamespace.stdout), ctx.id);
  ctx.receipt.namespaceUID = uid;
  await ctx.persist();
  return `${ctx.namespace} created with owner label ${ctx.id} (uid ${uid})`;
}

export async function createNativeSecretsStage(ctx: CleanRoomRunContext) {
  if (!ctx.native || !ctx.receipt.namespaceUID)
    throw Error("Original native installation identity is unavailable");
  await ctx.persist();
  await createNativeCleanRoomSecrets(ctx.cl, ctx.native, ctx.receipt.namespaceUID, ctx.signal);
  return `Created only this fresh Namespace's native configuration and provisioner Secrets${ctx.native.metadata.tlsMode === "external" ? " and explicit external Ingress Secret" : "; Helm owns TLS issuance"}`;
}

export async function installChartStage(ctx: CleanRoomRunContext) {
  ctx.log("Installing the chart; this waits for every service and can take up to 20 minutes");
  const result = await ctx.timed("install-helm", () =>
    ctx.liveRun(
      ctx.cl.helm(
        "install",
        releaseName,
        ctx.chartTarget,
        ...ctx.versionArgs,
        "--namespace",
        ctx.namespace,
        "--values",
        ctx.valuesFile,
        "--wait=legacy",
        "--timeout",
        "20m",
      ),
      { cwd: ctx.root, allowFailure: true },
    ),
  );
  if (result.code !== 0)
    throw new Error(
      `helm install failed: ${redact(result.stderr, ctx.secrets).trim().split("\n").slice(-4).join(" | ")}`,
    );
  return `release ${releaseName} installed with --wait=legacy --timeout 20m`;
}

export async function resolvePublicTrustStage(ctx: CleanRoomRunContext) {
  if (!ctx.native || !ctx.receipt.namespaceUID)
    throw Error("Original native installation identity is unavailable");
  if (ctx.native.metadata.tlsMode === "managed") {
    const trust = await readManagedCleanRoomCA(ctx.cl, ctx.native, ctx.receipt.namespaceUID, {
      signal: ctx.signal,
    });
    ctx.publicCA = trust.ca;
    Object.assign(ctx.receipt.native, trust.metadata);
    ctx.receipt.limits.push(managedBrowserTrustLimit);
    return `Read only the managed public CA from ${trust.metadata.caSecretName}, UID ${trust.metadata.caSecretUID}; SHA-256 ${trust.metadata.caFingerprint256}; browser trust unchanged`;
  }
  ctx.publicCA = ctx.native.ca;
  if (!ctx.publicCA) throw Error("External public readiness trust is unavailable");
  return "Using the explicitly supplied external public CA; browser trust unchanged";
}

export async function runHelmTestStage(ctx: CleanRoomRunContext) {
  ctx.log("Running helm test (read-only native preflight, not Actor or product acceptance)");
  return testCleanRoomChart(ctx.cl, releaseName, ctx.namespace, ctx.signal);
}

export async function waitForReadinessStage(ctx: CleanRoomRunContext) {
  if (!ctx.publicCA) throw Error("Native public readiness trust is unavailable");
  const ca = ctx.publicCA;
  let startupID = "";
  await until(
    "public readiness",
    600_000,
    async () => {
      ctx.signal.throwIfAborted();
      const response = await readNativeCleanRoomReadiness(ctx.origin, ca, ctx.signal);
      await response.body?.cancel();
      const verdict = readinessVerdict(response);
      startupID = verdict.startupID;
      return verdict.ready;
    },
    ctx.signal,
  );
  const pods = (await ctx.json(["-n", ctx.namespace, "get", "pods"])).items as Array<{
    metadata: { name: string };
    status: { containerStatuses?: Array<{ name: string; image: string; imageID: string }> };
  }>;
  (ctx.receipt.images as Record<string, unknown>)["running"] = pods.flatMap((pod) =>
    (pod.status.containerStatuses ?? []).map((container) => ({
      pod: pod.metadata.name,
      container: container.name,
      image: container.image,
      imageID: container.imageID,
    })),
  );
  return `/health/ready?installation=complete answered 200 with the ready header (startup ${startupID.slice(0, 8)})`;
}

export async function readAdminCredentialStage(ctx: CleanRoomRunContext) {
  const secret = (await ctx.json([
    "-n",
    ctx.namespace,
    "get",
    "secret",
    `${name}-credentials`,
  ])) as { data?: Record<string, string> };
  ctx.adminPassword = Buffer.from(
    String(secret.data?.["admin-password"] ?? ""),
    "base64",
  ).toString();
  if (ctx.adminPassword.length < 12)
    throw new Error("The generated admin password is missing or short");
  ctx.secrets.push(ctx.adminPassword);
  ctx.adminEmail = String(ctx.defaults["adminEmail"] ?? ctx.adminEmail);
  return `read from ${name}-credentials; never printed or written`;
}

export async function checkOpenBaoStage(ctx: CleanRoomRunContext) {
  const status = await ctx.kubectl(
    ["exec", "-i", "-n", ctx.namespace, `${name}-openbao-0`, "-c", "openbao", "--", "sh", "-s"],
    {
      input:
        "export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt\nbao status -format=json || true\n",
      allowFailure: true,
    },
  );
  const verdict = openbaoVerdict(status.stdout);
  if (!verdict.ok) throw new Error(verdict.detail);
  return verdict.detail;
}

export async function runBrowserJourneyStage(ctx: CleanRoomRunContext) {
  await ctx.timed("browser", async () => {
    if (ctx.native?.metadata.tlsMode === "managed") ctx.log(managedBrowserTrustLimit);
    const journey = await browserJourney({
      origin: ctx.origin,
      email: ctx.adminEmail,
      password: ctx.adminPassword,
      id: ctx.id,
      withSandbox: ctx.options.withSandbox,
      directory: join(ctx.outputDirectory, ctx.namespace),
      signal: ctx.signal,
    });
    for (const check of journey.checks)
      ctx.record(
        ctx.native?.metadata.tlsMode === "managed" &&
          check.status === "failed" &&
          /ERR_CERT_|certificate.*(?:invalid|authority|trust)/i.test(check.detail)
          ? {
              ...check,
              detail: `${check.detail} Managed CA trust is not configured by this helper in Chromium; browser qualification failed, not skipped.`,
            }
          : check,
      );
    ctx.receipt.limits.push(...journey.limits);
    ctx.receipt.screenshots = journey.screenshots.map((path) => path.replace(`${ctx.root}/`, ""));
  });
  await ctx.persist();
}

export async function runBackupJobStage(ctx: CleanRoomRunContext) {
  const jobName = backupJobName(ctx.id);
  ctx.log("Taking a manual backup with the chart's CronJob template");
  await ctx.kubectl([
    "-n",
    ctx.namespace,
    "create",
    "job",
    jobName,
    `--from=cronjob/${name}-backup`,
  ]);
  const waited = await ctx.kubectl(
    ["-n", ctx.namespace, "wait", "--for=condition=complete", `job/${jobName}`, "--timeout=30m"],
    { allowFailure: true },
  );
  if (waited.code !== 0) {
    const logs = await ctx.kubectl(
      ["-n", ctx.namespace, "logs", `job/${jobName}`, "--all-containers", "--tail=15"],
      { allowFailure: true },
    );
    throw new Error(
      `Backup Job did not complete: ${(logs.stdout || logs.stderr).trim().split("\n").slice(-4).join(" | ")}`,
    );
  }
  const job = (await ctx.json(["-n", ctx.namespace, "get", "job", jobName])) as {
    status?: { succeeded?: number };
  };
  if (job.status?.succeeded !== 1) throw new Error("The backup Job reports no success");
  return `${jobName} completed`;
}

export async function runBackupCheckStage(ctx: CleanRoomRunContext) {
  const store = `${name}-backup-store-0`;
  const listed = (
    await ctx.kubectl(["exec", "-n", ctx.namespace, store, "--", "sh", "-c", listSetsScript()])
  ).stdout;
  const set = newestSet(listed);
  if (!set) throw new Error("The backup store holds no complete set");
  const directory = join(ctx.temp, "set");
  await mkdir(directory);
  await pipe(
    ctx.cl.kube(
      "exec",
      "-n",
      ctx.namespace,
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
    ctx.signal,
  );
  const files = await readdir(directory);
  if (!files.includes("openbao.snap"))
    throw new Error(`Set ${set} has no openbao.snap although OpenBao bootstrapped`);
  const optionalClient = (args: string[]) =>
    ctx.liveRun(args, { allowFailure: true }).catch(() => {
      ctx.signal.throwIfAborted();
      return null;
    });
  const pgRestore = process.env["PG_RESTORE"] ?? "pg_restore";
  const local = await optionalClient([pgRestore, "--version"]);
  let checks: Awaited<ReturnType<typeof checkSet>>;
  if (local?.code === 0 && usablePgRestore(local.stdout))
    checks = await checkSet(directory, pgRestore, ctx.signal);
  else if (process.env["PG_RESTORE"])
    throw Error("The selected PG_RESTORE must be a working PostgreSQL 16 executable");
  else if ((await optionalClient(["docker", "version"]))?.code === 0) {
    const postgres = (await ctx.json([
      "-n",
      ctx.namespace,
      "get",
      "pod",
      `${name}-postgres-0`,
    ])) as {
      spec?: { containers?: Array<{ name: string; image: string }> };
    };
    const image = postgres.spec?.containers?.find(
      (container) => container.name === "postgres",
    )?.image;
    checks = await withDockerBackupReader(
      {
        id: ctx.id,
        directory,
        temporaryDirectory: ctx.temp,
        image: typeof image === "string" ? image : "",
        signal: ctx.signal,
        async record(resource) {
          ctx.receipt.images["backupReader"] = resource;
          ctx.preserveTemp = resource.state === "unconfirmed";
          await ctx.persist();
        },
      },
      (command) => checkSet(directory, command, ctx.signal),
    ).catch((cause: unknown) => {
      if (cause instanceof AggregateError) ctx.preserveTemp = true;
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
}
