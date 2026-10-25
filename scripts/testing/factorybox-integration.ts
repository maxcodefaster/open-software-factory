import { verificationEnvironment } from "./test-prerequisites";

// The caller supplies an owned PostgreSQL fixture. No installation is started.
const env = verificationEnvironment(process.env);
const migration = Bun.spawn([process.execPath, "--no-env-file", "packages/db/src/migrate.ts"], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
if (await migration.exited) throw new Error("Owned Factorybox migration checks failed");
const checks = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    "test",
    "test/integration/runtime-artifacts.test.ts",
    "test/integration/idle-compute.test.ts",
    "test/integration/factorybox-lifecycle.test.ts",
    "test/integration/execution-reserve.test.ts",
    "--timeout",
    "60000",
  ],
  { env, stdout: "inherit", stderr: "inherit" },
);
const status = await checks.exited;
if (status) process.exitCode = status;
else {
  const sourceEnv = { ...env };
  delete sourceEnv["FACTORY_FACTORYBOX_NODE"];
  const sources = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      "test/integration/workspace-source.test.ts",
      "--timeout",
      "60000",
    ],
    { env: sourceEnv, stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await sources.exited;
}
