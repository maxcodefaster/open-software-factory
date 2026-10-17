export function requireLocalForgeIssuer(
  baseURL: string,
  issuerOverride: string | undefined,
  development: boolean,
  runtimeHost = "host.orb.internal",
) {
  const publicIssuer = `${baseURL.replace(/\/$/, "")}/api/auth`;
  const internalIssuer =
    issuerOverride && issuerOverride !== publicIssuer ? new URL(issuerOverride) : undefined;
  if (
    internalIssuer &&
    (!development ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname) ||
      internalIssuer.hostname !== runtimeHost ||
      internalIssuer.protocol !== "http:" ||
      internalIssuer.port !== new URL(baseURL).port ||
      internalIssuer.pathname !== "/api/auth" ||
      internalIssuer.username ||
      internalIssuer.password ||
      internalIssuer.search ||
      internalIssuer.hash)
  )
    throw new Error(
      "Internal Forge issuer override is limited to the exact local development listener",
    );
  return internalIssuer;
}
