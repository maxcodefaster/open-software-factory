import { sso } from "@better-auth/sso";
import { APIError, betterAuth, getCurrentAdapter } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { parseCookies } from "better-auth/cookies";
import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import type { createDatabase } from "../../db/src/client";
import {
  accountAccess,
  betterAuthSchema,
  externalIdentity,
  identitySetup,
} from "../../db/src/schema";
import { factoryForgeIssuer, forgeClientID, forgeClientSecret } from "./forge-issuer";
import {
  directoryProvisioning,
  emergencyAdministratorID,
  type IdentityPolicy,
  identityPolicy,
  requireAccountAccess,
  resolveIdentity,
} from "./policy";

type Database = ReturnType<typeof createDatabase>;

const administratorID = emergencyAdministratorID;

export function createFactoryAuth(
  database: Database,
  policy: IdentityPolicy = { sessionDays: 7 },
  options: { cookiePrefix?: string } = {},
) {
  const { client, db } = database;
  const {
    FACTORY_ADMIN_EMAIL,
    FACTORY_ADMIN_NAME,
    FACTORY_ADMIN_PASSWORD,
    FACTORY_AUTH_SECRET,
    FACTORY_BASE_URL,
    FACTORY_AUTH_COOKIE_PREFIX,
  } = process.env;
  const baseURL = FACTORY_BASE_URL ?? "http://127.0.0.1:3000";
  const secret = FACTORY_AUTH_SECRET ?? "local-development-secret-change-before-production";
  const development =
    process.env["NODE_ENV"] !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname);
  const publicIssuer = `${baseURL.replace(/\/$/, "")}/api/auth`;
  const issuerOverride = process.env["FACTORY_FORGE_ISSUER_URL"];
  const internalIssuer =
    issuerOverride && issuerOverride !== publicIssuer ? new URL(issuerOverride) : undefined;
  if (
    internalIssuer &&
    (!development ||
      internalIssuer.hostname !== "host.orb.internal" ||
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
  if (!development && new URL(baseURL).protocol !== "https:")
    throw new Error("Non-development installations require an HTTPS Factory URL");
  if (
    (process.env["NODE_ENV"] === "production" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) &&
    (!FACTORY_AUTH_SECRET ||
      FACTORY_AUTH_SECRET === "local-development-secret-change-before-production" ||
      !FACTORY_ADMIN_PASSWORD ||
      FACTORY_ADMIN_PASSWORD === "factory-local-password")
  )
    throw new Error(
      "Non-development installations require a unique signing secret and emergency administrator password",
    );
  const auth = betterAuth({
    appName: "Open Software Factory",
    baseURL,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [
      new URL(baseURL).origin,
      ...(policy.provider?.oidcConfig ? [new URL(policy.provider.oidcConfig.issuer).origin] : []),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { ...betterAuthSchema, accountAccess, externalIdentity, identitySetup },
      schemaName: "auth",
      transaction: true,
    }),
    logger: { disabled: true },
    plugins: [
      identityPolicy(policy),
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
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({
            data: { ...account, accessToken: null, refreshToken: null, idToken: null },
          }),
        },
        update: {
          before: async (account) => ({
            data: { ...account, accessToken: null, refreshToken: null, idToken: null },
          }),
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            if (!context) throw new APIError("FORBIDDEN");
            await requireAccountAccess(
              await getCurrentAdapter(context.context.adapter),
              session.userId,
            );
            const ssoLogin = context.path.startsWith("/sso/callback/");
            if (
              (policy.provider || policy.emergencyOnly) &&
              !ssoLogin &&
              session.userId !== administratorID
            )
              throw new APIError("FORBIDDEN", { message: "Use company sign-in" });
            if (ssoLogin && policy.setupCommandID) {
              const recorded = await (await getCurrentAdapter(context.context.adapter)).update({
                model: "identitySetup",
                where: [
                  { field: "id", value: policy.setupCommandID },
                  { field: "state", value: "saved" },
                ],
                update: { testedAt: new Date(), testedUserId: session.userId },
              });
              if (!recorded) throw new APIError("CONFLICT", { message: "Sign-in setup changed" });
            }
            return {
              data: {
                authenticatedAt: new Date(),
                loginMethod: policy.setupCommandID
                  ? "identity-test"
                  : ssoLogin
                    ? "sso"
                    : policy.provider
                      ? "emergency"
                      : "password",
              },
            };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
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
      cookiePrefix: options.cookiePrefix ?? FACTORY_AUTH_COOKIE_PREFIX ?? "factory",
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
  return {
    auth,
    policy: {
      sessionDays: policy.sessionDays,
      companySignIn: Boolean(policy.provider || policy.emergencyOnly),
    },
    async discovery() {
      const native = await auth.api.getOpenIdConfig();
      if (!internalIssuer) return native;
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
      const session = await this.requireFresh(new Request(baseURL, { headers }));
      const [manager] =
        await client`SELECT user_id FROM factory.administrator WHERE user_id=${session.user.id}`;
      if (!manager) throw new APIError("FORBIDDEN");
      await client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('factory-forgejo-client',0))`;
        await sql`INSERT INTO factory.forge_identity_intent(client_id,redirect_uri,intended_by,state)
          VALUES(${forgeClientID},${redirectURI},${session.user.id},'create-intended') ON CONFLICT DO NOTHING`;
        const [intent] = await sql<
          { redirectURI: string }[]
        >`SELECT redirect_uri AS "redirectURI" FROM factory.forge_identity_intent WHERE client_id=${forgeClientID}`;
        if (intent?.redirectURI !== redirectURI)
          throw new Error("Forgejo callback differs from its intended identity");
      });
      async function recordedClient() {
        const [previous] = await client<
          {
            redirectUris: string[];
            disabled: boolean;
            secret: string;
            pkce: boolean;
            method: string;
          }[]
        >`
          SELECT "redirectUris",disabled,"clientSecret" AS secret,"requirePKCE" AS pkce,"tokenEndpointAuthMethod" AS method FROM auth."oauthClient" WHERE "clientId"=${forgeClientID}`;
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
      await client`UPDATE factory.forge_identity_intent SET state='ready',observed_at=COALESCE(observed_at,now()) WHERE client_id=${forgeClientID}`;
      return forgeClientID;
    },
    async matchesOAuthState(request: Request) {
      const state = new URL(request.url).searchParams.get("state");
      if (!state || state.length > 256) return false;
      const context = await auth.$context;
      const value = parseCookies(request.headers.get("cookie") ?? "").get(
        context.createAuthCookie("state").name,
      );
      if (!value) return false;
      const expected = `${state}.${await makeSignature(state, context.secret)}`;
      return constantTimeEqual(value, expected);
    },
    async requireFresh(request: Request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || Date.now() - new Date(session.session.authenticatedAt).getTime() > 5 * 60_000)
        throw new Error("Sign in again before changing security settings");
      return session;
    },
    async bootstrap() {
      const email = (FACTORY_ADMIN_EMAIL ?? "admin@factory.local").toLowerCase();
      const name = FACTORY_ADMIN_NAME ?? "Local administrator";
      const password = FACTORY_ADMIN_PASSWORD ?? "factory-local-password";
      const context = await auth.$context;
      const existing = await context.internalAdapter.findUserByEmail(email, {
        includeAccounts: true,
      });
      if (existing && existing.user.id !== administratorID)
        throw new Error("The emergency administrator email belongs to another identity");
      if (!existing) {
        await context.adapter.create({
          model: "user",
          forceAllowId: true,
          data: {
            id: administratorID,
            email,
            emailVerified: true,
            name,
            image: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        await context.internalAdapter.createAccount({
          accountId: administratorID,
          providerId: "credential",
          userId: administratorID,
          password: await context.password.hash(password),
        });
      }
      await client`
        INSERT INTO factory.administrator(user_id)
        VALUES (${existing?.user.id ?? administratorID})
        ON CONFLICT DO NOTHING
      `;
    },
    async createManagedUser(input: { name: string; email: string; password: string }) {
      if (policy.provider || policy.emergencyOnly)
        throw new APIError("FORBIDDEN", {
          message: "Accounts are provisioned through company sign-in",
        });
      const context = await auth.$context;
      const password = await context.password.hash(input.password);
      return client.begin(async (sql) => {
        const id = crypto.randomUUID();
        const users = await sql<Array<{ id: string; name: string; email: string }>>`
          INSERT INTO auth."user"(id, name, email, email_verified)
          VALUES (${id}, ${input.name}, ${input.email.toLowerCase()}, true)
          RETURNING id, name, email
        `;
        await sql`INSERT INTO auth.account(id, account_id, provider_id, user_id, password)
          VALUES (${crypto.randomUUID()}, ${id}, 'credential', ${id}, ${password})`;
        return users[0];
      });
    },
    async session(request: Request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      if (
        session.session.loginMethod === "identity-test" ||
        (policy.emergencyOnly && session.user.id !== administratorID) ||
        (session.session.loginMethod === "sso" &&
          Date.now() - new Date(session.session.authenticatedAt).getTime() > 24 * 60 * 60_000)
      )
        return null;
      const prohibited = await client`SELECT user_id FROM factory.account_access
        WHERE user_id=${session.user.id}
          AND (disabled_at IS NOT NULL OR directory_disabled_at IS NOT NULL)`;
      if (prohibited.length) return null;
      const administrators = await client<{ user_id: string }[]>`
        SELECT user_id FROM factory.administrator WHERE user_id = ${session.user.id}
      `;
      return { ...session, systemManager: Boolean(administrators[0]) };
    },
  };
}
