import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { type AuthDatabase, createOperationBridgedAdapter } from "./adapter-bridge";
import { createAuthDatabaseHooks } from "./database-hooks";
import { factoryForgeIssuer } from "./forge-issuer";
import {
  directoryProvisioning,
  type IdentityPolicy,
  identityPolicy,
  passwordPolicy,
  resolveIdentity,
} from "./policy";

export function createBetterAuthInstance(params: {
  database: AuthDatabase;
  policy: IdentityPolicy;
  baseURL: string;
  secret: string;
  cookiePrefix: string;
}) {
  const { database, policy, baseURL, secret, cookiePrefix } = params;
  const { databaseAdapter, recordIdentitySetupTest } = createOperationBridgedAdapter(database.db);
  const identityPolicyPlugin = identityPolicy(policy);
  const {
    externalIdentity: _externalIdentity,
    identitySetup: _identitySetup,
    ...identityPolicySchema
  } = identityPolicyPlugin.schema ?? {};

  return betterAuth({
    appName: "Open Software Factory",
    baseURL,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [
      new URL(baseURL).origin,
      ...(policy.provider?.oidcConfig ? [new URL(policy.provider.oidcConfig.issuer).origin] : []),
    ],
    database: databaseAdapter,
    logger: { disabled: true },
    plugins: [
      { ...identityPolicyPlugin, schema: identityPolicySchema },
      ...factoryForgeIssuer(database, secret, baseURL, policy),
      ...directoryProvisioning(policy),
      ...(policy.provider
        ? [
            sso({
              defaultSSO: [policy.provider],
              resolveUser: (input, context) => resolveIdentity(input, context.database, policy),
            }),
          ]
        : []),
    ],
    account: {
      storeStateStrategy: "database",
      accountLinking: { enabled: false, disableImplicitLinking: true },
    },
    databaseHooks: createAuthDatabaseHooks(policy, recordIdentitySetupTest),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: passwordPolicy.minLength,
      maxPasswordLength: passwordPolicy.maxLength,
    },
    session: {
      expiresIn: 60 * 60 * 24 * policy.sessionDays,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
      additionalFields: {
        authenticatedAt: {
          type: "date",
          required: true,
          input: false,
          defaultValue: () => new Date(),
        },
        loginMethod: { type: "string", required: true, input: false, defaultValue: "password" },
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      cookiePrefix,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: baseURL.startsWith("https://"),
        path: "/",
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      database: { generateId: () => crypto.randomUUID(), joins: false },
    },
  });
}

export type FactoryBetterAuth = ReturnType<typeof createBetterAuthInstance>;
