export function runtimeVolumeClaimSpec(
  size = "8Gi",
  env: Record<string, string | undefined> = process.env,
) {
  const storageClass = env["FACTORY_STORAGE_CLASS"] ?? "";
  if (
    storageClass &&
    (storageClass.length > 253 ||
      !storageClass.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))
  )
    throw new Error("Invalid Factory runtime StorageClass");
  return {
    accessModes: ["ReadWriteOnce"],
    ...(storageClass ? { storageClassName: storageClass } : {}),
    resources: { requests: { storage: size } },
  };
}
