import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess as run } from "../owned-client-process";

const root = resolve(import.meta.dirname, "../..");
export const writerModelTools = {
  java: "temurin-21.0.9+10.0.LTS",
  javaRelease: "https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.9%2B10",
  javaArchiveSHA256: "55a40abeb0e174fdc70f769b34b50b70c3967e0b12a643e6a3e23f9a582aac16",
  // Checked against the publisher-checksummed macOS aarch64 archive.
  javaFiles: {
    "bin/java": "c34e931bdf01480983c9d16f5249a09479799322dad4de2b4b5d183e914e210e",
    "lib/modules": "47be42973c5fa0405fecff529b17fa689305295087f919881f274d28b88e749d",
    "lib/server/libjvm.dylib": "7a196cd2f05dcdfdcfbaf8514680cbc6aec1db7a7fd9e113236e8b6928e535ce",
    release: "dbdc854635cdf3709fd0509d7a6d63df200ac282e8e44d1080a10de7271ecb59",
  },
  // Official stable release asset has no publisher checksum in its release API.
  // This hash pins the bytes fetched directly from that official release.
  tlcURL: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  tlcSHA256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  tlcSource: "5a47802b5c391f59ecdd44117981f4ff8c0656ba",
};
export const staleFenceGuard =
  "  /\\ epoch = captured \\* STALE_FENCE_GUARD: final Writer transaction";
export function staleFenceMutation(source: string) {
  if (source.split(staleFenceGuard).length !== 2)
    throw new Error("Writer model must contain exactly one marked stale-fence guard");
  return source.replace(staleFenceGuard, "  /\\ TRUE \\* deliberate stale-fence mutation");
}
export function checkTLC(
  result: { code: number; stdout: string; stderr: string },
  mutated: boolean,
) {
  const output = result.stdout + result.stderr;
  if (mutated) {
    if (
      result.code !== 12 ||
      !output.includes("Invariant StaleEpochRejected is violated") ||
      !output.includes("The behavior up to this point is") ||
      !output.includes("<Publish ")
    )
      throw new Error(
        "Deliberate stale-fence mutation did not produce the expected TLC counterexample",
      );
  } else if (
    result.code !== 0 ||
    !output.includes("Model checking completed. No error has been found.")
  ) {
    throw new Error("Healthy Writer model did not complete successfully");
  }
}
export type WriterScheduleEvent = "observe" | "reclaim" | "ack";
function permutations<T>(events: readonly T[]): T[][] {
  if (!events.length) return [[]];
  return events.flatMap((event, index) =>
    permutations(events.filter((_, other) => index !== other)).map((tail) => [event, ...tail]),
  );
}
// Generate orders, not a second Writer implementation. Each event is sent to
// the existing controller/SQL seam by test/support/writer-model.test.ts.
export function writerSchedules() {
  return [
    ...permutations<WriterScheduleEvent>(["observe", "ack"]),
    ...permutations<WriterScheduleEvent>(["observe", "reclaim", "ack"]),
  ];
}
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sourcePaths = [
  "test/models/writer.tla",
  "test/models/writer.cfg",
  "scripts/testing/writer-model.ts",
  "test/support/writer-model.test.ts",
  "scripts/owned-client-process.ts",
  "test/fixtures/change-agent-turns.ts",
  "test/fixtures/postgres-server.ts",
  "test/fixtures/factory-process.ts",
  "apps/factory/src/access/change-writer.ts",
  "apps/factory/src/access/writer-controller.ts",
  "apps/factory/src/agent/stop.ts",
  "apps/factory/src/agent/change-admission.ts",
  "apps/factory/src/agent/turn-store.ts",
  "apps/factory/src/delivery/controller.ts",
  "packages/db/src/schema/coding.ts",
  "packages/db/src/schema/access.ts",
  "packages/db/src/schema/delivery.ts",
  "packages/db/src/schema/review.ts",
  "packages/db/src/client.ts",
  "packages/db/native/15-coding-functions.sql",
  "packages/db/native/20-delivery-functions.sql",
  "packages/db/native/55-coding-triggers.sql",
  "packages/db/native/53-planning-triggers.sql",
  "packages/db/native/60-delivery-triggers.sql",
  "packages/db/migrations/0001_baseline.sql",
];

