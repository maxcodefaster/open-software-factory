import { expect } from "@playwright/test";
import { spawn } from "node:child_process";

async function kubectl(args: string[], input?: unknown) {
  const child = spawn("kubectl", ["--context", "orbstack", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    error += chunk.toString();
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    if (error.includes("NotFound")) return null;
    throw new Error("Owned fixture namespace command failed");
  }
  return output;
}

export async function fixtureNamespace(name: string, ownerID: string) {
  const raw = await kubectl(["get", "namespace", name, "-o", "json"]);
  if (!raw) return null;
  const namespace = JSON.parse(raw) as {
    metadata: { uid: string; labels: Record<string, string> };
  };
  if (
    namespace.metadata.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
    namespace.metadata.labels["factory.dev/runtime-owner"] !== ownerID
  )
    throw new Error("Fixture namespace ownership changed");
  return { name, ownerID, uid: namespace.metadata.uid };
}

export async function removeFixtureNamespace(
  expected: NonNullable<Awaited<ReturnType<typeof fixtureNamespace>>>,
) {
  const observed = await fixtureNamespace(expected.name, expected.ownerID);
  if (!observed) return;
  if (observed.uid !== expected.uid) throw new Error("Fixture namespace was replaced");
  const raw = await kubectl(["get", "pods,pvc,secrets", "-n", expected.name, "-o", "json"]);
  const resources = JSON.parse(raw ?? '{"items":[]}') as {
    items: Array<{
      kind: string;
      metadata: { name: string; uid: string; labels?: Record<string, string> };
      status?: { phase?: string };
    }>;
  };
  for (const resource of resources.items) {
    if (
      resource.metadata.labels?.["factory.dev/runtime-owner"] !== expected.ownerID ||
      resource.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
    )
      throw new Error("Foreign resource in fixture namespace");
    if (resource.kind === "Pod" && !["Failed", "Succeeded"].includes(resource.status?.phase ?? ""))
      throw new Error("Stop the fixture's running services before removing its namespace");
  }
  for (const resource of resources.items.filter((resource) => resource.kind === "Pod")) {
    await kubectl(
      [
        "delete",
        "--raw",
        `/api/v1/namespaces/${expected.name}/pods/${resource.metadata.name}`,
        "-f",
        "-",
      ],
      {
        apiVersion: "v1",
        kind: "DeleteOptions",
        gracePeriodSeconds: 0,
        preconditions: { uid: resource.metadata.uid },
      },
    );
  }
  // Remove proven stopped storage before deleting its namespace, so PVC protection can settle.
  if (resources.items.some((resource) => resource.kind === "PersistentVolumeClaim")) {
    await kubectl([
      "delete",
      "pvc",
      "runtime-data",
      "-n",
      expected.name,
      "--wait=true",
      "--timeout=60s",
    ]);
  }
  await kubectl(["delete", "--raw", `/api/v1/namespaces/${expected.name}`, "-f", "-"], {
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: expected.uid },
  });
  await expect
    .poll(async () => !(await fixtureNamespace(expected.name, expected.ownerID)), {
      timeout: 180_000,
    })
    .toBe(true);
}
