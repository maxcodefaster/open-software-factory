export const developmentSigningSecret = "local-development-secret-change-before-production";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function loopbackListener(environment: Record<string, string | undefined>) {
  let baseHost: string;
  try {
    baseHost = new URL(environment["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000").hostname;
  } catch {
    return false;
  }
  return (
    environment["NODE_ENV"] !== "production" &&
    loopbackHosts.has(baseHost) &&
    loopbackHosts.has(environment["FACTORY_HOST"] ?? "127.0.0.1")
  );
}

/**
 * The one place that decides which secret signs runtime capabilities, relay
 * tokens and webhook keys. The development constant only exists for a
 * loopback, non-production listener.
 */
export function factorySigningSecret(
  environment: Record<string, string | undefined> = process.env,
) {
  const configured = environment["FACTORY_AUTH_SECRET"];
  const development = loopbackListener(environment);
  if (configured && configured !== developmentSigningSecret) {
    if (!development && configured.length < 32)
      throw new Error("FACTORY_AUTH_SECRET must be at least 32 characters outside development");
    return configured;
  }
  if (development) return developmentSigningSecret;
  throw new Error(
    "Configure a unique FACTORY_AUTH_SECRET; the development secret is only valid on a loopback listener",
  );
}
