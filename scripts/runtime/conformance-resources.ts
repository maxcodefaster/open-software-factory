import { parseAllDocuments } from "yaml";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";

export const conformanceNamespace = "open-factory-envbox-smoke";
export const conformanceLabel = "factory.dev/conformance-owner";
const identity = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function conformanceManifest(template: string, owner: string, image: string) {
  if (!identity.test(owner)) throw new Error("Invalid conformance owner");
  const name = `conformance-${owner}`;
  return parseAllDocuments(template.replaceAll("FACTORY_RUNTIME_HOST_IMAGE", image))
    .map((document) => document.toJSON())
    .filter((document) => document.kind !== "Namespace")
    .map((document) => {
      document.metadata.name = name;
      document.metadata.labels[conformanceLabel] = owner;
      if (document.kind === "Pod") {
        document.spec.volumes.find(
          (volume: { name: string }) => volume.name === "runtime-data",
        ).persistentVolumeClaim.claimName = name;
      }
      return document;
    });
}

export function ownedConformanceResource(
  resource: { metadata?: { name?: string; uid?: string; labels?: Record<string, string> } },
  owner: string,
) {
  if (
    !identity.test(owner) ||
    resource.metadata?.name !== `conformance-${owner}` ||
    resource.metadata.labels?.[conformanceLabel] !== owner ||
    !resource.metadata.uid
  )
    throw new Error("Conformance cleanup ownership mismatch");
  return { name: resource.metadata.name, uid: resource.metadata.uid };
}

async function kube(args: string[], input?: string) {
  const result = await runCommand(
    ["kubectl", "--context", "orbstack", "--request-timeout=10s", ...args],
    input,
  );
  if (result.exitCode !== 0)
    throw new Error(`Conformance resource command failed: ${result.stderr}`);
  return result.stdout;
}

// UID preconditions also fence a replacement between observation and deletion.
export async function removeConformanceResource(
  kind: "pods" | "persistentvolumeclaims",
  owner: string,
) {
  if (!identity.test(owner)) throw new Error("Invalid conformance owner");
  const observed = await kube([
    "get",
    kind,
    `conformance-${owner}`,
    "-n",
    conformanceNamespace,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  if (!observed.trim()) return;
  const resource = ownedConformanceResource(JSON.parse(observed), owner);
  await kube(
    [
      "delete",
      "--raw",
      `/api/v1/namespaces/${conformanceNamespace}/${kind}/${resource.name}`,
      "-f",
      "-",
    ],
    JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: resource.uid },
      gracePeriodSeconds: 1,
    }),
  );
}

if (import.meta.main) {
  const resources = JSON.parse(
    await kube([
      "get",
      "pods,persistentvolumeclaims",
      "-n",
      conformanceNamespace,
      "-l",
      conformanceLabel,
      "-o",
      "json",
    ]),
  );
  for (const resource of resources.items) {
    const owner = resource.metadata.labels[conformanceLabel];
    ownedConformanceResource(resource, owner);
    await removeConformanceResource(
      resource.kind === "Pod" ? "pods" : "persistentvolumeclaims",
      owner,
    );
  }
}
