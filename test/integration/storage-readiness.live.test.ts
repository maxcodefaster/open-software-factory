import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import {
  disposeRuntimeStorageCheck,
  requireWritableRuntimeStorage,
} from "../../scripts/factory/storage-readiness";

test.skipIf(process.env["FACTORY_RUN_STORAGE_READINESS_PROOF"] !== "1")(
  "native startup storage writes as the source UID, recovers a lost create response and removes its exact resources",
  async () => {
    const directory = resolve(
      ".factory/test-results/storage-readiness-native",
      crypto.randomUUID(),
    );
    const stateDirectory = resolve(directory, "state");
    await mkdir(directory, { recursive: true });
    const artifacts = JSON.parse(
      await readFile(".factory/runtime-artifacts.json", "utf8"),
    ) as Record<string, string>;
    const image = artifacts["workspace-files"];
    if (!image) throw new Error("Published workspace-files image is required");
    const calls: string[][] = [];
    let lostCreate = false;
    let namespaceCreates = 0;
    let result: Awaited<ReturnType<typeof requireWritableRuntimeStorage>> | undefined;
    const command: typeof runCommand = async (argv, input, limits) => {
      calls.push([...argv]);
      const output = await runCommand(argv, input, limits);
      if (
        argv.includes("create") &&
        input &&
        JSON.parse(input).kind === "Namespace" &&
        output.exitCode === 0
      ) {
        namespaceCreates++;
        if (!lostCreate) {
          lostCreate = true;
          throw new Error("Infrastructure command timed out; outcome is unconfirmed");
        }
      }
      return output;
    };
    try {
      result = await requireWritableRuntimeStorage({ stateDirectory, image }, command);
      expect(namespaceCreates).toBe(1);
      expect(lostCreate).toBe(true);
      const diagnostic = JSON.parse(await readFile(result.diagnosticFile, "utf8"));
      expect(diagnostic).toMatchObject({
        checkID: result.checkID,
        verified: true,
        cleanupConfirmed: true,
      });
      expect(diagnostic.snapshots.at(-1)).toMatchObject({
        claim: { phase: "Bound" },
        pod: {
          phase: "Succeeded",
          containers: [
            {
              name: "storage-check",
              state: { terminated: { exitCode: 0 } },
            },
          ],
        },
      });
      const remaining = await runCommand(
        kubernetesCommand([
          "--request-timeout=10s",
          "get",
          "namespace",
          result.namespace,
          "--ignore-not-found",
          "-o",
          "json",
        ]),
      );
      expect(remaining.exitCode).toBe(0);
      expect(remaining.stdout.trim()).toBe("");
      for (const argv of calls.filter((args) => args.includes("delete"))) {
        const path = argv[argv.indexOf("--raw") + 1];
        expect(path?.startsWith(`/api/v1/namespaces/${result.namespace}`)).toBe(true);
      }
      expect(calls.some((args) => args.includes("finalize"))).toBe(false);
      await writeFile(
        resolve(directory, "result.json"),
        JSON.stringify(
          {
            status: "passed",
            ...result,
            namespaceCreates,
            lostCreateRecovered: lostCreate,
            namespaceAbsent: true,
            evidence: diagnostic,
            commands: calls,
          },
          null,
          2,
        ),
      );
    } finally {
      // This also handles a failure after an external create without clearing its
      // identity. It never deletes unrelated resources or bypasses finalizers.
      await disposeRuntimeStorageCheck(stateDirectory);
    }
  },
  360_000,
);
