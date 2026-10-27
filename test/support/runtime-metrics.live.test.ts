import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { createConformanceRuntime } from "../../scripts/runtime/factorybox-conformance";
import upstream from "../../upstream.json";

test.skipIf(process.env["FACTORY_RUN_METRICS_PROOF"] !== "1")(
  "Factorybox Sandbox metrics attribute controlled private-Docker CPU and memory",
  async () => {
    const owner = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/runtime-metrics", owner);
    await mkdir(artifacts, { recursive: true });
    const image = (
      process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"] ??
      (await readFile(".factory/runtime-host-image", "utf8"))
    ).trim();
    const runtime = createConformanceRuntime(
      owner,
      image,
      configuredFactoryboxRuntimeProfile(),
      await readRuntimeRegistryCA(),
      artifacts,
    );
    const command = async (args: string[]) => {
      const result = await runCommand(runtime.execArgs(["docker", ...args]), undefined, {
        timeoutMS: 60_000,
        outputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0)
        throw new Error(result.stderr || "Owned metrics private-Docker command failed");
      return result.stdout;
    };
    try {
      await runtime.prepare();
      await runtime.boundary();
      // The runtime filesystem is a verified Factorybox base, not an image in
      // an ambient host Docker daemon. Acquire this workload only in its own
      // private daemon and retain the immutable image identity for every run.
      await command(["pull", upstream.nodeDevelopment.image]);
      await command(["run", "--rm", "--pull=never", upstream.nodeDevelopment.image, "node", "-v"]);
      let baseline = await runtime.metrics();
      for (let attempt = 0; attempt < 20 && baseline.status !== "available"; attempt++) {
        await Bun.sleep(2000);
        baseline = await runtime.metrics();
      }
      expect(baseline.status).toBe("available");
      // Image acquisition can release memory after readiness. Keep the
      // existing stability control before introducing the attributed load.
      let stable = 0;
      for (let attempt = 0; attempt < 20 && stable < 2; attempt++) {
        await Bun.sleep(5000);
        const current = await runtime.metrics();
        stable =
          current.status === "available" &&
          Math.abs((current.memoryMiB ?? 0) - (baseline.memoryMiB ?? 0)) < 24 &&
          (current.cpuMilli ?? 0) < 100
            ? stable + 1
            : 0;
        baseline = current;
      }
      expect(stable).toBe(2);
      await command([
        "run",
        "--detach",
        "--name",
        "owned-metrics-load",
        "--label",
        `factory.dev/metrics-owner=${owner}`,
        "--pull=never",
        upstream.nodeDevelopment.image,
        "node",
        "-e",
        "const buffer=Buffer.alloc(256*1024*1024,1);const until=Date.now()+60000;while(Date.now()<until){Math.sqrt(Math.random());}setInterval(()=>console.log(buffer[0]),10000)",
      ]);
      let load = baseline;
      for (let attempt = 0; attempt < 12; attempt++) {
        await Bun.sleep(3000);
        load = await runtime.metrics();
        if (
          (load.cpuMilli ?? 0) > (baseline.cpuMilli ?? 0) + 100 &&
          (load.memoryMiB ?? 0) > (baseline.memoryMiB ?? 0) + 100
        )
          break;
      }
      await writeFile(
        resolve(artifacts, "attribution.json"),
        `${JSON.stringify({ owner, baseline, load }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      expect(load.status).toBe("available");
      expect(load.cpuMilli ?? 0).toBeGreaterThan((baseline.cpuMilli ?? 0) + 100);
      expect(load.memoryMiB ?? 0).toBeGreaterThan((baseline.memoryMiB ?? 0) + 100);
      await runtime.boundary();
      await runtime.passed();
    } finally {
      // This fixture owns a separate worker/store. Success deletes only its
      // UID-checked namespace; failure fences that exact Pod and retains data.
      await runtime.cleanup();
    }
  },
  420_000,
);
