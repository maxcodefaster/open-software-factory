import type { AuthDatabase } from "./adapter-bridge";
import { createBetterAuthInstance } from "./auth-instance";
import { forgeBackchannelOrigin } from "./backchannel";
import { developmentAdministratorPassword } from "./database-hooks";
import { requireLocalForgeIssuer } from "./local-issuer";
import { createOidcMcpHelpers } from "./oidc-mcp";
import type { IdentityPolicy } from "./policy";
import { createSessionAccessHelpers } from "./session-access";
import { factorySigningSecret } from "./signing-secret";

export function createFactoryAuth(
  database: AuthDatabase,
  policy: IdentityPolicy = { sessionDays: 7 },
  options: { cookiePrefix?: string } = {},
) {
  const {
    FACTORY_ADMIN_EMAIL,
    FACTORY_ADMIN_NAME,
    FACTORY_ADMIN_PASSWORD,
    FACTORY_BASE_URL,
    FACTORY_AUTH_COOKIE_PREFIX,
  } = process.env;
  const baseURL = FACTORY_BASE_URL ?? "http://127.0.0.1:3000";
  const secret = factorySigningSecret();
  const development =
    process.env["NODE_ENV"] !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname);
  const internalIssuer = requireLocalForgeIssuer(
    baseURL,
    process.env["FACTORY_FORGE_ISSUER_URL"],
    development,
    process.env["FACTORY_FORGE_ISSUER_HOST"] ||
      process.env["FACTORY_RUNTIME_HOST"] ||
      "host.orb.internal",
  );
  const backchannel = forgeBackchannelOrigin(process.env["FACTORY_AUTH_BACKCHANNEL_URL"]);
  if (backchannel && internalIssuer)
    throw new Error("A Kubernetes Forge backchannel cannot rename the retained issuer");
  if (!development && new URL(baseURL).protocol !== "https:")
    throw new Error("Non-development installations require an HTTPS Factory URL");
  if (
    (process.env["NODE_ENV"] === "production" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) &&
    (!FACTORY_ADMIN_PASSWORD || FACTORY_ADMIN_PASSWORD === developmentAdministratorPassword)
  )
    throw new Error(
      "Non-development installations require a unique signing secret and emergency administrator password",
    );

  const auth = createBetterAuthInstance({
    database,
    policy,
    baseURL,
    secret,
    cookiePrefix: options.cookiePrefix ?? FACTORY_AUTH_COOKIE_PREFIX ?? "factory",
  });

  const sessionAccess = createSessionAccessHelpers({
    database,
    auth,
    policy,
    adminEmail: FACTORY_ADMIN_EMAIL,
    adminName: FACTORY_ADMIN_NAME,
    adminPassword: FACTORY_ADMIN_PASSWORD,
  });
  const oidcMcp = createOidcMcpHelpers({
    database,
    auth,
    policy,
    baseURL,
    secret,
    internalIssuer,
    backchannel,
    getSession: sessionAccess.session,
    requireFresh: sessionAccess.requireFresh,
  });

  return {
    auth,
    policy: {
      sessionDays: policy.sessionDays,
      companySignIn: Boolean(policy.provider || policy.emergencyOnly),
    },
    ...oidcMcp,
    ...sessionAccess,
  };
}
