import { z } from "zod";

const identity = z.object({
  name: z.string(),
  uid: z.string().min(1),
  labels: z.record(z.string(), z.string()).optional(),
});
const deployment = z.object({
  metadata: identity,
  spec: z.object({
    template: z.object({
      spec: z.object({
        volumes: z.array(
          z.object({
            name: z.string(),
            persistentVolumeClaim: z.object({ claimName: z.string() }).optional(),
          }),
        ),
      }),
    }),
  }),
});
const claim = z.object({ metadata: identity });

// Publication must never replace a live temporary Registry with an empty PVC.
// Existing data must be preserved explicitly before adopting this layout.
export function requireSafeRegistryStorage(current: unknown, existingClaim: unknown) {
  if (existingClaim !== null) {
    const value = claim.parse(existingClaim);
    if (
      value.metadata.name !== "registry-data" ||
      value.metadata.labels?.["app.kubernetes.io/name"] !== "open-factory-registry" ||
      value.metadata.labels?.["app.kubernetes.io/managed-by"] !== "open-software-factory"
    )
      throw new Error("Refusing to adopt a foreign Registry storage claim");
  }
  if (current === null) return;
  const value = deployment.parse(current);
  if (
    value.metadata.name !== "registry" ||
    value.metadata.labels?.["app.kubernetes.io/name"] !== "open-factory-registry"
  )
    throw new Error("Refusing to change a foreign Registry Deployment");
  const data = value.spec.template.spec.volumes.find((volume) => volume.name === "data");
  if (data?.persistentVolumeClaim?.claimName !== "registry-data")
    throw new Error(
      "Registry uses temporary storage. Preserve its existing data on registry-data before publication; the Registry has not been restarted.",
    );
  if (existingClaim === null)
    throw new Error(
      "Registry storage claim is missing. Restore retained storage before publication.",
    );
}
