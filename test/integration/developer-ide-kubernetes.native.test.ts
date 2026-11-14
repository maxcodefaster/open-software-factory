import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { runEnvironmentCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesConnectionEnvironment } from "../../packages/runtime-kubernetes/src/config";
import { createDeveloperIDEClient } from "../../packages/runtime-kubernetes/src/developer-ide";
import { createDeveloperIDEKubernetesClient } from "../../packages/runtime-kubernetes/src/developer-ide-kubernetes";
import { developerIDEIdentity } from "../../packages/workspace-domain/src/developer-ide";
import upstream from "../../upstream.json";
import { eventually } from "../fixtures/factory-process";

test("the editor-only Kubernetes path creates, observes and UID-deletes its exact nonprivileged Pod", async () => {
  const context = process.env["FACTORY_IDE_NATIVE_CONTEXT"];
  if (!context?.trim() || context !== context.trim())
    throw Error("Explicit FACTORY_IDE_NATIVE_CONTEXT is required");
  const owner = crypto.randomUUID();
  const identity = developerIDEIdentity(owner, 1, crypto.randomUUID());
  const directory = resolve(".factory/test-results/native-ide-kubernetes", owner);
  await mkdir(directory, { recursive: true });
  const input = {
    identity,
    // This ordinary container proves Kubernetes admission and ownership only.
    // It is not the Theia application or a native Substrate Actor qualification.
    image: upstream.node.image,
    namespaceUID: null as string | null,
    podUID: null as string | null,
  };
  await writeFile(
    resolve(directory, "intent.json"),
    JSON.stringify({
      owner,
      context,
      ...input,
      nativeSubstrateProof: false,
      editorApplicationProof: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const calls: string[][] = [];
  let namespaceUID: string | undefined;
  let podUID: string | undefined;
  const execute = async (args: string[], body?: string) => {
    calls.push(args);
    const result = await runEnvironmentCommand(
      ["kubectl", "--context", context, "--request-timeout=10s", ...args],
      kubernetesConnectionEnvironment(),
      { timeoutMS: 15_000, outputBytes: 4 * 1024 * 1024 },
      body,
    );
    if (args[0] === "create" && result.exitCode === 0) {
      const declaration = JSON.parse(body ?? "null");
      const metadata = z
        .object({ metadata: z.object({ uid: z.string().min(1) }) })
        .parse(JSON.parse(result.stdout)).metadata;
      if (declaration.kind === "Namespace") namespaceUID = metadata.uid;
      if (declaration.kind === "Pod") podUID = metadata.uid;
    }
    return result;
  };
  const kubernetes = createDeveloperIDEKubernetesClient(execute);
  const client = createDeveloperIDEClient(kubernetes, async (args, body) => {
    const result = await execute(args, body === undefined ? undefined : JSON.stringify(body));
    if (result.exitCode === 0) return result.stdout;
    if (/NotFound|not found/.test(result.stderr)) return null;
    throw Error(`Owned editor infrastructure observation failed: ${result.stderr.slice(-1000)}`);
  });
  let failed = false;
  let failure: unknown;
  try {
    expect(await kubernetes.getNamespace(identity.namespace)).toBeNull();
    const admitted = await client.prepare(input);
    input.namespaceUID = admitted.namespaceUID;
    input.podUID = admitted.podUID;
    if (!namespaceUID || !podUID)
      throw Error("Original editor Create identities were not recorded");
    expect(input.namespaceUID).toBe(namespaceUID);
    expect(input.podUID).toBe(podUID);
    await eventually(
      () => client.observe(input),
      (value) => value?.failed === true,
      "Owned Node component did not finish in its nonprivileged editor declaration",
      60_000,
    );
    const readPod = async () => {
      const result = await execute([
        "get",
        "pod",
        identity.podName,
        "-n",
        identity.namespace,
        "-o",
        "json",
      ]);
      if (result.exitCode !== 0) throw Error("Owned editor Pod was not independently observed");
      return JSON.parse(result.stdout);
    };
    const pod = await readPod();
    expect(pod.status.phase).toBe("Succeeded");
    expect(pod.metadata.uid).toBe(podUID);
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.containers[0].securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(JSON.stringify(pod.spec.volumes)).not.toMatch(/hostPath|docker\.sock/);
    await expect(client.stop({ ...input, podUID: crypto.randomUUID() })).rejects.toThrow(
      "persisted intent",
    );
    expect((await readPod()).metadata.uid).toBe(podUID);
    await client.stop(input);
    expect(await client.observe(input)).toBeNull();
    await client.stop(input);
    expect(calls.filter((args) => args[0] === "create")).toHaveLength(2);
    expect(calls.filter((args) => args[0] === "delete")).toHaveLength(1);
    expect(
      calls.some(
        (args) => args.includes("apply") || args.includes("patch") || args.includes("finalize"),
      ),
    ).toBe(false);
    await writeFile(
      resolve(directory, "observations.json"),
      JSON.stringify({
        lifecycleAssertionsPassed: true,
        namespaceUID,
        podUID,
        node: pod.spec.nodeName,
        image: input.image,
        calls,
        nativeSubstrateProof: false,
        editorApplicationProof: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  try {
    client.close();
    const current = await kubernetes.getNamespace(identity.namespace);
    if (current) {
      if (
        !namespaceUID ||
        current.uid !== namespaceUID ||
        current.labels["factory.dev/runtime-owner"] !== owner ||
        current.labels["app.kubernetes.io/managed-by"] !== "open-software-factory"
      )
        throw Error("Owned editor Namespace identity changed; resources retained");
      if (podUID) await client.stop({ ...input, namespaceUID, podUID });
      const remaining = await execute([
        "get",
        "pods,pvc,secrets,services",
        "-n",
        identity.namespace,
        "-o",
        "json",
      ]);
      if (
        remaining.exitCode !== 0 ||
        z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(remaining.stdout)).items.length
      )
        throw Error("Unexpected editor fixture resources remain; Namespace retained");
      const deletion = {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: namespaceUID },
      };
      await writeFile(
        resolve(directory, "cleanup-intent.json"),
        JSON.stringify({ context, namespace: identity.namespace, deletion }),
        { flag: "wx", mode: 0o600 },
      );
      const deleted = await execute(
        ["delete", "--raw", `/api/v1/namespaces/${identity.namespace}`, "-f", "-"],
        JSON.stringify(deletion),
      );
      if (deleted.exitCode !== 0) throw Error("Owned editor Namespace deletion is unconfirmed");
      await eventually(
        () => kubernetes.getNamespace(identity.namespace),
        (value) => value === null,
        "Owned editor Namespace remained",
        60_000,
      );
    }
    await writeFile(
      resolve(directory, "cleanup.json"),
      JSON.stringify({ removed: true, namespaceUID, podUID }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (cause) {
    if (failed) throw new AggregateError([failure, cause], "Editor proof and owned cleanup failed");
    throw cause;
  }
  if (failed) throw failure;
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify({
      passed: true,
      namespaceUID,
      podUID,
      observations: "observations.json",
      cleanup: "cleanup.json",
      nativeSubstrateProof: false,
      editorApplicationProof: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
}, 180_000);
