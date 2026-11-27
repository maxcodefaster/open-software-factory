import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { runProcess } from "../owned-client-process";

// Native lane tests run against real external services/binaries. Suffix `*.native.test.ts`
// and `opencode-*.test.ts` match structurally; these legacy names predate the `.native` suffix.
const nativeIntegrationExceptions = new Set([
  "agent-native-commit-recovery",
  "attachment-browser",
  "attachment-factory-browser",
  "attachment-s3",
  "build-browser",
  "change-writer-source",
  "native-enterprise-identity",
  "native-forge-issuer",
  "native-project-releases",
  "native-skill-loading",
  "openbao",
  "project-setup-forge",
  "substrate-coding-stop",
  "substrate-writer-input-stop",
]);

// Self-contained tests need neither the lane's shared PostgreSQL server nor a compiled
// application build. `*-baseline.test.ts` and `substrate-source*.test.ts` match structurally.
const selfContainedIntegrationExceptions = new Set([
  "attachments-store.test.ts",
  "backup-runner.native.test.ts",
  "browser-tools-package.native.test.ts",
  "conversation-persistence.test.ts",
  "native-memory-source-transfer.test.ts",
  "native-project-entry.test.ts",
  "native-ui-fixture.test.ts",
  "openbao.test.ts",
  "review-media.test.ts",
  "source-native-retention.test.ts",
  "source-startup.test.ts",
  "substrate-adapter.native.test.ts",
  "substrate-input-stop.test.ts",
  "substrate-lifecycle-facts.test.ts",
  "substrate-workspace-generations.test.ts",
  "substrate-workspaces.test.ts",
  "workspace-commands.test.ts",
  "workspace-container-files.test.ts",
  "workspace-pause-command.test.ts",
  "workspace-sharing.test.ts",
]);

// `server-function-*.test.ts` proofs are self-contained with respect to PostgreSQL except these.
const serverFunctionDatabaseExceptions = new Set([
  "server-function-mcp-authority.test.ts",
  "server-function-ticket-sql.test.ts",
]);

// Tests that still need an application build but manage or omit PostgreSQL themselves.
// `substrate-adapter*.test.ts`, `substrate-workspace*.test.ts`, and `server-function-*.test.ts`
// (outside `serverFunctionDatabaseExceptions`) match structurally.
const noSharedDatabaseExceptions = new Set([
  "client-budgets.test.ts",
  "developer-ide-kubernetes.native.test.ts",
  "native-fixture-observation.test.ts",
  "native-project-releases.test.ts",
  "runtime-app-origins.test.ts",
  "runtime-declared-apps.test.ts",
  "substrate-coding-stop.test.ts",
  "substrate-idle.test.ts",
  "substrate-isolated.test.ts",
  "substrate-pause-failure.test.ts",
  "substrate-reset.test.ts",
  "substrate-runtime-list.test.ts",
  "substrate-verification.test.ts",
  "uncreated-workspace-attempt.test.ts",
  "usage-cleanup.test.ts",
  "verification-cancellation.test.ts",
]);

// Database/controller proofs that share the lane's PostgreSQL server without an application build.
// `*-drizzle.test.ts` matches structurally.
const noApplicationBuildExceptions = new Set([
  "agent-read.test.ts",
  "agent-turn-store.test.ts",
  "coding-budget.test.ts",
  "coding-source-dispatch-fence.test.ts",
  "developer-ide-access-recovery.test.ts",
  "developer-ide.test.ts",
  "fixture-cleanup.test.ts",
  "inbox.test.ts",
  "mcp-cancellation.test.ts",
  "mcp-library.test.ts",
  "mcp-oauth.test.ts",
  "project-registration-authority.test.ts",
  "project-release-store.test.ts",
  "retained-stop-maintenance.test.ts",
  "substrate-bound-provisioning.test.ts",
  "substrate-browser.test.ts",
  "substrate-usage.test.ts",
  "usage-journal.test.ts",
  "usage-policy.test.ts",
]);

function isSelfContainedIntegration(name: string) {
  return (
    name.endsWith("-baseline.test.ts") ||
    name.startsWith("substrate-source") ||
    selfContainedIntegrationExceptions.has(name)
  );
}

export function controllerNeedsDatabase(path: string) {
  const name = basename(path);
  if (isSelfContainedIntegration(name)) return false;
  if (name.startsWith("server-function-") && !serverFunctionDatabaseExceptions.has(name))
    return false;
  if (name.startsWith("substrate-adapter") || name.startsWith("substrate-workspace")) return false;
  return !noSharedDatabaseExceptions.has(name);
}

export function integrationNeedsApplicationBuild(path: string) {
  const name = basename(path);
  if (isSelfContainedIntegration(name)) return false;
  if (name.endsWith("-drizzle.test.ts")) return false;
  return !noApplicationBuildExceptions.has(name);
}

export function integrationLane(path: string) {
  const name = basename(path).replace(/\.test\.ts$/, "");
  if (name.endsWith(".live")) return "live";
  if (
    name.endsWith(".native") ||
    name.startsWith("opencode-") ||
    nativeIntegrationExceptions.has(name)
  )
    return "native";
  return "controllers";
}

