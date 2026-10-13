import upstream from "../../../upstream.json";

export interface RuntimePodObservation {
  readonly uid: string;
  readonly phase: string;
  readonly labels: Record<string, string>;
  readonly envboxImage: string;
  readonly runtimeHostImage: string;
}
export function requireRuntimePodArtifacts(pod: RuntimePodObservation, runtimeHostImage: string) {
  if (pod.envboxImage !== upstream.envbox.image || pod.runtimeHostImage !== runtimeHostImage)
    throw new Error("Runtime Pod artifacts differ from immutable create intent");
}

export interface KubernetesClient {
  apply(
    resources: readonly unknown[],
    expectedNamespace?: { ownerID: string; uid: string | null },
  ): Promise<{ namespaceUID: string }>;
  getPod(namespace: string, podName: string): Promise<RuntimePodObservation | null>;
  getNamespace(namespace: string): Promise<{ uid: string; labels: Record<string, string> } | null>;
  getPodLogs(namespace: string, podName: string): Promise<string>;
  readSecret(namespace: string, name: string, key: string): Promise<string>;
  deletePod(input: {
    namespace: string;
    podName: string;
    attemptID: string;
    generation: number;
    uid: string;
  }): Promise<void>;
  deleteNamespace(input: {
    namespace: string;
    podName: string;
    attemptID: string;
    generation: number;
    namespaceUID: string;
    uid: string | null;
    ownerID?: string;
  }): Promise<void>;
}

