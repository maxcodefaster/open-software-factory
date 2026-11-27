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
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cluster, type RunOptions, run } from "./clean-room-cluster";
import {
  type Check,
  cleanRoomNamespace,
  createReceipt,
  finishReceipt,
  type Options,
  parseOptions,
  receiptPath,
  redact,
  serializeReceipt,
} from "./clean-room-model";
import { finalizeRunCleanup, type NamespaceItem, runCleanupCommand } from "./clean-room-ownership";
import {
  type CleanRoomRunContext,
  checkCapacityStage,
  checkToolsStage,
  prepareChartStage,
  StepFailed,
  validateChartConfigurationStage,
  validateNativeInputsStage,
} from "./clean-room-prepare";
import {
  checkOpenBaoStage,
  createNamespaceStage,
  createNativeSecretsStage,
  installChartStage,
  readAdminCredentialStage,
  resolvePublicTrustStage,
  runBackupCheckStage,
  runBackupJobStage,
  runBrowserJourneyStage,
  runHelmTestStage,
  waitForReadinessStage,
} from "./clean-room-verify";

const root = resolve(import.meta.dir, "../..");
const log = (message: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function main(options: Options) {
  const context =
    options.context || (await run(["kubectl", "config", "current-context"])).stdout.trim();
  if (!context) throw new Error("kubectl has no current context; pass --context NAME");
  const cl = cluster(context);
  const outputDirectory = resolve(root, ".factory/test-results/clean-room");
  await mkdir(outputDirectory, { recursive: true });

  if (options.cleanup) {
    return runCleanupCommand({ cl, namespace: options.cleanup, context, root, log });
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
  let interrupted = false;
  let failure = "";
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
  const record = (check: Check) => {
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
      record({
        name: label,
        status: typeof result === "string" ? "passed" : "skipped",
        detail: redact(typeof result === "string" ? result : result.skipped, secrets),
        durationMs: Math.round(performance.now() - begin),
      });
    } catch (cause) {
      const detail = redact(cause instanceof Error ? cause.message : String(cause), secrets);
      record({
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

  const ctx: CleanRoomRunContext = {
    root,
    id,
    namespace,
    context,
    startedAt,
    options,
    cl,
    outputDirectory,
    temp,
    receipt,
    secrets,
    signal: connection.signal,
    kubectl: (args: string[], opts: RunOptions = {}) =>
      cl.kubectl(args, { ...opts, signal: connection.signal }),
    json: (args: string[]) => cl.json(args, { signal: connection.signal }),
    liveRun: (args: string[], opts: RunOptions = {}) =>
      run(args, { ...opts, signal: connection.signal }),
    log,
    persist,
    timed,
    record,
    created: false,
    preserveTemp: false,
    chartImage: undefined,
    chartTarget: "",
    versionArgs: [],
    defaults: {},
    valuesFile: "",
    nodeName: options.node,
    origin: "",
    adminPassword: "",
    adminEmail: "admin@factory.local",
    native: undefined,
    publicCA: undefined,
  };

  try {
    await step("native-inputs", () => validateNativeInputsStage(ctx));
    await step("tools", () => checkToolsStage(ctx));
    await persist();
    await step("chart", () => prepareChartStage(ctx));
    await step("capacity", () => checkCapacityStage(ctx));
    await step("chart-configuration", () => validateChartConfigurationStage(ctx));

    // Snapshots let the receipt show that nothing else disappeared and which runtime Namespaces
    // appeared that this run cannot attribute to itself.
    const namespaces = (await ctx.json(["get", "namespaces"])).items as NamespaceItem[];
    beforeNamespaces.push(...namespaces.map((item) => item.metadata.name));
    beforeRuntime.push(
      ...namespaces
        .map((item) => item.metadata.name)
        .filter((item) => /^factory-editor-[a-f0-9]{32}$/.test(item)),
    );

    await step("namespace", () => createNamespaceStage(ctx));
    await step("native-secrets", () => createNativeSecretsStage(ctx));
    await step("install", () => installChartStage(ctx));
    await step("public-trust", () => resolvePublicTrustStage(ctx));
    await step("helm-test", () => runHelmTestStage(ctx));
    await step("readiness", () => waitForReadinessStage(ctx));
    await step("admin-credential", () => readAdminCredentialStage(ctx));
    await step("openbao", () => checkOpenBaoStage(ctx));
    await runBrowserJourneyStage(ctx);
    await step("backup-job", () => runBackupJobStage(ctx));
    await step("backup-check", () => runBackupCheckStage(ctx));
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
  const cleanupBegin = performance.now();
  await finalizeRunCleanup({
    cl,
    id,
    namespace,
    context,
    origin: ctx.origin,
    keep: options.keep,
    created: ctx.created,
    receipt,
    beforeNamespaces,
    beforeRuntime,
    log,
  });
  receipt.timingsMs["cleanup"] = Math.round(performance.now() - cleanupBegin);
  if (ctx.preserveTemp) {
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
