import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createReserveClient } from "../../packages/runtime-kubernetes/src/reserve";
import { createCurrentMetrics } from "../../packages/runtime-kubernetes/src/metrics";
import { reserveIdentity } from "../../packages/runtime-domain/src/reserve";
import type { ExecutionSlot } from "../../packages/runtime-domain/src/reserve";
import upstream from "../../upstream.json";

test.skipIf(process.env["FACTORY_RUN_METRICS_PROOF"] !== "1")(
  "outer Envbox metrics attribute controlled private-Docker CPU and memory",
  async () => {
    const identity = reserveIdentity(crypto.randomUUID());
    let slot: ExecutionSlot = {
      ...identity,
      role: "staging",
      state: "creating",
      runtimeHostImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
      namespaceUID: null,
      podUID: null,
      claimUID: null,
      assignedAttemptID: null,
      expiresAt: new Date(Date.now() + 180000).toISOString(),
    };
    let ready = false;
    const adapter = createReserveClient(),
      metrics = createCurrentMetrics();
    async function command(args: string[]) {
      const child = Bun.spawn(["kubectl", "--context", "orbstack", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(error);
      return output;
    }
    try {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const observed = await adapter.prepare(slot);
        slot = {
          ...slot,
          namespaceUID: observed.namespaceUID,
          podUID: observed.podUID,
          claimUID: observed.claimUID,
        };
        if (observed.ready) {
          ready = true;
          break;
        }
        if (observed.failed) throw new Error("Owned Envbox metrics fixture failed");
        await Bun.sleep(1000);
      }
      if (!ready || !slot.podUID) throw new Error("Owned Envbox did not become ready");
      let baseline = await metrics(slot.namespace, "slot", slot.podUID);
      for (let attempt = 0; attempt < 20 && baseline.status !== "available"; attempt++) {
        await Bun.sleep(2000);
        baseline = await metrics(slot.namespace, "slot", slot.podUID);
      }
      expect(baseline.status).toBe("available");
      // Image preparation can release memory after readiness. Warm the exact inner
      // image first, then require stable measured working sets before adding load.
      await command([
        "exec",
        "-n",
        slot.namespace,
        "slot",
        "--",
        "docker",
        "exec",
        "workspace_cvm",
        "docker",
        "run",
        "--rm",
        "--pull=never",
        upstream.nodeDevelopment.image,
        "node",
        "-v",
      ]);
      let stable = 0;
      for (let attempt = 0; attempt < 20 && stable < 2; attempt++) {
        await Bun.sleep(5000);
        const current = await metrics(slot.namespace, "slot", slot.podUID);
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
        "exec",
        "-n",
        slot.namespace,
        "slot",
        "--",
        "docker",
        "exec",
        "workspace_cvm",
        "docker",
        "run",
        "--detach",
        "--name",
        "owned-metrics-load",
        "--pull=never",
        upstream.nodeDevelopment.image,
        "node",
        "-e",
        "const buffer=Buffer.alloc(256*1024*1024,1);const until=Date.now()+60000;while(Date.now()<until){Math.sqrt(Math.random());}setInterval(()=>console.log(buffer[0]),10000)",
      ]);
      let load = baseline;
      for (let attempt = 0; attempt < 12; attempt++) {
        await Bun.sleep(3000);
        load = await metrics(slot.namespace, "slot", slot.podUID);
        if (
          (load.cpuMilli ?? 0) > (baseline.cpuMilli ?? 0) + 100 &&
          (load.memoryMiB ?? 0) > (baseline.memoryMiB ?? 0) + 100
        )
          break;
      }
      console.log("Owned inner Envbox attribution", { baseline, load });
      expect(load.status).toBe("available");
      expect(load.cpuMilli ?? 0).toBeGreaterThan((baseline.cpuMilli ?? 0) + 100);
      expect(load.memoryMiB ?? 0).toBeGreaterThan((baseline.memoryMiB ?? 0) + 100);
    } finally {
      await adapter.retire({ ...slot, state: "retiring" });
    }
  },
  360000,
);
