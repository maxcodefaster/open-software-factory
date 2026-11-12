// Controlled foreign mount and dirty-source faults in one owned native fixture.
// Never relax integrity, restore attempts, mounts, or lifecycle deadlines.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import {
  configuredFactoryboxRuntimeProfile,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeRequest,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { executeFactoryboxOperation } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { createConformanceRuntime } from "./factorybox-conformance";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/filesystem-integrity", owner);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const image = process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"];
if (!image) throw new Error("Pinned runtime image is required");
const runtime = createConformanceRuntime(
  owner,
  image,
  configuredFactoryboxRuntimeProfile(),
  await readRuntimeRegistryCA(),
  directory,
);
let passed = false;
try {
  await runtime.prepare();
  const target = runtime.target();
  const state = async () => {
    const result = await executeFactoryboxOperation(
      factoryboxRuntimeRequest(target.input),
      target.identity,
      { action: "state", sandboxID: target.input.sandboxID },
      undefined,
      factoryboxRuntimeDeclaration(target.input),
    );
    if (!result.confirmed) throw new Error("Original filesystem fixture state is unconfirmed");
    return JSON.parse(result.stdout);
  };
  const original = await state();
  const bundle = original.record.input_bundle as string;
  const expectedBundle = `/var/lib/sysbox/fixed-store/data/store/input/${target.input.sandboxID}/bundle`;
  if (bundle !== expectedBundle) throw new Error("Filesystem fault leaves its owned input bundle");
  const upper = `${bundle}/mutable/upper`;
  const command = async (args: string[]) => {
    const result = await runCommand(
      kubernetesCommand([
        "exec",
        target.input.podName,
        "-n",
        target.input.namespace,
        "-c",
        "worker",
        "--",
        ...args,
      ]),
      undefined,
      { timeoutMS: 10_000, outputBytes: 16_384 },
    );
    if (result.exitCode !== 0)
      throw new Error(`Owned filesystem fixture command failed: ${result.stderr}`);
    return result.stdout;
  };
  const refused = async (snapshotID: string, name: string, expected: RegExp) => {
    let refusal = "";
    try {
      await runtime.resume(target.input.sandboxID, snapshotID);
    } catch (cause) {
      refusal = cause instanceof Error ? cause.message : "refused";
    }
    if (!expected.test(refusal))
      throw new Error("Foreign or changed backing lacked its expected native integrity refusal");
    const observed = await state();
    if (
      observed.record.pause.snapshot_id !== snapshotID ||
      observed.record.pause.resume.attempted !== false ||
      observed.runtime.status !== "stopped"
    )
      throw new Error("Filesystem fault changed attempted-restore authority");
    await save(name, { refusal, observed, restoreAttempted: false });
  };
  const first = await runtime.pause();
  await save("foreign-mount-intent.json", { upper, snapshotID: first.snapshotID, owner });
  await command(["mount", "-t", "tmpfs", "-o", "size=1m,mode=0700", "tmpfs", upper]);
  try {
    await refused(first.snapshotID, "foreign-mount-refusal.json", /mount|backing|identity/);
  } finally {
    await command(["umount", "--", upper]);
  }
  await runtime.resume(target.input.sandboxID, first.snapshotID);
  const second = await runtime.pause();
  const marker = `${upper}/var/tmp/factory-filesystem-fault-${owner}`;
  await save("dirty-source-intent.json", { marker, snapshotID: second.snapshotID, owner });
  await command([
    "python3",
    "-c",
    "import os,sys;os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True);fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.write(fd,b'owned deliberate fault');os.fsync(fd);os.close(fd)",
    marker,
  ]);
  await refused(second.snapshotID, "dirty-source-refusal.json", /native filesystem root changed/);
  // The changed source is intentionally not 'repaired' by timestamp manipulation.
  // Confirmed deletion/retirement remains owned by the normal fixture cleanup.
  passed = true;
  await runtime.passed();
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Filesystem integrity proof failed",
  });
  throw cause;
} finally {
  await runtime.cleanup();
}
await save("result.json", {
  passed,
  foreignMountRefusedBeforeAttempt: true,
  dirtySourceRefusedBeforeAttempt: true,
  exactUnattemptedMountFaultRecovered: true,
  scope: "Negative backing integrity only; no weaker verification or barrier removal selected",
});
console.log(JSON.stringify({ evidence: directory, passed }));
