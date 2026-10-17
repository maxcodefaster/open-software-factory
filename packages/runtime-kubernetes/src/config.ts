// One Kubernetes implementation in every environment. Selection belongs to the
// installation, never to a Project or a runtime recovery decision.
export function kubernetesCommand(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
) {
  const context = env["FACTORY_KUBERNETES_CONTEXT"] ?? (platform === "darwin" ? "orbstack" : "");
  if (context.includes("\0") || context.trim() !== context)
    throw new Error("Invalid Factory Kubernetes context");
  return ["kubectl", ...(context ? ["--context", context] : []), ...args];
}
