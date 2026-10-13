import {
  acquireActiveSCIMUserLink,
  type SCIMIdentityResolutionContext,
  type SCIMIdentityResolutionInput,
  scim,
} from "@better-auth/scim";
import type { SSOOptions, SSOUserResolutionInput } from "@better-auth/sso";
import {
  APIError,
  type BetterAuthPlugin,
  type DBTransactionAdapter,
  getCurrentAdapter,
} from "better-auth";
import { addOAuthServerContext, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { z } from "zod";

const sessionPolicyFields = z.object({ loginMethod: z.string(), authenticatedAt: z.coerce.date() });

export const emergencyAdministratorID = "01994a7d-0000-7000-8000-000000000001";
export type IdentityPolicy = {
  sessionDays: number;
  provider?: NonNullable<SSOOptions["defaultSSO"]>[number];
  directory?: { token: string; subjectClaim: string };
  setupCommandID?: string;
  emergencyOnly?: boolean;
};
export type AccountAccess = {
  id: string;
  userId: string;
  disabledAt: Date | null;
  directoryDisabledAt: Date | null;
};
type ExternalIdentity = {
  id: string;
  issuer: string;
  subject: string;
  userId: string;
  directorySubject: string | null;
};

export async function requireAccountAccess(database: DBTransactionAdapter, userId: string) {
  const access = await database.findOne<AccountAccess>({
    model: "accountAccess",
    where: [{ field: "userId", value: userId }],
  });
  if (!access || access.disabledAt || access.directoryDisabledAt)
    throw new APIError("FORBIDDEN", {
      code: "ACCOUNT_DISABLED",
      message: "Account access is disabled",
    });
  return access;
}

export function identityPolicy(policy: IdentityPolicy): BetterAuthPlugin {
  if (!Number.isInteger(policy.sessionDays) || policy.sessionDays < 1 || policy.sessionDays > 30)
    throw new Error("Session duration must be between one and thirty days");
  return {
    id: "factory-identity-policy",
    schema: {
      accountAccess: {
        fields: {
          userId: { type: "string", required: true, unique: true },
          disabledAt: { type: "date", required: false },
          directoryDisabledAt: { type: "date", required: false },
        },
      },
      externalIdentity: {
        fields: {
          issuer: { type: "string", required: true },
          subject: { type: "string", required: true },
          userId: { type: "string", required: true },
          directorySubject: { type: "string", required: false },
          createdAt: { type: "date", required: true },
        },
      },
      identitySetup: {
        fields: {
          baseVersion: { type: "number", required: true },
          metadata: { type: "json", required: true },
          fingerprint: { type: "string", required: true },
          secretKey: { type: "string", required: true },
          createdBy: { type: "string", required: true },
          state: { type: "string", required: true },
          testedAt: { type: "date", required: false },
          testedUserId: { type: "string", required: false },
        },
      },
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            // Factory controls provider configuration and identity changes. No native self-service linking.
            if (ctx.path.startsWith("/sso/") && !ctx.path.startsWith("/sso/callback/"))
              throw new APIError("NOT_FOUND");
            if (
              [
                "/link-social",
                "/unlink-account",
                "/change-email",
                "/delete-user",
                "/set-password",
                "/change-password",
                "/sign-up/email",
                "/sign-in/social",
              ].includes(ctx.path)
            )
              throw new APIError("NOT_FOUND");
            if (ctx.path === "/sign-in/sso") {
              if (!policy.provider) throw new APIError("NOT_FOUND");
              const nonce = crypto.randomUUID();
              await addOAuthServerContext({ factoryNonce: nonce });
              return {
                context: {
                  body: {
                    callbackURL:
                      new URL(ctx.context.options.baseURL as string).origin +
                      (policy.setupCommandID ? `/?identity-check=${policy.setupCommandID}` : ""),
                    providerId: policy.provider.providerId,
                    providerType: "oidc",
                    additionalParams: { prompt: "login", max_age: "300" },
                    ...(typeof ctx.body?.oauth_query === "string"
                      ? { oauth_query: ctx.body.oauth_query }
                      : {}),
                  },
                },
              };
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/sso" || ctx.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/get-session") {
              const result: unknown = ctx.context.returned;
              if (result && typeof result === "object" && "session" in result) {
                const parsed = sessionPolicyFields.safeParse(result.session);
                if (
                  parsed.success &&
                  (parsed.data.loginMethod === "identity-test" ||
                    (policy.emergencyOnly &&
                      !(
                        "user" in result &&
                        result.user &&
                        typeof result.user === "object" &&
                        "id" in result.user &&
                        result.user.id === emergencyAdministratorID
                      )) ||
                    (parsed.data.loginMethod === "sso" &&
                      Date.now() - parsed.data.authenticatedAt.getTime() > 24 * 60 * 60_000))
                )
                  return ctx.json(null);
              }
            }
            if (ctx.path === "/sign-in/sso") {
              const state = await getOAuthState();
              const returned: unknown = ctx.context.returned;
              if (
                state?.serverContext?.["factoryNonce"] &&
                returned &&
                typeof returned === "object" &&
                "url" in returned &&
                typeof returned.url === "string"
              ) {
                const url = new URL(returned.url);
                url.searchParams.set("nonce", String(state.serverContext["factoryNonce"]));
                return ctx.json({ url: url.toString(), redirect: true });
              }
            } else {
              const returned: unknown = ctx.context.returned;
              if (
                returned &&
                typeof returned === "object" &&
                "user" in returned &&
                returned.user &&
                typeof returned.user === "object" &&
                "id" in returned.user &&
                typeof returned.user.id === "string"
              ) {
                try {
                  await requireAccountAccess(
                    await getCurrentAdapter(ctx.context.adapter),
                    returned.user.id,
                  );
                } catch {
                  return ctx.json(null);
                }
              }
            }
          }),
        },
      ],
    },
  };
}

