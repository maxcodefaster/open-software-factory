import { isIP } from "node:net";

export function localServerSettings(
  environment: Record<string, string | undefined>,
  defaults: { email: string; password: string },
) {
  // Pods reach the host listener through OrbStack. A supplied narrower listener
  // is intentional and must not be silently widened by the launcher.
  const host = environment["FACTORY_HOST"] ?? "0.0.0.0";
  const email = environment["FACTORY_ADMIN_EMAIL"] ?? defaults.email;
  const password = environment["FACTORY_ADMIN_PASSWORD"] ?? defaults.password;
  const executionReserveTarget = environment["FACTORY_EXECUTION_RESERVE_TARGET"] ?? "0";
  if ((!isIP(host) && host !== "localhost") || !email.trim() || !password)
    throw new Error("Invalid Factory listener or administrator bootstrap configuration");
  return { host, email, password, executionReserveTarget };
}