async function kubectl(arguments_: string[], input?: string) {
  const process = Bun.spawn(["kubectl", "--context", "orbstack", ...arguments_], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    const stdin = process.stdin;
    if (!stdin) throw new Error("kubectl stdin was not created");
    stdin.write(input);
    await stdin.flush();
    stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function createKubernetesClient(run: typeof kubectl = kubectl): KubernetesClient {
  return {
    async apply(resources, expectedNamespace) {
      const namespace = resources.find(
        (resource) =>
          typeof resource === "object" &&
          resource !== null &&
          "kind" in resource &&
          resource.kind === "Namespace",
      ) as { metadata?: { name?: string; labels?: Record<string, string> } } | undefined;
      const namespaceName = namespace?.metadata?.name;
      if (!namespace || !namespaceName) throw new Error("Runtime resources have no Namespace");
      const observed = await run(["get", "namespace", namespaceName, "-o", "json"]);
      let namespaceUID: string;
      if (observed.exitCode === 0) {
        const current = JSON.parse(observed.stdout) as {
          metadata?: { uid?: string; labels?: Record<string, string> };
        };
        if (
          !expectedNamespace?.uid ||
          current.metadata?.uid !== expectedNamespace.uid ||
          current.metadata.labels?.["factory.dev/runtime-owner"] !== expectedNamespace.ownerID ||
          current.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
        )
          throw new Error(`Refusing to adopt existing namespace ${namespaceName}`);
        namespaceUID = current.metadata.uid;
      } else {
        if (!observed.stderr.includes("NotFound") && !observed.stderr.includes("not found")) {
          throw new Error(`Observe runtime Namespace before create: ${observed.stderr}`);
        }
        const created = await run(["create", "-f", "-", "-o", "json"], JSON.stringify(namespace));
        if (created.exitCode !== 0)
          throw new Error(`Kubernetes Namespace create failed: ${created.stderr}`);
        const current = JSON.parse(created.stdout) as { metadata?: { uid?: string } };
        if (!current.metadata?.uid) throw new Error("Created Namespace has no UID");
        namespaceUID = current.metadata.uid;
      }
      const items = resources.filter((candidate) => candidate !== namespace);
      if (items.length) {
        const result = await run(
          ["apply", "--server-side", "--field-manager", "open-software-factory", "-f", "-"],
          JSON.stringify({ apiVersion: "v1", kind: "List", items }),
        );
        if (result.exitCode !== 0) throw new Error(`Kubernetes apply failed: ${result.stderr}`);
      }
      return { namespaceUID };
    },
    async getPod(namespace, podName) {
      const result = await run(["get", "pod", podName, "-n", namespace, "-o", "json"]);
      if (result.exitCode !== 0) {
        if (result.stderr.includes("NotFound") || result.stderr.includes("not found")) return null;
        throw new Error(`Kubernetes observation failed: ${result.stderr}`);
      }
      const pod = JSON.parse(result.stdout) as {
        metadata?: { uid?: string; labels?: Record<string, string> };
        status?: { phase?: string };
        spec?: {
          containers?: Array<{
            name: string;
            image: string;
            env?: Array<{ name: string; value?: string }>;
          }>;
        };
      };
      if (!pod.metadata?.uid) throw new Error("Kubernetes Pod has no UID");
      const envbox = pod.spec?.containers?.find((container) => container.name === "envbox");
      const innerImage = envbox?.env?.find(
        (variable) => variable.name === "CODER_INNER_IMAGE",
      )?.value;
      if (!envbox?.image || !innerImage)
        throw new Error("Runtime Pod has no declared Envbox artifacts");
      return {
        uid: pod.metadata.uid,
        phase: pod.status?.phase ?? "Unknown",
        labels: pod.metadata.labels ?? {},
        envboxImage: envbox.image,
        runtimeHostImage: innerImage,
      };
    },
    async getNamespace(namespace) {
      const result = await run(["get", "namespace", namespace, "-o", "json"]);
      if (result.exitCode !== 0) {
        if (result.stderr.includes("NotFound") || result.stderr.includes("not found")) return null;
        throw new Error(`Kubernetes namespace observation failed: ${result.stderr}`);
      }
      const observed = JSON.parse(result.stdout) as {
        metadata?: { uid?: string; labels?: Record<string, string> };
      };
      if (!observed.metadata?.uid) throw new Error("Kubernetes Namespace has no UID");
      return { uid: observed.metadata.uid, labels: observed.metadata.labels ?? {} };
    },
    async getPodLogs(namespace, podName) {
      const result = await run(["logs", podName, "-n", namespace, "--tail=120"]);
      if (result.exitCode !== 0) return "";
      return result.stdout.trim();
    },
    async readSecret(namespace, name, key) {
      const result = await run(["get", "secret", name, "-n", namespace, "-o", "json"]);
      if (result.exitCode !== 0) throw new Error(`Read runtime Secret: ${result.stderr}`);
      const secret = JSON.parse(result.stdout) as { data?: Record<string, string> };
      const value = secret.data?.[key];
      if (!value) throw new Error(`Runtime Secret has no ${key}`);
      return Buffer.from(value, "base64").toString();
    },
    async deletePod(input) {
      const observed = await this.getPod(input.namespace, input.podName);
      if (!observed || observed.uid !== input.uid)
        throw new Error("Refusing to replace a runtime Pod whose UID changed");
      const inspected = await run([
        "get",
        "pod",
        input.podName,
        "-n",
        input.namespace,
        "-o",
        "json",
      ]);
      const pod = JSON.parse(inspected.stdout) as {
        metadata?: { labels?: Record<string, string> };
      };
      if (
        pod.metadata?.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
        pod.metadata.labels?.["factory.dev/runtime-attempt"] !== input.attemptID ||
        pod.metadata.labels?.["factory.dev/runtime-generation"] !== String(input.generation)
      )
        throw new Error("Refusing to replace a Pod without Factory ownership labels");
      const result = await run(
        [
          "delete",
          "--raw",
          `/api/v1/namespaces/${input.namespace}/pods/${input.podName}`,
          "-f",
          "-",
        ],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          gracePeriodSeconds: 0,
          preconditions: { uid: input.uid },
        }),
      );
      if (result.exitCode !== 0)
        throw new Error(`Delete failed runtime Pod ${input.uid}: ${result.stderr}`);
      for (let observation = 0; observation < 180; observation += 1) {
        const current = await this.getPod(input.namespace, input.podName);
        if (!current) return;
        if (current.uid !== input.uid)
          throw new Error("Runtime Pod identity changed while deletion was pending");
        await Bun.sleep(1_000);
      }
      throw new Error(`Runtime Pod ${input.uid} remained after deletion`);
    },
    async deleteNamespace(input) {
      const namespaceResult = await run(["get", "namespace", input.namespace, "-o", "json"]);
      if (namespaceResult.exitCode !== 0) {
        if (
          namespaceResult.stderr.includes("NotFound") ||
          namespaceResult.stderr.includes("not found")
        )
          return;
        throw new Error(`Observe namespace before deletion: ${namespaceResult.stderr}`);
      }
      const observedNamespace = JSON.parse(namespaceResult.stdout) as {
        metadata?: { uid?: string; labels?: Record<string, string> };
      };
      if (
        observedNamespace.metadata?.uid !== input.namespaceUID ||
        observedNamespace.metadata?.labels?.["app.kubernetes.io/managed-by"] !==
          "open-software-factory" ||
        observedNamespace.metadata.labels?.["factory.dev/runtime-owner"] !==
          (input.ownerID ?? input.attemptID)
      )
        throw new Error("Refusing to delete a namespace whose Factory ownership changed");
      const observed = await run([
        "get",
        "pod",
        input.podName,
        "-n",
        input.namespace,
        "-o",
        "json",
      ]);
      if (observed.exitCode === 0) {
        const pod = JSON.parse(observed.stdout) as {
          metadata?: { uid?: string; labels?: Record<string, string> };
        };
        if (
          !input.uid ||
          pod.metadata?.uid !== input.uid ||
          pod.metadata.labels?.["factory.dev/runtime-attempt"] !== input.attemptID ||
          pod.metadata.labels?.["factory.dev/runtime-generation"] !== String(input.generation) ||
          pod.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
        )
          throw new Error("Refusing to delete a runtime whose Pod identity or ownership changed");
        await this.deletePod({
          namespace: input.namespace,
          podName: input.podName,
          attemptID: input.attemptID,
          generation: input.generation,
          uid: input.uid,
        });
      } else if (!observed.stderr.includes("NotFound") && !observed.stderr.includes("not found")) {
        throw new Error(`Observe runtime before deletion: ${observed.stderr}`);
      }
      for (const resource of [
        { plural: "persistentvolumeclaims", name: "runtime-data" },
        { plural: "secrets", name: "runtime-assignment" },
        { plural: "secrets", name: "registry-ca" },
      ]) {
        const inspected = await run([
          "get",
          resource.plural,
          resource.name,
          "-n",
          input.namespace,
          "-o",
          "json",
        ]);
        if (inspected.exitCode !== 0) {
          if (inspected.stderr.includes("NotFound") || inspected.stderr.includes("not found"))
            continue;
          throw new Error(`Observe runtime resource before deletion: ${inspected.stderr}`);
        }
        const value = JSON.parse(inspected.stdout) as {
          metadata?: { uid?: string; labels?: Record<string, string> };
        };
        if (
          !value.metadata?.uid ||
          value.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
          value.metadata.labels?.["factory.dev/runtime-attempt"] !== input.attemptID ||
          value.metadata.labels?.["factory.dev/runtime-generation"] !== String(input.generation)
        )
          throw new Error("Refusing to delete a runtime resource whose ownership changed");
        const deleted = await run(
          [
            "delete",
            "--raw",
            `/api/v1/namespaces/${input.namespace}/${resource.plural}/${resource.name}`,
            "-f",
            "-",
          ],
          JSON.stringify({
            apiVersion: "v1",
            kind: "DeleteOptions",
            preconditions: { uid: value.metadata.uid },
          }),
        );
        if (deleted.exitCode !== 0)
          throw new Error(`Delete failed runtime resource ${resource.name}: ${deleted.stderr}`);
        for (let observation = 0; observation < 60; observation += 1) {
          const current = await run([
            "get",
            resource.plural,
            resource.name,
            "-n",
            input.namespace,
            "-o",
            "name",
          ]);
          if (
            current.exitCode !== 0 &&
            (current.stderr.includes("NotFound") || current.stderr.includes("not found"))
          )
            break;
          if (observation === 59)
            throw new Error(`Runtime resource ${resource.name} remained after deletion`);
          await Bun.sleep(1_000);
        }
      }
      const result = await run(
        ["delete", "--raw", `/api/v1/namespaces/${input.namespace}`, "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          propagationPolicy: "Foreground",
          preconditions: { uid: input.namespaceUID },
        }),
      );
      if (
        result.exitCode !== 0 &&
        !result.stderr.includes("NotFound") &&
        !result.stderr.includes("not found")
      ) {
        throw new Error(`Kubernetes namespace deletion failed: ${result.stderr}`);
      }
      let finalized = false;
      for (let observation = 0; observation < 60; observation += 1) {
        const current = await run(["get", "namespace", input.namespace, "-o", "json"]);
        if (
          current.exitCode !== 0 &&
          (current.stderr.includes("NotFound") || current.stderr.includes("not found"))
        ) {
          return;
        }
        if (current.exitCode !== 0)
          throw new Error(`Observe deleting runtime Namespace: ${current.stderr}`);
        if (observation >= 30 && !finalized) {
          const remaining = JSON.parse(current.stdout) as {
            metadata?: {
              name?: string;
              uid?: string;
              deletionTimestamp?: string;
              labels?: Record<string, string>;
            };
          };
          if (
            remaining.metadata?.name !== input.namespace ||
            remaining.metadata.uid !== input.namespaceUID ||
            !remaining.metadata.deletionTimestamp ||
            remaining.metadata.labels?.["app.kubernetes.io/managed-by"] !==
              "open-software-factory" ||
            remaining.metadata.labels?.["factory.dev/runtime-owner"] !==
              (input.ownerID ?? input.attemptID)
          )
            throw new Error("Refusing to finalize a runtime Namespace whose ownership changed");
          const finalize = await run(
            ["replace", "--raw", `/api/v1/namespaces/${input.namespace}/finalize`, "-f", "-"],
            JSON.stringify({
              apiVersion: "v1",
              kind: "Namespace",
              metadata: { name: input.namespace, uid: input.namespaceUID },
              spec: { finalizers: [] },
            }),
          );
          if (finalize.exitCode !== 0)
            throw new Error(`Finalize deleting runtime Namespace: ${finalize.stderr}`);
          finalized = true;
        }
        await Bun.sleep(1_000);
      }
      throw new Error(`Kubernetes namespace ${input.namespace} remained after deletion`);
    },
  };
}

export async function readSmokeRegistryCA() {
  const result = await kubectl([
    "get",
    "secret",
    "registry-tls",
    "-n",
    "open-factory-envbox-smoke",
    "-o",
    "jsonpath={.data.ca\\.crt}",
  ]);
  if (result.exitCode !== 0) throw new Error(`Read registry CA: ${result.stderr}`);
  return Buffer.from(result.stdout, "base64").toString();
}
