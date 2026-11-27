import { APIError } from "better-auth";
import { parseCookies } from "better-auth/cookies";
import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import { and, DrizzleQueryError, eq, sql as expression, isNotNull, ne, or } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { accountAccess, administrator, authAccount, authSession, authUser } from "#db/schema";
import type { AuthDatabase } from "./adapter-bridge";
import type { FactoryBetterAuth } from "./auth-instance";
import { developmentAdministratorPassword } from "./database-hooks";
import {
  checkPasswordChange,
  emergencyAdministratorID,
  type IdentityPolicy,
  PasswordChangeError,
  passwordChangeMessage,
} from "./policy";

const administratorID = emergencyAdministratorID;

// Failed current-password checks per account. Five failures lock changes for fifteen minutes,
// in the same process that answers sign-in, and a success clears them.
const passwordChangeWindow = 15 * 60_000;
const passwordChangeFailures = new Map<string, number[]>();

function recentPasswordFailures(userID: string) {
  const recent = (passwordChangeFailures.get(userID) ?? []).filter(
    (at) => Date.now() - at < passwordChangeWindow,
  );
  if (recent.length) passwordChangeFailures.set(userID, recent);
  else passwordChangeFailures.delete(userID);
  return recent;
}

function authWriteFailure(cause: unknown): never {
  // Preserve SQLSTATE for callers without Drizzle's password-bearing query parameters.
  if (cause instanceof DrizzleQueryError && cause.cause) throw cause.cause;
  throw cause;
}

export function createSessionAccessHelpers(deps: {
  database: AuthDatabase;
  auth: FactoryBetterAuth;
  policy: IdentityPolicy;
  adminEmail: string | undefined;
  adminName: string | undefined;
  adminPassword: string | undefined;
}) {
  const { database, auth, policy, adminEmail, adminName, adminPassword } = deps;
  const { client, db } = database;

  return {
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
      const email = (adminEmail ?? "admin@factory.local").toLowerCase();
      const name = adminName ?? "Local administrator";
      const password = adminPassword ?? developmentAdministratorPassword;
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
      } else if (password !== developmentAdministratorPassword) {
        // A database first started with the development password must not keep it
        // once the installation is configured with a real one.
        const credential = existing.accounts.find((account) => account.providerId === "credential");
        if (
          credential?.password &&
          (await context.password.verify({
            hash: credential.password,
            password: developmentAdministratorPassword,
          }))
        )
          await context.internalAdapter.updatePassword(
            existing.user.id,
            await context.password.hash(password),
          );
      }
      await db
        .insert(administrator)
        .values({ userId: existing?.user.id ?? administratorID })
        .onConflictDoNothing();
    },

    async createManagedUser(input: { name: string; email: string; password: string }) {
      if (policy.provider || policy.emergencyOnly)
        throw new APIError("FORBIDDEN", {
          message: "Accounts are provisioned through company sign-in",
        });
      const context = await auth.$context;
      const password = await context.password.hash(input.password);
      return client
        .begin(async (sql) => {
          const id = crypto.randomUUID();
          const transaction = drizzleTransaction(sql);
          const users = await transaction
            .insert(authUser)
            .values({
              id,
              name: input.name,
              email: input.email.toLowerCase(),
              emailVerified: true,
            })
            .returning({ id: authUser.id, name: authUser.name, email: authUser.email });
          await transaction.insert(authAccount).values({
            id: crypto.randomUUID(),
            accountId: id,
            providerId: "credential",
            userId: id,
            password,
          });
          return users[0];
        })
        .catch(authWriteFailure);
    },

    /**
     * Self-service password rotation. Better Auth's own /change-password stays blocked; this is the
     * only path. Callers must already have passed the fresh-session write gate, which is checked
     * again here against the named session. Other sessions end; the current one stays.
     */
    async changePassword(
      userID: string,
      sessionID: string,
      input: { currentPassword: string; newPassword: string; confirmPassword: string },
    ) {
      const refusal = checkPasswordChange(input);
      if (refusal) throw new PasswordChangeError("refused", passwordChangeMessage(refusal));
      const [session] = await db
        .select({
          loginMethod: authSession.loginMethod,
          authenticatedAt: authSession.authenticatedAt,
          expiresAt: authSession.expiresAt,
        })
        .from(authSession)
        .where(and(eq(authSession.id, sessionID), eq(authSession.userId, userID)));
      if (!session || new Date(session.expiresAt).getTime() <= Date.now())
        throw new PasswordChangeError(
          "unavailable",
          "Sign in again before changing your password.",
        );
      if (Date.now() - new Date(session.authenticatedAt).getTime() > 5 * 60_000)
        throw new PasswordChangeError(
          "unavailable",
          "Sign in again before changing protected settings.",
        );
      const [credential] = await db
        .select({ id: authAccount.id, password: authAccount.password })
        .from(authAccount)
        .where(and(eq(authAccount.userId, userID), eq(authAccount.providerId, "credential")));
      if (
        !credential?.password ||
        (session.loginMethod !== "password" && session.loginMethod !== "emergency")
      )
        throw new PasswordChangeError(
          "refused",
          "This account signs in through company sign-in and has no Factory password.",
        );
      const failures = recentPasswordFailures(userID);
      if (failures.length >= 5) {
        const minutes = Math.max(
          1,
          Math.ceil(((failures[0] ?? Date.now()) + passwordChangeWindow - Date.now()) / 60_000),
        );
        throw new PasswordChangeError(
          "locked",
          `Too many incorrect current passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      }
      const context = await auth.$context;
      if (
        !(await context.password.verify({
          hash: credential.password,
          password: input.currentPassword,
        }))
      ) {
        passwordChangeFailures.set(userID, [...failures, Date.now()]);
        throw new PasswordChangeError("wrong-password", "The current password is incorrect.");
      }
      const hash = await context.password.hash(input.newPassword);
      await client
        .begin(async (sql) => {
          const transaction = drizzleTransaction(sql);
          await transaction
            .update(authAccount)
            .set({ password: hash, updatedAt: expression`now()` })
            .where(eq(authAccount.id, credential.id));
          await transaction
            .delete(authSession)
            .where(and(eq(authSession.userId, userID), ne(authSession.id, sessionID)));
        })
        .catch(authWriteFailure);
      passwordChangeFailures.delete(userID);
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
      const prohibited = await db
        .select({ userID: accountAccess.userId })
        .from(accountAccess)
        .where(
          and(
            eq(accountAccess.userId, session.user.id),
            or(isNotNull(accountAccess.disabledAt), isNotNull(accountAccess.directoryDisabledAt)),
          ),
        );
      if (prohibited.length) return null;
      const administrators = await db
        .select({ userID: administrator.userId })
        .from(administrator)
        .where(eq(administrator.userId, session.user.id));
      return { ...session, systemManager: Boolean(administrators[0]) };
    },
  };
}
