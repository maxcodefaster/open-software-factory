import { resolve } from "node:path";

const nativeNames = new Set([
  "agent-native-commit-recovery",
  "build-browser",
  "build-browser-client",
  "change-writer-source",
  "native-skill-loading",
  "project-setup-forge",
  "native-enterprise-identity",
  "native-forge-issuer",
  "openbao",
]);
export function integrationLane(path: string) {
  const name = path
    .split("/")
    .at(-1)!
    .replace(/\.test\.ts$/, "");
  return name.endsWith(".live")
    ? "live"
    : name.startsWith("opencode-") || nativeNames.has(name)
      ? "native"
      : "controllers";
}

export const browserFiles = {
  paid: ["agent-turn-live.spec.ts", "project-agent.spec.ts"],
  manual: [
    "change-agent.spec.ts",
    "change-recovery.spec.ts",
    "runtime-recovery.spec.ts",
    "ux-starter-capture.spec.ts",
  ],
  native: [
    "runtime-console.spec.ts",
    "delivery.spec.ts",
    "workspace-startup.live.spec.ts",
    "starter-editor.live.spec.ts",
    "stabilization.live.spec.ts",
    "contributor-implementation.live.spec.ts",
  ],
};
// These retain their ordinary UI cases in the default lane; only @paid cases
// require the paid lane. They must also be discoverable by that explicit lane.
export const mixedPaidBrowserFiles = ["ticket-requirements-journey.spec.ts"];
export function browserLane(path: string) {
  const name = path.split("/").at(-1)!;
  for (const [lane, files] of Object.entries(browserFiles)) if (files.includes(name)) return lane;
  if (name.includes(".live.")) throw new Error(`Unclassified browser live proof: ${name}`);
  return "ui";
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
  const filters = requested.filter((selection) => selection !== "--list");
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
    if (lane !== "live") await prerequisites.prepareTestPrerequisites(selected, env);
    // All fixtures retain separate databases. Only daemon startup and the empty
    // migrated baseline are shared by this invocation, never product state.
    const owned =
      lane === "unit" || lane === "live"
        ? undefined
        : await (await import("../../test/fixtures/postgres-server")).ownedPostgresServer();
    try {
      if (owned) env["FACTORY_TEST_POSTGRES"] = JSON.stringify(owned.identity);
      else delete env["FACTORY_TEST_POSTGRES"];
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "test",
          ...selected.map((path) => resolve(path)),
          "--timeout",
          lane === "unit" ? "10000" : "60000",
        ],
        { env, stdout: "inherit", stderr: "inherit" },
      );
      process.exitCode = await child.exited;
    } finally {
      await owned?.dispose();
    }
  }
}
