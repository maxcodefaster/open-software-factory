import { oauthProvider } from "@better-auth/oauth-provider";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";

export const factoryMCPScopes = ["factory:read", "factory:work", "offline_access"] as const;
export const factoryMCPClientPrefix = "factory-mcp-";
export const factoryMCPResource = (baseURL: string) => `${baseURL.replace(/\/$/, "")}/api/mcp`;

const metadata = z.object({
  client_name: z.string().min(1).max(160).optional(),
  redirect_uris: z.array(z.url()).min(1).max(8),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
  scope: z.string().max(256).optional(),
  client_uri: z.url().optional(),
  software_id: z.string().max(160).optional(),
  software_version: z.string().max(160).optional(),
});

/** Public MCP registration is not the server-only, retained Forgejo client creator. */
export function factoryMCPRegistration(
  developer: (userID: string) => Promise<void>,
  resource: string,
) {
  const registrar = oauthProvider({
    loginPage: "/",
    consentPage: "/",
    scopes: [...factoryMCPScopes],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    resources: [
      { identifier: resource, allowedScopes: [...factoryMCPScopes], accessTokenTtl: 300 },
    ],
    clientRegistrationDefaultResources: [resource],
    generateClientId: () => `${factoryMCPClientPrefix}${crypto.randomUUID()}`,
    clientRegistrationDefaultScopes: [...factoryMCPScopes],
    clientPrivileges: async ({ user }) => {
      if (!user) return false;
      await developer(user.id);
      return true;
    },
  });
  const register = registrar.endpoints.registerOAuthClient;
  const { openapi: _openapi, ...nativeMetadata } = register.options.metadata;
  const endpoint = createAuthEndpoint(
    "/mcp/register",
    {
      ...register.options,
      body: metadata,
      metadata: nativeMetadata,
    },
    async (context) => {
      const input = context.body;
      const native = input.redirect_uris.some((uri) => {
        const url = new URL(uri);
        return url.protocol !== "https:";
      });
      const result = await register({
        context: context.context,
        ...(context.headers ? { headers: context.headers } : {}),
        asResponse: false,
        returnHeaders: false,
        returnStatus: false,
        body: {
          ...input,
          client_name: input.client_name ?? "Factory MCP client",
          application_type: native ? "native" : "web",
          grant_types: input.grant_types ?? ["authorization_code", "refresh_token"],
          response_types: input.response_types ?? ["code"],
          scope: input.scope ?? factoryMCPScopes.join(" "),
        },
      });
      context.setStatus(201);
      return result;
    },
  );
  return {
    id: "factory-mcp-registration" as const,
    endpoints: { registerFactoryMCPClient: endpoint },
    rateLimit: [{ pathMatcher: (path: string) => path === "/mcp/register", window: 60, max: 5 }],
  };
}
