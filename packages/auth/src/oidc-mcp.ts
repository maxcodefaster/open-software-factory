import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { APIError } from "better-auth";
import { and, eq, sql as expression } from "drizzle-orm";
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import { administrator, oauthClient, operation } from "#db/schema";
import type { AuthDatabase } from "./adapter-bridge";
import type { FactoryBetterAuth } from "./auth-instance";
import { forgeBackchannelMetadata } from "./backchannel";
import { forgeClientID, forgeClientSecret } from "./forge-issuer";
import { factoryMCPClientPrefix, factoryMCPResource, factoryMCPScopes } from "./mcp-registration";
import type { IdentityPolicy } from "./policy";

export type ForgeClientProvisionPhase = "create-intended" | "ready";

export const FORGE_CLIENT_TRANSITIONS: Record<
  ForgeClientProvisionPhase,
  readonly ForgeClientProvisionPhase[]
> = {
  "create-intended": ["ready"],
  ready: [],
};

export function canTransitionForgeClient(
  from: ForgeClientProvisionPhase,
  to: ForgeClientProvisionPhase,
): boolean {
  return FORGE_CLIENT_TRANSITIONS[from].includes(to);
}

export function createOidcMcpHelpers(deps: {
  database: AuthDatabase;
  auth: FactoryBetterAuth;
  policy: IdentityPolicy;
  baseURL: string;
  secret: string;
  internalIssuer: URL | undefined;
  backchannel: URL | undefined;
  getSession: (request: Request) => Promise<unknown | null>;
  requireFresh: (request: Request) => Promise<{ user: { id: string } }>;
}) {
  const {
    database,
    auth,
    policy,
    baseURL,
    secret,
    internalIssuer,
    backchannel,
    getSession,
    requireFresh,
  } = deps;
  const { client, db } = database;
  const resourceActions = oauthProviderResourceClient(auth).getActions();

  async function mcpConsentDetails(request: Request, query: string) {
    const session = await getSession(request);
    if (!session) throw new APIError("UNAUTHORIZED");
    const parameters = new URLSearchParams(query);
    const clientID = z
      .string()
      .startsWith(factoryMCPClientPrefix)
      .parse(parameters.get("client_id"));
    const [registered] = await db
      .select({ name: oauthClient.name })
      .from(oauthClient)
      .where(
        and(
          eq(oauthClient.clientId, clientID),
          eq(oauthClient.disabled, false),
          eq(oauthClient.tokenEndpointAuthMethod, "none"),
        ),
      );
    if (!registered) throw new APIError("NOT_FOUND");
    return {
      clientID,
      name: registered.name ?? "MCP client",
      scopes:
        parameters
          .get("scope")
          ?.split(/\s+/)
          .filter((scope) => factoryMCPScopes.some((allowed) => allowed === scope)) ?? [],
    };
  }

  return {
    async mcpDiscovery() {
      const metadata = await auth.api.getOAuthServerConfig();
      return {
        ...metadata,
        registration_endpoint: `${baseURL}/api/auth/mcp/register`,
        scopes_supported: [...factoryMCPScopes],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      };
    },

    async mcpResourceMetadata() {
      return resourceActions.getProtectedResourceMetadata({
        resource: factoryMCPResource(baseURL),
        authorization_servers: [`${baseURL}/api/auth`],
        scopes_supported: ["factory:read", "factory:work"],
        bearer_methods_supported: ["header"],
        resource_name: "Factory workspaces",
      });
    },

    async mcpSession(request: Request) {
      if (policy.setupCommandID || policy.emergencyOnly) throw new APIError("UNAUTHORIZED");
      const payload = await resourceActions.verifyAccessTokenRequest(request, {
        // Fetch public keys over the installation's existing backchannel, without
        // changing the signed issuer, audience or request-bound token checks.
        ...(backchannel ? { jwksUrl: new URL("/api/auth/jwks", backchannel).href } : {}),
        verifyOptions: { audience: factoryMCPResource(baseURL) },
        requiredScopes: ["factory:read"],
      });
      const userID = z.uuid().parse(payload.sub);
      const sessionID = z.uuid().parse(payload["sid"]);
      const clientID = z.string().startsWith(factoryMCPClientPrefix).parse(payload["azp"]);
      const scopes = z.string().parse(payload["scope"]).split(/\s+/);
      const [session] = await client`SELECT session.id FROM auth.session session
        JOIN factory.account_access access ON access.user_id=session.user_id
        JOIN auth."oauthClient" oauth ON oauth."clientId"=${clientID}
        WHERE session.id=${sessionID} AND session.user_id=${userID} AND session.expires_at>now()
          AND session.login_method<>'identity-test'
          AND (session.login_method<>'sso' OR session.authenticated_at>now()-interval '24 hours')
          AND access.disabled_at IS NULL AND access.directory_disabled_at IS NULL AND NOT oauth.disabled
          AND oauth."tokenEndpointAuthMethod"='none'`;
      const [consent] = await client<{ scopes: string[] }[]>`SELECT scopes FROM auth."oauthConsent"
        WHERE "userId"=${userID} AND "clientId"=${clientID} AND scopes @> ARRAY['factory:read']::text[]`;
      if (!session || !consent)
        throw new APIError("UNAUTHORIZED", { message: "Factory MCP access was revoked" });
      return {
        userID,
        sessionID,
        clientID,
        scopes: scopes.filter((scope) => consent.scopes.includes(scope)),
      };
    },

    mcpConsentDetails,

    async mcpConsent(request: Request, query: string, accept: boolean, work: boolean) {
      await mcpConsentDetails(request, query);
      const requested = new URLSearchParams(query).get("scope")?.split(/\s+/) ?? [];
      const scope = requested
        .filter(
          (value) =>
            factoryMCPScopes.some((allowed) => allowed === value) &&
            (work || value !== "factory:work"),
        )
        .join(" ");
      const headers = new Headers(request.headers);
      headers.set("origin", new URL(baseURL).origin);
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json");
      const response = await auth.handler(
        new Request(`${baseURL}/api/auth/oauth2/consent`, {
          method: "POST",
          headers,
          body: JSON.stringify({ oauth_query: query, accept, scope }),
        }),
      );
      if (!response.ok)
        throw new APIError("BAD_REQUEST", { message: "OAuth consent was not accepted" });
      return z.object({ redirect: z.boolean(), url: z.url() }).parse(await response.json());
    },

    async discovery() {
      const native = await auth.api.getOpenIdConfig();
      if (!internalIssuer) return forgeBackchannelMetadata(native, backchannel);
      const internal = (url: string) => `${internalIssuer.origin}${new URL(url).pathname}`;
      // Browser authorization remains public. Native claims and server-to-server discovery
      // use the same issuer reached from local Docker, without disabling certificate checks.
      return {
        ...native,
        issuer: internalIssuer.href,
        token_endpoint: internal(native.token_endpoint),
        userinfo_endpoint: internal(native.userinfo_endpoint),
        ...(native.jwks_uri ? { jwks_uri: internal(native.jwks_uri) } : {}),
      };
    },

    async ensureForgeClient(headers: Headers, redirectURI: string) {
      const session = await requireFresh(new Request(baseURL, { headers }));
      const [manager] = await db
        .select({ userID: administrator.userId })
        .from(administrator)
        .where(eq(administrator.userId, session.user.id));
      if (!manager) throw new APIError("FORBIDDEN");
      const identityKey = `forge.identity:${forgeClientID}`;
      await client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-forgejo-client',0))`;
        const transaction = drizzleTransaction(sql);
        await transaction
          .insert(operation)
          .values({
            id: crypto.randomUUID(),
            kind: "forge.identity",
            scopeType: "installation",
            scopeId: forgeClientID,
            idempotencyKey: identityKey,
            state: "create-intended",
            payload: { redirectUri: redirectURI },
            createdBy: session.user.id,
          })
          .onConflictDoNothing({ target: operation.idempotencyKey });
        const [intent] = await transaction
          .select({ payload: operation.payload })
          .from(operation)
          .where(eq(operation.idempotencyKey, identityKey));
        if (intent?.payload["redirectUri"] !== redirectURI)
          throw new Error("Forgejo callback differs from its intended identity");
      });
      async function recordedClient() {
        const [previous] = await db
          .select({
            redirectUris: oauthClient.redirectUris,
            disabled: oauthClient.disabled,
            secret: oauthClient.clientSecret,
            pkce: oauthClient.requirePKCE,
            method: oauthClient.tokenEndpointAuthMethod,
          })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, forgeClientID));
        if (!previous) return false;
        const expected = new Bun.CryptoHasher("sha256")
          .update(forgeClientSecret(secret))
          .digest("base64url");
        if (
          previous.redirectUris.length !== 1 ||
          previous.redirectUris[0] !== redirectURI ||
          previous.disabled ||
          !previous.pkce ||
          previous.method !== "client_secret_basic" ||
          previous.secret !== expected
        )
          throw new Error("Forgejo callback or credential differs from its registered identity");
        return true;
      }
      if (!(await recordedClient())) {
        try {
          await auth.api.adminCreateOAuthClient({
            headers,
            body: {
              client_name: "Factory Forgejo",
              redirect_uris: [redirectURI],
              scope: "openid profile email",
              token_endpoint_auth_method: "client_secret_basic",
              grant_types: ["authorization_code"],
              response_types: ["code"],
              skip_consent: true,
              require_pkce: true,
              application_type: ["localhost", "127.0.0.1", "[::1]"].includes(
                new URL(redirectURI).hostname,
              )
                ? "native"
                : "web",
            },
          });
        } catch (cause) {
          if (!(await recordedClient())) throw cause;
        }
      }
      if (!(await recordedClient())) throw new Error("Forgejo client creation is not confirmed");
      await db
        .update(operation)
        .set({
          state: "ready",
          completedAt: expression`COALESCE(${operation.completedAt},now())`,
          updatedAt: expression`now()`,
        })
        .where(eq(operation.idempotencyKey, identityKey));
      return forgeClientID;
    },
  };
}
