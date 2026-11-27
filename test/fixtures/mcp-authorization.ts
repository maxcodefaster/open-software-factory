import type { OAuthClientProvider, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { factoryMCPResource } from "#auth/mcp-registration";

const callback = "http://127.0.0.1:39999/owned-mcp-callback";

// The SDK owns discovery, refresh and its authenticated retry. Keep only the
// already approved fixture registration/tokens here; never silently re-consent.
export function ownedMCPAuthProvider(grant: {
  clientID: string;
  accessToken: string;
  refreshToken: string;
  issuer: string;
}): OAuthClientProvider {
  let tokens: StoredOAuthTokens = {
    access_token: grant.accessToken,
    refresh_token: grant.refreshToken,
    token_type: "Bearer",
    issuer: grant.issuer,
  };
  const explicitAuthorization = () => {
    throw new Error("Owned MCP authorization needs a new explicit consent");
  };
  return {
    redirectUrl: callback,
    clientMetadata: {
      client_name: "Owned MCP proof",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    },
    clientInformation: () => ({
      client_id: grant.clientID,
      token_endpoint_auth_method: "none",
      issuer: grant.issuer,
    }),
    tokens: () => tokens,
    saveTokens: (next) => {
      tokens = next;
    },
    redirectToAuthorization: explicitAuthorization,
    saveCodeVerifier: explicitAuthorization,
    codeVerifier: explicitAuthorization,
  };
}

/** An explicit OAuth grant in a separately owned installation, never a copied personal login. */
export async function ownedMCPAuthorization(base: string, cookie: string, work = true) {
  const discovery = await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`);
  if (!discovery.ok) throw new Error(`Owned MCP issuer discovery failed: ${discovery.status}`);
  const { issuer } = (await discovery.json()) as { issuer?: unknown };
  if (typeof issuer !== "string" || issuer !== `${base.replace(/\/$/, "")}/api/auth`)
    throw new Error("Owned MCP issuer differs from this Factory");
  const registration = await fetch(`${base}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Owned MCP proof",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registration.status !== 201)
    throw new Error(`Owned MCP registration failed: ${registration.status}`);
  const registered = (await registration.json()) as { client_id: string };
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const scope = work ? "factory:read factory:work offline_access" : "factory:read offline_access";
  const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
  for (const [name, value] of Object.entries({
    client_id: registered.client_id,
    redirect_uri: callback,
    response_type: "code",
    scope,
    resource: factoryMCPResource(base),
    state: crypto.randomUUID(),
    code_challenge_method: "S256",
    code_challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
  }))
    authorize.searchParams.set(name, value);
  const prompted = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
  if (prompted.status !== 302)
    throw new Error(`Owned OAuth consent prompt failed: ${prompted.status}`);
  const consent = new URL(prompted.headers.get("location") ?? "", base);
  if (consent.origin !== base || !consent.searchParams.has("sig"))
    throw new Error("Owned consent did not target Factory");
  const approved = await fetch(`${base}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ accept: true, scope, oauth_query: consent.search.slice(1) }),
  });
  if (!approved.ok) throw new Error(`Explicit owned OAuth consent failed: ${approved.status}`);
  const result = (await approved.json()) as { url: string };
  const code = new URL(result.url).searchParams.get("code");
  if (!code) throw new Error("Owned OAuth grant has no code");
  const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registered.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: factoryMCPResource(base),
    }),
  });
  if (!exchanged.ok) throw new Error(`Owned OAuth exchange failed: ${exchanged.status}`);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  return {
    clientID: registered.client_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    issuer,
  };
}
