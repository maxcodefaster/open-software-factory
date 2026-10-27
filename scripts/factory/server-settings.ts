import { isIP } from "node:net";

export function localForgeIdentityEndpoints(
  runtimeHost: string | undefined,
  port: number,
  retainedDiscovery?: string,
) {
  const discovery =
    retainedDiscovery ??
    `http://${runtimeHost || "host.orb.internal"}:${port}/api/auth/.well-known/openid-configuration`;
  const url = new URL(discovery);
  if (
    url.protocol !== "http:" ||
    url.port !== String(port) ||
    url.pathname !== "/api/auth/.well-known/openid-configuration" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Saved Forge identity does not match the local Factory listener");
  url.pathname = "/api/auth";
  return { issuer: url.href, discovery, host: url.hostname };
}

export function localServerSettings(
  environment: Record<string, string | undefined>,
  defaults: { email: string; password: string },
) {
  // Pods reach the host listener through OrbStack. A supplied narrower listener
  // is intentional and must not be silently widened by the launcher.
  const host = environment["FACTORY_HOST"] ?? "0.0.0.0";
  const email = environment["FACTORY_ADMIN_EMAIL"] ?? defaults.email;
  const password = environment["FACTORY_ADMIN_PASSWORD"] ?? defaults.password;
  const executionReserveTarget = environment["FACTORY_EXECUTION_RESERVE_TARGET"] ?? "2";
  if ((!isIP(host) && host !== "localhost") || !email.trim() || !password)
    throw new Error("Invalid Factory listener or administrator bootstrap configuration");
  return { host, email, password, executionReserveTarget };
}
