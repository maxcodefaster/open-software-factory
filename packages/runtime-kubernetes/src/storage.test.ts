import { expect, test } from "bun:test";
import { runtimeVolumeClaimSpec } from "./storage";

test("runtime and installed-service volumes can use the same explicit StorageClass", () => {
  expect(runtimeVolumeClaimSpec("8Gi", {})).toEqual({
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "8Gi" } },
  });
  expect(runtimeVolumeClaimSpec("8Gi", { FACTORY_STORAGE_CLASS: "managed-csi" })).toEqual({
    accessModes: ["ReadWriteOnce"],
    storageClassName: "managed-csi",
    resources: { requests: { storage: "8Gi" } },
  });
  for (const storageClass of ["-bad", "bad class", "bad/name", "bad..name", "x".repeat(64)])
    expect(() => runtimeVolumeClaimSpec("8Gi", { FACTORY_STORAGE_CLASS: storageClass })).toThrow();
});