export async function runWriterModel(signal?: AbortSignal) {
  const parent = resolve(root, ".factory/test-results/blueprint-formal");
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(resolve(parent, "run-"));
  const temporary = await mkdtemp(resolve(evidence, "owned-"));
  let postgres:
    | Awaited<ReturnType<typeof import("../../test/fixtures/postgres-server").ownedPostgresServer>>
    | undefined;
  const receipt: Record<string, unknown> = { status: "incomplete", tools: writerModelTools };
  let failure: unknown;
  try {
    const sources = Object.fromEntries(
      await Promise.all(
        sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))]),
      ),
    );
    receipt["sources"] = sources;
    receipt["head"] = (
      await run(["git", "rev-parse", "HEAD"], { cwd: root, signal })
    ).stdout.trim();
    const jar = resolve(root, ".factory/cache/writer-model/tla2tools-1.7.4.jar");
    const bytes = await readFile(jar).catch(() => {
      throw new Error(
        `Official TLC missing. Download ${writerModelTools.tlcURL} to ${jar}; required SHA-256 ${writerModelTools.tlcSHA256}`,
      );
    });
    if (sha256(bytes) !== writerModelTools.tlcSHA256) throw new Error("TLC jar SHA-256 mismatch");
    const located = await run(["mise", "where", `java@${writerModelTools.java}`], {
      cwd: root,
      signal,
      allowFailure: true,
    });
    if (located.code !== 0 || !located.stdout.trim())
      throw new Error(
        `Pinned developer Java missing. Run mise install 'java@${writerModelTools.java}'. Java is not required by test:unit.`,
      );
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error("This pilot's pinned Temurin checksum targets macOS arm64");
    for (const [path, expected] of Object.entries(writerModelTools.javaFiles))
      if (sha256(await readFile(resolve(located.stdout.trim(), path))) !== expected)
        throw new Error(`Installed Temurin differs from its checked official archive: ${path}`);
    const java = resolve(located.stdout.trim(), "bin/java");
    const version = await run([java, "-version"], { signal });
    if (
      !version.stderr.includes("Temurin-21.0.9+10") ||
      !version.stderr.includes('version "21.0.9"')
    )
      throw new Error("Pinned Temurin runtime identity mismatch");
    receipt["javaVersion"] = version.stderr.trim();
    const healthy = await readFile(resolve(root, "test/models/writer.tla"), "utf8");
    const config = await readFile(resolve(root, "test/models/writer.cfg"), "utf8");
    await writeFile(resolve(evidence, "writer.cfg"), config);
    for (const mutated of [true, false]) {
      const name = mutated ? "stale-fence" : "healthy";
      const model = mutated ? staleFenceMutation(healthy) : healthy;
      const directory = resolve(temporary, name);
      await mkdir(directory);
      await writeFile(resolve(directory, "writer.tla"), model);
      await writeFile(resolve(evidence, `${name}.tla`), model);
      await writeFile(resolve(directory, "writer.cfg"), config);
      // TLC is the direct owned child. Reuse the stable run API, no shell,
      // daemon, process follower or new owned-client-process contract.
      const command = [
        java,
        "-XX:ActiveProcessorCount=1",
        "-XX:+UseParallelGC",
        "-Xmx512m",
        `-Djava.io.tmpdir=${directory}`,
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-fp",
        "0",
        "-seed",
        "1",
        "-config",
        "writer.cfg",
        "-metadir",
        "states",
        "writer",
      ];
      const result = await run(command, { cwd: directory, signal, allowFailure: true });
      await writeFile(resolve(evidence, `${name}.log`), result.stdout + result.stderr);
      checkTLC(result, mutated);
      receipt[name] = {
        code: result.code,
        command,
        modelSHA256: sha256(model),
      };
    }
    signal?.throwIfAborted();
    // The parent owns the entire disposable server, including interrupted tests.
    // No production endpoint, app build or paid model is used.
    postgres = await (await import("../../test/fixtures/postgres-server")).ownedPostgresServer();
    signal?.throwIfAborted();
    receipt["postgres"] = { owner: postgres.identity.owner };
    // Pass only local tool/socket configuration and owned fixture identity.
    // Never put inherited model/database credentials into env's argv.
    const env = Object.fromEntries(
      ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    env["TMPDIR"] = temporary;
    env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
    env["FACTORY_WRITER_MODEL_CHECK"] = "1";
    env["FACTORY_WRITER_MODEL_EVIDENCE"] = resolve(evidence, "implementation-sequences.json");
    const command = [
      process.execPath,
      "--no-env-file",
      "test",
      resolve(root, "test/support/writer-model.test.ts"),
      "--timeout",
      "60000",
    ];
    const implementation = await run(command, { cwd: root, env, signal, allowFailure: true });
    await writeFile(
      resolve(evidence, "implementation.log"),
      implementation.stdout + implementation.stderr,
    );
    if (implementation.code !== 0)
      throw new Error("Generated real Writer/DB sequence checks failed");
    const checked = JSON.parse(
      await readFile(resolve(evidence, "implementation-sequences.json"), "utf8"),
    );
    if (checked.status !== "passed" || checked.schedules.length !== writerSchedules().length)
      throw new Error("Generated implementation sequence evidence is missing or incomplete");
    receipt["implementation"] = checked;
    for (const [path, before] of Object.entries(sources))
      if (sha256(await readFile(resolve(root, path))) !== before)
        throw new Error(`Writer pilot source changed during verification: ${path}`);
    receipt["status"] = "passed";
  } catch (cause) {
    receipt["error"] = signal?.aborted
      ? "interrupted"
      : cause instanceof Error
        ? cause.message
        : String(cause);
    failure = cause;
  } finally {
    try {
      await postgres?.dispose();
    } catch (cause) {
      receipt["status"] = "incomplete";
      receipt["cleanupError"] = cause instanceof Error ? cause.message : String(cause);
      failure = failure
        ? new AggregateError([failure, cause], "Writer pilot and cleanup failed")
        : cause;
    } finally {
      await rm(temporary, { recursive: true, force: true });
      if (signal?.aborted) {
        receipt["status"] = "incomplete";
        receipt["error"] = "interrupted";
        failure ??= signal.reason;
      }
      await writeFile(resolve(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      console.info(`Writer pilot evidence: ${evidence}`);
    }
  }
  if (failure) throw failure;
}

if (import.meta.main) {
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort("SIGINT");
  const terminate = () => cancellation.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await runWriterModel(cancellation.signal);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = cancellation.signal.aborted
      ? cancellation.signal.reason === "SIGTERM"
        ? 143
        : 130
      : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
