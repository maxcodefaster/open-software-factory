import { createHash, createHmac } from "node:crypto";

export function runtimeIdentity(projectID: string, generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Generation must be positive");
  const digest = createHash("sha256").update(`${projectID}:${generation}`).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  const suffix = hex.slice(0, 12);
  return {
    attemptID: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
    namespace: `factory-runtime-${suffix}`,
    podName: `runtime-${generation}`,
    composeProjectName: "project_devcontainer",
  };
}

export function hashConnectorToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function runtimeConnectorTokens(secret: string, attemptID: string, generation: number) {
  if (!secret) throw new Error("Runtime connector secret is required");
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Generation must be positive");
  const derive = (role: "parent" | "child") =>
    createHmac("sha256", secret)
      .update(`factory-runtime-connector-v1:${attemptID}:${generation}:${role}`)
      .digest("base64url");
  return { parent: derive("parent"), child: derive("child") };
}

export function runtimeModelToken(secret: string, attemptID: string, generation: number) {
  if (!secret) throw new Error("Runtime connector secret is required");
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Generation must be positive");
  return createHmac("sha256", secret)
    .update(`factory-model-relay-v1:${attemptID}:${generation}`)
    .digest("base64url");
}

export function runtimeBuildBrowserToken(secret: string, attemptID: string, generation: number) {
  if (!secret) throw new Error("Runtime connector secret is required");
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Generation must be positive");
  return createHmac("sha256", secret)
    .update(`factory-build-browser-runtime-v1:${attemptID}:${generation}`)
    .digest("base64url");
}