export async function resolveIdentity(
  input: SSOUserResolutionInput,
  database: DBTransactionAdapter,
  policy: IdentityPolicy,
) {
  const state = await getOAuthState();
  const nonce = state?.serverContext?.["factoryNonce"];
  if (
    input.protocol !== "oidc" ||
    !policy.provider ||
    input.accountKey.issuer !== policy.provider.oidcConfig?.issuer ||
    input.providerId !== policy.provider.providerId
  )
    throw new APIError("FORBIDDEN", { code: "IDENTITY_NOT_ALLOWED" });
  const claims = input.verifiedIdTokenClaims;
  const authenticated = claims["auth_time"];
  if (
    typeof nonce !== "string" ||
    claims["nonce"] !== nonce ||
    typeof authenticated !== "number" ||
    !Number.isFinite(authenticated) ||
    authenticated > Date.now() / 1000 + 60 ||
    authenticated < Date.now() / 1000 - 300
  )
    throw new APIError("FORBIDDEN", { code: "IDENTITY_REVALIDATION_REQUIRED" });
  const where = [
    { field: "issuer", value: input.accountKey.issuer },
    { field: "subject", value: input.accountKey.accountId },
  ];
  const previous = await database.findOne<ExternalIdentity>({ model: "externalIdentity", where });
  let provisionedUserId: string | undefined;
  if (policy.directory) {
    const externalId = claims[policy.directory.subjectClaim];
    if (typeof externalId !== "string" || !externalId)
      throw new APIError("FORBIDDEN", { code: "DIRECTORY_IDENTITY_REQUIRED" });
    const link = await acquireActiveSCIMUserLink(
      { connectionId: "company", externalId },
      { database },
    );
    if (
      !link ||
      (previous && (previous.userId !== link.userId || previous.directorySubject !== externalId))
    )
      throw new APIError("FORBIDDEN", { code: "DIRECTORY_ACCESS_DISABLED" });
    provisionedUserId = link.userId;
  }
  if (previous) {
    await requireAccountAccess(database, previous.userId);
    return { action: "link", userId: previous.userId, profile: "preserve" } as const;
  }
  if (provisionedUserId) {
    await requireAccountAccess(database, provisionedUserId);
    await database.create({
      model: "externalIdentity",
      data: {
        issuer: input.accountKey.issuer,
        subject: input.accountKey.accountId,
        userId: provisionedUserId,
        directorySubject: claims[policy.directory?.subjectClaim ?? ""],
        createdAt: new Date(),
      },
    });
    return { action: "link", userId: provisionedUserId, profile: "preserve" } as const;
  }
  // An email collision is a conflict, never permission to attach another identity.
  const email = input.providerUser.email.toLowerCase();
  const allowedDomains = policy.provider.domain
    .split(",")
    .map((domain) => domain.trim().toLowerCase());
  if (!allowedDomains.includes(email.split("@").at(-1) ?? ""))
    throw new APIError("FORBIDDEN", { code: "IDENTITY_DOMAIN_NOT_ALLOWED" });
  const collision = await database.findOne({
    model: "user",
    where: [{ field: "email", value: email }],
  });
  if (collision)
    throw new APIError("CONFLICT", {
      code: "IDENTITY_EMAIL_CONFLICT",
      message: "Ask a System Manager to resolve this account",
    });
  const userId = crypto.randomUUID();
  await database.create({
    model: "user",
    forceAllowId: true,
    data: {
      id: userId,
      email,
      name: input.providerUser.name || email,
      emailVerified: input.providerUser.emailVerified,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await database.create({
    model: "externalIdentity",
    data: {
      ...Object.fromEntries(where.map((item) => [item.field, item.value])),
      userId,
      createdAt: new Date(),
    },
  });
  await requireAccountAccess(database, userId);
  return { action: "link", userId, profile: "preserve" } as const;
}

export function directoryProvisioning(policy: IdentityPolicy): BetterAuthPlugin[] {
  if (!policy.directory) return [];
  if (!policy.provider) throw new Error("Directory provisioning requires company sign-in");
  const issuer = policy.provider.oidcConfig?.issuer;
  const native = scim({
    connections: [
      {
        id: "company",
        credentials: [{ type: "bearer", id: "company-directory", token: policy.directory.token }],
      },
    ],
    identity: {
      async resolveUser(
        input: SCIMIdentityResolutionInput,
        context: SCIMIdentityResolutionContext,
      ) {
        if (!input.resource.externalId)
          throw new APIError("BAD_REQUEST", {
            message: "A stable directory externalId is required",
          });
        const bound = await context.database.findOne<ExternalIdentity>({
          model: "externalIdentity",
          where: [
            { field: "issuer", value: issuer ?? "" },
            { field: "directorySubject", value: input.resource.externalId },
          ],
        });
        if (bound) return { action: "link", userId: bound.userId, profile: "preserve" };
        // Native SCIM creates its own user. Existing email is an error, never an identity link.
        return { action: "create" };
      },
      async reconcileUser(input, { database }) {
        await database.update({
          model: "accountAccess",
          where: [{ field: "userId", value: input.userId }],
          update: { directoryDisabledAt: input.active ? null : new Date() },
        });
      },
    },
  });
  // Static provisioning omits the native managed-catalog tables and their optional type keys.
  const {
    scimManagedConnection: _connection,
    scimManagedCredential: _credential,
    scimManagedConnectionEvent: _event,
    ...schema
  } = native.schema;
  return [{ ...native, schema }];
}