export const browserFiles = {
  paid: ["agent-turn-live.spec.ts", "project-agent.spec.ts"],
  native: [
    "runtime-console.spec.ts",
    "delivery.spec.ts",
    "workspace-startup.live.spec.ts",
    "starter-editor.live.spec.ts",
    "stabilization.live.spec.ts",
    "contributor-implementation.live.spec.ts",
    // These read the retained installation's Forgejo token and listener.
    "project-knowledge.spec.ts",
    "project-runtime.spec.ts",
  ],
};
// These retain their ordinary UI cases in the default lane; only @paid cases
// require the paid lane. They must also be discoverable by that explicit lane.
export const mixedPaidBrowserFiles = ["ticket-requirements-journey.spec.ts"];
export function browserLane(path: string) {
  const name = basename(path);
  for (const [lane, files] of Object.entries(browserFiles)) if (files.includes(name)) return lane;
  if (name.includes(".live.")) throw new Error(`Unclassified browser live proof: ${name}`);
  return "ui";
}

export function laneSelections(requested: string[]) {
  const flags = requested.filter((argument) => argument.startsWith("--shard="));
  if (flags.length > 1) throw new Error("Select one test shard");
  for (const flag of flags) {
    const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(flag);
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[2])) ||
      Number(match[1]) > Number(match[2])
    )
      throw new Error("Use --shard=INDEX/TOTAL with 1 <= INDEX <= TOTAL");
  }
  return {
    flags,
    filters: requested.filter(
      (selection) => selection !== "--list" && !selection.startsWith("--shard="),
    ),
  };
}

if (import.meta.main) {
  const [lane = "unit", ...requested] = process.argv.slice(2);
  if (!["unit", "controllers", "native", "live"].includes(lane))
    throw new Error("Unknown test lane");
  const roots =
    lane === "unit"
      ? ["apps/factory/src", "packages", "scripts", "test/support"]
      : ["test/integration"];
  const paths: string[] = [];
  for (const root of roots)
    for await (const path of new Bun.Glob("**/*.test.ts").scan(root)) {
      const full = `${root}/${path}`;
      if (lane === "unit" ? !path.endsWith(".live.test.ts") : integrationLane(full) === lane)
        paths.push(full);
    }
  const { filters, flags } = laneSelections(requested);
  const selected = filters.length
    ? paths.filter((path) => filters.some((selection) => path.includes(selection)))
    : paths;
  if (!selected.length) throw new Error("No tests selected in this lane");
  if (requested.includes("--list")) {
    for (const path of selected.sort()) console.log(path);
  } else {
    const prerequisites = await import("./test-prerequisites");
    const env =
      lane === "live" ? { ...process.env } : prerequisites.verificationEnvironment(process.env);
    const cancellation = new AbortController();
    let interrupted: number | undefined;
    const interrupt = (signal: "SIGINT" | "SIGTERM") => {
      interrupted ??= signal === "SIGINT" ? 130 : 143;
      process.exitCode = interrupted;
      if (!cancellation.signal.aborted) cancellation.abort(signal);
    };
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    let buildDirectory: string | undefined;
    let owned:
      | Awaited<
          ReturnType<typeof import("../../test/fixtures/postgres-server").ownedPostgresServer>
        >
      | undefined;
    try {
      if (lane !== "live")
        await prerequisites.prepareTestPrerequisites(selected, env, cancellation.signal);
      cancellation.signal.throwIfAborted();
      // Client and compiled Start handler belong to this invocation. Never rebuild
      // the artifacts a retained Factory or another proof is currently serving.
      if (lane !== "unit" && selected.some(integrationNeedsApplicationBuild)) {
        const parent = resolve(".factory/test-results/application-builds");
        await mkdir(parent, { recursive: true });
        cancellation.signal.throwIfAborted();
        buildDirectory = await mkdtemp(resolve(parent, "lane-"));
        env["FACTORY_BUILD_DIRECTORY"] = buildDirectory;
        const build = await runProcess(
          [process.execPath, "--no-env-file", "run", "factory:build"],
          {
            env: prerequisites.productionBuildEnvironment(env),
            signal: cancellation.signal,
            output: "inherit",
            allowFailure: true,
          },
        );
        if (build.code !== 0) throw new Error("Factory test application build failed");
      }
      // All fixtures retain separate databases. Only daemon startup and the empty
      // migrated baseline are shared by this invocation, never product state.
      cancellation.signal.throwIfAborted();
      if (lane !== "unit" && lane !== "live" && selected.some(controllerNeedsDatabase)) {
        const postgres = await import("../../test/fixtures/postgres-server");
        cancellation.signal.throwIfAborted();
        owned = await postgres.ownedPostgresServer();
      }
      // Let an in-flight external create return its confirmed identity before
      // disposing it. Cancellation does not invent ownership after a lost reply.
      cancellation.signal.throwIfAborted();
      if (owned) env["FACTORY_TEST_POSTGRES"] = JSON.stringify(owned.identity);
      else delete env["FACTORY_TEST_POSTGRES"];
      // `bun run` can prepend a different installed Bun to PATH. Re-enter the
      // pinned tool environment rather than inheriting that launcher binary.
      const child = await runProcess(
        [
          "mise",
          "exec",
          "--",
          "bun",
          "--no-env-file",
          "test",
          ...selected.map((path) => resolve(path)),
          "--timeout",
          lane === "unit" ? "10000" : "60000",
          ...flags,
          ...(lane === "controllers" && env["FACTORY_CONTROLLER_RETRIES"]
            ? ["--retry", env["FACTORY_CONTROLLER_RETRIES"]]
            : []),
        ],
        { env, signal: cancellation.signal, output: "inherit", allowFailure: true },
      );
      process.exitCode = child.code;
    } catch (cause) {
      if (!cancellation.signal.aborted || cause !== cancellation.signal.reason) throw cause;
    } finally {
      try {
        try {
          await owned?.dispose();
        } finally {
          if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
        }
      } finally {
        if (interrupted !== undefined) process.exitCode = interrupted;
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      }
    }
  }
}
