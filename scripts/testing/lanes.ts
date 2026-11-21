import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { runProcess } from "../owned-client-process";

const nativeNames = new Set([
  "backup-runner.native",
  "substrate-adapter.native",
  "substrate-rootless-proxy.native",
  "substrate-workspaces.native",
  "developer-ide-kubernetes.native",
  "substrate-coding-stop",
  "substrate-writer-input-stop",
  "repository-mirrors.native",
  "forgejo-diagnostics.native",
  "native-project-releases",
  "attachment-s3",
  "object-storage.native",
  "attachment-browser",
  "attachment-factory-browser",
  "agent-native-commit-recovery",
  "build-browser",
  "build-browser-client",
  "browser-tools-package.native",
  "change-writer-source",
  "native-skill-loading",
  "project-setup-forge",
  "native-enterprise-identity",
  "native-forge-issuer",
  "openbao",
]);
const selfContainedControllerTests = new Set([
  "backup-runner.native.test.ts",
  "browser-tools-package.native.test.ts",
  "substrate-adapter.test.ts",
  "substrate-adapter.native.test.ts",
  "substrate-rootless-proxy.native.test.ts",
  "developer-ide-kubernetes.native.test.ts",
  "native-project-releases.test.ts",
  "substrate-workspaces.test.ts",
  "substrate-workspace-stop.test.ts",
  "substrate-runtime-list.test.ts",
  "substrate-coding-stop.test.ts",
  "substrate-workspace-generations.test.ts",
  "substrate-usage.test.ts",
  "substrate-idle.test.ts",
  "substrate-input-stop.test.ts",
  "substrate-lifecycle-facts.test.ts",
  "substrate-reset.test.ts",
  "substrate-pause-failure.test.ts",
  "workspace-commands.test.ts",
  "workspace-container-files.test.ts",
  "workspace-sharing.test.ts",
  "substrate-verification.test.ts",
  "substrate-isolated.test.ts",
  "substrate-prebuild.test.ts",
  "substrate-workspaces.native.test.ts",
  "substrate-source.test.ts",
  "substrate-source-access.test.ts",
  "openbao.test.ts",
  "postgres-baseline.test.ts",
  "schema-baseline.test.ts",
  "attachments-store.test.ts",
  "conversation-persistence.test.ts",
  "review-media.test.ts",
  "native-ui-fixture.test.ts",
  "native-fixture-observation.test.ts",
  "uncreated-workspace-attempt.test.ts",
  "runtime-app-origins.test.ts",
  "runtime-declared-apps.test.ts",
  "project-preparation.test.ts",
  "verification-cancellation.test.ts",
  "usage-cleanup.test.ts",
  "server-function-repository-mirrors.test.ts",
  "client-budgets.test.ts",
  "server-function-learning.test.ts",
  "server-function-inbox.test.ts",
  "server-function-runtime.test.ts",
  "server-function-tickets.test.ts",
  "server-function-delivery.test.ts",
  "server-function-streams.test.ts",
  "server-function-knowledge.test.ts",
  "server-function-workspaces.test.ts",
  "server-function-attachments.test.ts",
  "server-function-access.test.ts",
  "server-function-settings.test.ts",
  "server-function-setup.test.ts",
  "server-function-skills.test.ts",
  "server-function-mcp-inputs.test.ts",
  "server-function-writer-review.test.ts",
]);

export function controllerNeedsDatabase(path: string) {
  return !selfContainedControllerTests.has(path.split("/").at(-1) ?? "");
}
export function integrationNeedsApplicationBuild(path: string) {
  return ![
    "backup-runner.native.test.ts",
    "browser-tools-package.native.test.ts",
    "substrate-rootless-proxy.native.test.ts",
    "openbao.test.ts",
    "schema-baseline.test.ts",
    "postgres-baseline.test.ts",
    "attachments-store.test.ts",
    "conversation-persistence.test.ts",
    "review-media.test.ts",
    "project-release-store.test.ts",
    "project-registration-authority.test.ts",
    "mcp-library.test.ts",
    "mcp-oauth.test.ts",
    "mcp-cancellation.test.ts",
    "agent-read.test.ts",
    "agent-turn-store.test.ts",
    "coding-source-dispatch-fence.test.ts",
    "fixture-cleanup.test.ts",
    "native-ui-fixture.test.ts",
    "change-document-drizzle.test.ts",
    "delivery-controller-drizzle.test.ts",
    "inbox.test.ts",
    "skills-controllers-drizzle.test.ts",
    "substrate-drizzle.test.ts",
    "substrate-bound-provisioning.test.ts",
    "substrate-lifecycle-facts.test.ts",
    "usage-journal.test.ts",
    "usage-policy.test.ts",
    "coding-budget.test.ts",
    "workspace-sharing.test.ts",
    "workspace-commands.test.ts",
    "workspace-container-files.test.ts",
    "substrate-source.test.ts",
    "substrate-source-access.test.ts",
    "developer-ide.test.ts",
    "developer-ide-access-recovery.test.ts",
  ].includes(basename(path));
}
export function integrationLane(path: string) {
  const name = basename(path).replace(/\.test\.ts$/, "");
  return name.endsWith(".live")
    ? "live"
    : name.startsWith("opencode-") || nativeNames.has(name)
      ? "native"
      : "controllers";
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
