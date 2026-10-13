import { createHmac } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { addOAuthServerContext, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { z } from "zod";
import type { createDatabase } from "../../db/src/client";
import { emergencyAdministratorID, type IdentityPolicy } from "./policy";

export const forgeClientID = "factory-forgejo";
const issuerSession = z.object({
  loginMethod: z.enum(["password", "sso", "emergency", "identity-test"]),
  authenticatedAt: z.coerce.date(),
});
export function forgeClientSecret(signingKey: string) {
  return createHmac("sha256", signingKey)
    .update("factory-forgejo-oidc-client-v1")
    .digest("base64url");
}

export function factoryForgeIssuer(
  database: ReturnType<typeof createDatabase>,
  signingKey: string,
  baseURL: string,
  policy: IdentityPolicy,
) {
  async function developer(userID: string) {
    const [allowed] = await database.client`
      SELECT access.user_id FROM factory.account_access access
      WHERE access.user_id=${userID} AND disabled_at IS NULL AND directory_disabled_at IS NULL
        AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID})
          OR EXISTS(SELECT 1 FROM factory.project_membership WHERE user_id=${userID} AND role='developer'))`;
    if (!allowed) throw new APIError("FORBIDDEN", { message: "Developer access required" });
  }
  const boundary: BetterAuthPlugin = {
    id: "factory-forge-identity",
    hooks: {
      before: [
        {
          matcher: (context) =>
            Boolean(context.path?.startsWith("/oauth2/")) ||
            Boolean(context.path?.startsWith("/admin/oauth2/")) ||
            context.path === "/token",
          handler: createAuthMiddleware(async (context) => {
            if (policy.setupCommandID || policy.emergencyOnly) throw new APIError("NOT_FOUND");
            if (context.path === "/token") throw new APIError("NOT_FOUND");
            if (context.path.startsWith("/admin/oauth2/")) {
              // Native client creation is server-only. No client-administration product API.
              if (context.request) throw new APIError("NOT_FOUND");
              return;
            }
            if (
              [
                "/oauth2/create-client",
                "/oauth2/register",
                "/oauth2/update-client",
                "/oauth2/delete-client",
                "/oauth2/rotate-client-secret",
              ].includes(context.path)
            )
              throw new APIError("NOT_FOUND");
            if (context.path === "/oauth2/authorize") {
              const session = await getSessionFromCtx(context);
              if (!session) return;
              const fields = issuerSession.parse(session.session);
              if (
                fields.loginMethod === "identity-test" ||
                (fields.loginMethod === "sso" &&
                  Date.now() - fields.authenticatedAt.getTime() > 24 * 60 * 60_000) ||
                (policy.provider &&
                  fields.loginMethod === "password" &&
                  session.user.id !== emergencyAdministratorID)
              )
                throw new APIError("UNAUTHORIZED", {
                  message: "Company sign-in must be revalidated",
                });
              await developer(session.user.id);
            }
          }),
        },
      ],
    },
  };
  const native = oauthProvider({
    loginPage: "/",
    consentPage: "/",
    scopes: ["openid", "profile", "email"],
    grantTypes: ["authorization_code"],
    accessTokenExpiresIn: 300,
    idTokenExpiresIn: 300,
    allowDynamicClientRegistration: false,
    generateClientId: () => forgeClientID,
    generateClientSecret: () => forgeClientSecret(signingKey),
    clientPrivileges: async ({ user, session, action }) => {
      if (
        !user ||
        !session ||
        action !== "create" ||
        Date.now() - issuerSession.parse(session).authenticatedAt.getTime() > 300_000
      )
        return false;
      const [manager] =
        await database.client`SELECT user_id FROM factory.administrator WHERE user_id=${user.id}`;
      return Boolean(manager);
    },
    customIdTokenClaims: async ({ user }) => {
      await developer(user.id);
      return { preferred_username: `factory-${user.id.replaceAll("-", "")}` };
    },
    customUserInfoClaims: async ({ user }) => {
      await developer(user.id);
      return { preferred_username: `factory-${user.id.replaceAll("-", "")}` };
    },
  });
  // The pinned plugin's generated OpenAPI parameter union contains explicit undefined keys.
  // Keep its native handler and endpoint options; Factory does not expose OpenAPI documentation.
  const authorize = native.endpoints.oauth2Authorize;
  const { openapi: _openapi, ...metadata } = authorize.options.metadata;
  const adaptedAuthorize = Object.assign(
    (...args: Parameters<typeof authorize>) => authorize(...args),
    { ...authorize, options: { ...authorize.options, metadata } },
  );
  const before = native.hooks.before.map((hook) => ({
    ...hook,
    handler: createAuthMiddleware(async (context) => {
      const { request, headers, ...input } = context;
      await hook.handler({
        ...input,
        ...(request ? { request } : {}),
        ...(headers ? { headers } : {}),
      });
      if (context.path !== "/sign-in/sso" || typeof context.body?.oauth_query !== "string") return;
      // Native OAuth middleware has already verified the signature and expiry.
      // Carry its authorization through native SSO state, as upstream does for social login.
      const query = new URLSearchParams(context.body.oauth_query);
      const issued = query.get("ba_iat");
      query.delete("sig");
      query.delete("exp");
      query.delete("ba_iat");
      query.delete("ba_pl");
      await addOAuthServerContext({
        query: query.toString(),
        ...(issued ? { signedQueryIssuedAtMs: Number(issued) } : {}),
      });
    }),
  }));
  return [
    boundary,
    jwt({
      jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
      jwt: {
        issuer: process.env["FACTORY_FORGE_ISSUER_URL"] ?? `${baseURL.replace(/\/$/, "")}/api/auth`,
      },
      disableSettingJwtHeader: true,
    }),
    {
      ...native,
      hooks: { ...native.hooks, before },
      endpoints: { ...native.endpoints, oauth2Authorize: adaptedAuthorize },
    },
  ] as const;
}
