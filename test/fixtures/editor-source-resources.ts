import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { eventually } from "./factory-process";
import type { createDatabase } from "../../packages/db/src/client";
import { developerIDEIdentity } from "../../packages/workspace-domain/src/developer-ide";

export async function recordedEditorIdentity(
  database: ReturnType<typeof createDatabase>,
  userID: string,
) {
  const [editor] = await database.client<Array<{ resourceID: string; epoch: string }>>`
    SELECT resource_id AS "resourceID",service_epoch::text AS epoch
    FROM factory.developer_ide WHERE user_id=${userID}`;
  if (!editor) return undefined;
  return developerIDEIdentity(userID, Number(editor.epoch), editor.resourceID);
}

export async function removeOwnedProjectSources(
  database: ReturnType<typeof createDatabase>,
  projectID: string,
  stop: (workspaceID: string) => Promise<unknown>,
) {
  const sources = await database.client<
    Array<{
      id: string;
      state: string;
      namespace: string;
      namespaceUID: string | null;
    }>
  >`
    SELECT workspace.id,source.state,workspace.kubernetes_namespace AS namespace,
      source.namespace_uid AS "namespaceUID"
    FROM factory.development_workspace workspace JOIN factory.workspace_source source ON source.workspace_id=workspace.id
    WHERE workspace.project_id=${projectID}`;
  for (const source of sources) {
    if (source.state !== "stopped") {
      await stop(source.id);
      await eventually(
        async () => {
          const [current] = await database.client<Array<{ state: string }>>`
            SELECT state FROM factory.workspace_source WHERE workspace_id=${source.id}`;
          return current?.state;
        },
        (state) => state === "stopped",
        "Owned Project source did not Stop",
        40_000,
      );
    }
    if (source.namespaceUID)
      await removeEditorFixtureNamespaceInChild(source.namespace, {
        ownerID: source.id,
        uid: source.namespaceUID,
      });
  }
}

export async function editorFixtureKubectl(args: string[], input?: unknown, timeout = 30_000) {
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000)
    throw new Error("Owned fixture command timeout is outside its bound");
  const child = spawn("kubectl", ["--context", "orbstack", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
  });
  const result = new Promise<string>((resolve, reject) => {
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 4 << 20) {
        child.kill("SIGKILL");
        reject(new Error("Owned editor fixture output exceeded its bound"));
      }
    });
    child.stderr.on("data", (chunk) => {
      error = `${error}${String(chunk)}`.slice(-2_000);
    });
    child.on("error", () => reject(new Error("Owned editor fixture command could not start")));
    child.on("close", (status) => {
      if (status === 0) resolve(output);
      else reject(new Error(`Owned editor fixture ${args[0]} failed: ${error.slice(0, 500)}`));
    });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return result;
}

export async function editorFixtureNamespaces() {
  return (
    z
      .object({
        items: z.array(
          z.object({
            metadata: z.object({
              name: z.string(),
              uid: z.string(),
              labels: z.record(z.string(), z.string()).default({}),
            }),
          }),
        ),
      })
      .parse(JSON.parse(await editorFixtureKubectl(["get", "namespaces", "-o", "json"])))
      // Unassigned reserve expiry is independent of this fixture. Used slots and all source/runtime
      // Namespaces still participate; reserve proofs separately verify exact slot cleanup.
      .items.filter(({ metadata }) => {
        const slot = metadata.labels["factory.dev/execution-slot"];
        return !(
          slot &&
          metadata.labels["app.kubernetes.io/managed-by"] === "open-software-factory" &&
          metadata.labels["factory.dev/runtime-owner"] === slot &&
          metadata.labels["factory.dev/runtime-attempt"] === slot &&
          metadata.labels["factory.dev/runtime-generation"] === "0" &&
          metadata.name === `factory-reserve-${slot.replaceAll("-", "").slice(0, 12)}`
        );
      })
      .map(({ metadata }) => ({ name: metadata.name, uid: metadata.uid }))
  );
}

export function finishedPrebuildNamespace(
  namespace: { name: string; uid: string },
  producer: {
    id: string;
    namespace: string;
    uid: string | null;
    kind: string | null;
    state: string;
    jobState: string;
  },
) {
  return (
    producer.kind === "prebuild" &&
    (producer.state === "stopped" || producer.state === "failed") &&
    (producer.jobState === "succeeded" || producer.jobState === "failed") &&
    producer.namespace === `factory-runtime-${producer.id.replaceAll("-", "").slice(0, 12)}` &&
    producer.namespace === namespace.name &&
    producer.uid === namespace.uid
  );
}

// Keep fixture teardown outside the browser driver's process. The child retains
// the same ownership/UID checks and reports completion only after observing absence.
export async function removeEditorFixtureNamespaceInChild(
  namespace: string,
  ownership: { ownerID: string; uid?: string },
) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("test/fixtures/editor-source-cleanup.ts"),
      JSON.stringify({ namespace, ...ownership }),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const [output, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  if (status !== 0 || output.length > 8_192)
    throw new Error("Owned source cleanup child did not confirm removal");
  z.object({ removed: z.literal(true) })
    .strict()
    .parse(JSON.parse(output));
}

