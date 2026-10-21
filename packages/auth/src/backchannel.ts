export function forgeBackchannelOrigin(value: string | undefined) {
  if (!value) return undefined;
  const url = new URL(value);
  const clusterService =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.svc$/;
  if (
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && clusterService.test(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Forge backchannel must be an HTTPS origin or a qualified Kubernetes Service");
  return url;
}

// Discovery transport and token endpoints are not the issuer identity. Public
// authorization and signed issuer claims remain unchanged in every deployment.
export function forgeBackchannelMetadata<
  T extends {
    token_endpoint?: string | undefined;
    userinfo_endpoint?: string | undefined;
    jwks_uri?: string | undefined;
  },
>(metadata: T, origin: URL | undefined): T {
  if (!origin) return metadata;
  const internal = (value: string) => new URL(new URL(value).pathname, origin).href;
  return {
    ...metadata,
    ...(metadata.token_endpoint ? { token_endpoint: internal(metadata.token_endpoint) } : {}),
    ...(metadata.userinfo_endpoint
      ? { userinfo_endpoint: internal(metadata.userinfo_endpoint) }
      : {}),
    ...(metadata.jwks_uri ? { jwks_uri: internal(metadata.jwks_uri) } : {}),
  };
}
