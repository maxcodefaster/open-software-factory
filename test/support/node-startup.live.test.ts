import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { editorFixtureKubectl } from "../fixtures/editor-source-resources";

const enabled = process.env["FACTORY_RUN_NODE_STARTUP_PROOF"] === "1";
const metadata = z.object({ uid: z.string(), labels: z.record(z.string(), z.string()) });
const pod = z.object({
  metadata: metadata.extend({ creationTimestamp: z.string() }),
  status: z
    .object({
      phase: z.string().optional(),
      conditions: z
        .array(z.object({ type: z.string(), lastTransitionTime: z.string() }))
        .optional(),
      containerStatuses: z
        .array(
          z.object({
            state: z.object({ running: z.object({ startedAt: z.string() }).optional() }),
          }),
        )
        .optional(),
    })
    .optional(),
});

async function kubectl(args: string[], input?: unknown) {
  return editorFixtureKubectl(args, input);
}

test.skipIf(!enabled)(
  "cached node startup separates Pod, Secret and fresh PVC waits",
  async () => {
    const proofID = randomUUID();
    const namespace = `factory-node-probe-${proofID.slice(0, 8)}`;
    const labels = { "factory.dev/node-startup-proof": proofID };
    const image = (await readFile(".factory/workspace-files-image", "utf8")).trim();
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
    const artifacts = resolve(".factory/test-results/node-startup", proofID);
    await mkdir(artifacts, { recursive: true });
    const created = metadata.parse(
      JSON.parse(
        await kubectl(["create", "-f", "-", "-o", "json"], {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespace, labels },
        }),
      ).metadata,
    );
    const observations: Array<{ mode: string; readyMS: number; observation: z.infer<typeof pod> }> =
      [];
    try {
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({ namespace, uid: created.uid, proofID, image }),
      );
      await kubectl(["create", "-f", "-"], {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "probe", namespace, labels },
        stringData: { "probe.txt": "No credentials in this diagnostic" },
      });
      for (const mode of ["plain", "secret", "pvc"] as const) {
        if (mode === "pvc")
          await kubectl(["create", "-f", "-"], {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: { name: "probe", namespace, labels },
            spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "8Gi" } } },
          });
        const started = performance.now();
        await kubectl(["create", "-f", "-"], {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: mode, namespace, labels },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 1,
            containers: [
              {
                name: "probe",
                image,
                imagePullPolicy: "IfNotPresent",
                command: ["/bin/sh", "-c", "sleep 180"],
                resources: {
                  requests: { cpu: "10m", memory: "16Mi" },
                  limits: { cpu: "250m", memory: "32Mi" },
                },
                securityContext: {
                  runAsUser: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                ...(mode === "plain"
                  ? {}
                  : { volumeMounts: [{ name: "probe", mountPath: "/probe", readOnly: true }] }),
              },
            ],
            ...(mode === "plain"
              ? {}
              : {
                  volumes: [
                    {
                      name: "probe",
                      ...(mode === "secret"
                        ? { secret: { secretName: "probe" } }
                        : { persistentVolumeClaim: { claimName: "probe" } }),
                    },
                  ],
                }),
          },
        });
        let observation: z.infer<typeof pod> | undefined;
        while (performance.now() - started < 60_000) {
          observation = pod.parse(
            JSON.parse(await kubectl(["get", "pod", mode, "-n", namespace, "-o", "json"])),
          );
          if (observation.status?.containerStatuses?.[0]?.state.running) break;
          await Bun.sleep(250);
        }
        expect(observation?.status?.containerStatuses?.[0]?.state.running).toBeDefined();
        if (!observation) throw new Error("Node probe observation missing");
        const readyMS = Math.round(performance.now() - started);
        observations.push({ mode, readyMS, observation });
        console.log(JSON.stringify({ mode, readyMS, conditions: observation.status?.conditions }));
      }
      await writeFile(resolve(artifacts, "result.json"), JSON.stringify(observations));
      for (const observation of observations)
        expect(observation.readyMS).toBeLessThanOrEqual(3_000);
    } finally {
      const current = metadata.parse(
        JSON.parse(await kubectl(["get", "namespace", namespace, "-o", "json"])).metadata,
      );
      expect(current.uid).toBe(created.uid);
      expect(current.labels["factory.dev/node-startup-proof"]).toBe(proofID);
      await kubectl(["delete", "--raw", `/api/v1/namespaces/${namespace}`, "-f", "-"], {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: created.uid },
      });
      const deadline = performance.now() + 90_000;
      let removed = false;
      while (performance.now() < deadline) {
        if (
          !(
            await kubectl(["get", "namespace", namespace, "--ignore-not-found", "-o", "name"])
          ).trim()
        ) {
          removed = true;
          break;
        }
        await Bun.sleep(500);
      }
      await writeFile(
        resolve(artifacts, "cleanup.json"),
        JSON.stringify({ namespace, uid: created.uid, deletionRequested: true, removed }),
      );
      expect(removed).toBe(true);
    }
  },
  300_000,
);