async function editorFixtureNamespace(name: string) {
  try {
    return z
      .object({
        metadata: z.object({
          uid: z.string(),
          labels: z.record(z.string(), z.string()).default({}),
        }),
      })
      .parse(JSON.parse(await editorFixtureKubectl(["get", "namespace", name, "-o", "json"])))
      .metadata;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("NotFound")) return null;
    throw cause;
  }
}

function requireOwned(
  current: { uid: string; labels: Record<string, string> },
  ownership: { ownerID: string; uid?: string },
) {
  if (
    current.labels["factory.dev/runtime-owner"] !== ownership.ownerID ||
    current.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    (ownership.uid && current.uid !== ownership.uid)
  )
    throw new Error("Refusing unowned editor/source fixture cleanup");
}

export async function removeStoppedEditorSourceNamespace(
  name: string,
  ownership: { ownerID: string; uid?: string },
) {
  const current = await editorFixtureNamespace(name);
  if (!current) return;
  requireOwned(current, ownership);
  const listing = z.object({
    items: z.array(
      z.object({
        kind: z.string(),
        metadata: z.object({
          name: z.string(),
          uid: z.string(),
          labels: z.record(z.string(), z.string()).default({}),
        }),
      }),
    ),
  });
  const pods = listing.parse(
    JSON.parse(await editorFixtureKubectl(["get", "pods", "-n", name, "-o", "json"])),
  );
  if (pods.items.length) throw new Error("Stop owned editor/source Pods before removing storage");
  const claims = listing.parse(
    JSON.parse(await editorFixtureKubectl(["get", "pvc", "-n", name, "-o", "json"])),
  );
  for (const claim of claims.items) {
    requireOwned(claim.metadata, { ownerID: ownership.ownerID });
    if (claim.metadata.name !== "runtime-data") throw new Error("Unexpected owned source claim");
    await editorFixtureKubectl(
      [
        "delete",
        "--raw",
        `/api/v1/namespaces/${name}/persistentvolumeclaims/runtime-data`,
        "-f",
        "-",
      ],
      { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: claim.metadata.uid } },
    );
  }
  const secrets = listing.parse(
    JSON.parse(await editorFixtureKubectl(["get", "secrets", "-n", name, "-o", "json"])),
  );
  for (const secret of secrets.items) {
    requireOwned(secret.metadata, { ownerID: ownership.ownerID });
    if (!/^(runtime-assignment|registry-ca|source-access-[1-9][0-9]*)$/.test(secret.metadata.name))
      throw new Error("Unexpected owned source/runtime fixture secret");
    await editorFixtureKubectl(
      ["delete", "--raw", `/api/v1/namespaces/${name}/secrets/${secret.metadata.name}`, "-f", "-"],
      {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: secret.metadata.uid },
      },
    );
  }
  await editorFixtureKubectl(["delete", "--raw", `/api/v1/namespaces/${name}`, "-f", "-"], {
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Foreground",
    preconditions: { uid: current.uid },
  });
  await eventually(
    () => editorFixtureNamespace(name),
    (value) => value === null,
    "Owned namespace remained",
    10_000,
  ).catch(async (cause: unknown) => {
    if (!(cause instanceof Error) || cause.message !== "Owned namespace remained") throw cause;
    const remaining = await editorFixtureNamespace(name);
    if (!remaining) return;
    requireOwned(remaining, { ...ownership, uid: current.uid });
    const resources = listing.parse(
      JSON.parse(
        await editorFixtureKubectl([
          "get",
          "all,pvc,secret,cm,serviceaccounts,networkpolicies",
          "-n",
          name,
          "-o",
          "json",
        ]),
      ),
    );
    for (const resource of resources.items) {
      const plural =
        resource.kind === "ConfigMap" && resource.metadata.name === "kube-root-ca.crt"
          ? "configmaps"
          : resource.kind === "ServiceAccount" && resource.metadata.name === "default"
            ? "serviceaccounts"
            : undefined;
      if (!plural) throw new Error("Owned namespace still contains resources; do not finalize");
      await editorFixtureKubectl(
        [
          "delete",
          "--raw",
          `/api/v1/namespaces/${name}/${plural}/${resource.metadata.name}`,
          "-f",
          "-",
        ],
        { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: resource.metadata.uid } },
      ).catch(async (error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("NotFound")) throw error;
      });
    }
    const empty = listing.parse(
      JSON.parse(
        await editorFixtureKubectl([
          "get",
          "all,pvc,secret,cm,serviceaccounts,networkpolicies",
          "-n",
          name,
          "-o",
          "json",
        ]),
      ),
    );
    if (empty.items.length)
      throw new Error("Owned namespace still contains resources; do not finalize");
    const observed = await editorFixtureNamespace(name);
    if (!observed) return;
    requireOwned(observed, { ...ownership, uid: current.uid });
    await editorFixtureKubectl(
      ["replace", "--raw", `/api/v1/namespaces/${name}/finalize`, "-f", "-"],
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name, uid: current.uid },
        spec: { finalizers: [] },
      },
    );
    await eventually(
      () => editorFixtureNamespace(name),
      (value) => value === null,
      "Empty owned namespace remained",
      10_000,
    );
  });
}
