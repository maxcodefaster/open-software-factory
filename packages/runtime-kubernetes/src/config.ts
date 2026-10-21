// One Kubernetes implementation in every environment. Selection belongs to the
// installation, never to a Project or a runtime recovery decision.
export function kubernetesCommand(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
) {
  const context = env["FACTORY_KUBERNETES_CONTEXT"] ?? "";
  if (context.includes("\0") || context.trim() !== context)
    throw new Error("Invalid Factory Kubernetes context");
  return ["kubectl", ...(context ? ["--context", context] : []), ...args];
}

export function kubernetesConnectionEnvironment(
  env: Record<string, string | undefined> = process.env,
) {
  // kubectl's in-cluster authentication needs both the projected ServiceAccount
  // files and these service coordinates. Never pass the application's secrets.
  return {
    PATH: env["PATH"],
    HOME: env["HOME"],
    KUBECONFIG: env["KUBECONFIG"],
    FACTORY_KUBERNETES_CONTEXT: env["FACTORY_KUBERNETES_CONTEXT"],
    KUBERNETES_SERVICE_HOST: env["KUBERNETES_SERVICE_HOST"],
    KUBERNETES_SERVICE_PORT: env["KUBERNETES_SERVICE_PORT"],
  };
}

export function runtimeNodeSelector(storageNode?: string) {
  return {
    "kubernetes.io/os": "linux",
    ...(storageNode ? { "kubernetes.io/hostname": storageNode } : {}),
  };
}
