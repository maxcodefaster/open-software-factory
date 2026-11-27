import { APIError, type DBAdapter, getCurrentAdapter } from "better-auth";
import { emergencyAdministratorID, type IdentityPolicy, requireAccountAccess } from "./policy";

export const developmentAdministratorPassword = "factory-local-password";

export function createAuthDatabaseHooks(
  policy: IdentityPolicy,
  recordIdentitySetupTest: (setupCommandID: string, userId: string) => Promise<void>,
) {
  const stripProviderTokens = async <T extends Record<string, unknown>>(account: T) => ({
    data: { ...account, accessToken: null, refreshToken: null, idToken: null },
  });
  return {
    account: {
      create: { before: stripProviderTokens },
      update: { before: stripProviderTokens },
    },
    session: {
      create: {
        before: async (
          session: { userId: string },
          context: { path: string; context: { adapter: DBAdapter } } | null,
        ) => {
          if (!context) throw new APIError("FORBIDDEN");
          await requireAccountAccess(
            await getCurrentAdapter(context.context.adapter),
            session.userId,
          );
          const ssoLogin = context.path.startsWith("/sso/callback/");
          if (
            (policy.provider || policy.emergencyOnly) &&
            !ssoLogin &&
            session.userId !== emergencyAdministratorID
          )
            throw new APIError("FORBIDDEN", { message: "Use company sign-in" });
          if (ssoLogin && policy.setupCommandID) {
            await recordIdentitySetupTest(policy.setupCommandID, session.userId);
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
  };
}
