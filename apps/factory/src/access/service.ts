import { and, asc, eq, exists, isNotNull, sql as query } from "drizzle-orm";
import type { z } from "zod";
import { emergencyAdministratorID, PasswordChangeError } from "#auth/policy";
import type { createDatabase } from "#db/client";
import { accountAccess, administrator, authAccount, authUser, projectMembership } from "#db/schema";
import { CommandError } from "../command-error";
import { createAccountCommands } from "./accounts";
import type { managedUserInput, memberInput, passwordChangeInput } from "./commands";
import { createAccessController } from "./controller";
import type { createIdentityConfiguration } from "./identity-configuration";
import { createMembershipCommands } from "./membership";

export function createAccessService(options: {
  database: ReturnType<typeof createDatabase>;
  identity: Pick<
    ReturnType<typeof createIdentityConfiguration>,
    "policy" | "createManagedUser" | "changePassword" | "view" | "save" | "activate"
  >;
  revokeMember(projectID: string, userID: string): Promise<void>;
  revokeAccount(userID: string, disabled: boolean): Promise<void>;
  forgeOrigin: string | undefined;
  mcpAuthorization?: Pick<ReturnType<typeof createIdentityConfiguration>, "mcpConsentDetails">;
}) {
  const { database, identity } = options;
  const access = createAccessController(database);
  const memberships = createMembershipCommands(database);
  const accounts = createAccountCommands(database);
  return {
    async mcpAuthorization(request: Request, query: string) {
      if (!options.mcpAuthorization)
        throw new CommandError("unavailable", "MCP authorization is unavailable");
      return options.mcpAuthorization.mcpConsentDetails(request, query);
    },
    async policy() {
      return { ...identity.policy };
    },
    async authentication(userID: string, fresh: boolean) {
      const [person] = await database.db
        .select({ email: authUser.email })
        .from(authUser)
        .where(eq(authUser.id, userID));
      return {
        fresh,
        email: person?.email ?? "",
        companySignIn: identity.policy.companySignIn && userID !== emergencyAdministratorID,
      };
    },
    /** Only accounts holding a Factory password are offered a change. Company sign-in accounts are not. */
    async passwordChange(userID: string) {
      const [credential] = await database.db
        .select({ id: authAccount.id })
        .from(authAccount)
        .where(
          and(
            eq(authAccount.userId, userID),
            eq(authAccount.providerId, "credential"),
            isNotNull(authAccount.password),
          ),
        );
      return {
        available:
          Boolean(credential) &&
          !(identity.policy.companySignIn && userID !== emergencyAdministratorID),
      };
    },
    async changePassword(
      userID: string,
      sessionID: string,
      input: z.output<typeof passwordChangeInput>,
    ) {
      try {
        await identity.changePassword(userID, sessionID, input);
      } catch (cause) {
        if (cause instanceof PasswordChangeError)
          throw new CommandError(
            cause.kind === "unavailable"
              ? "forbidden"
              : cause.kind === "locked"
                ? "conflict"
                : "invalid",
            cause.message,
          );
        throw cause;
      }
      await options.revokeAccount(userID, false);
    },
    async signOutDestination() {
      return {
        forgeLogoutURL: options.forgeOrigin
          ? new URL("/assets/factory-sign-out.html", options.forgeOrigin).href
          : null,
      };
    },
    async endOwnSessions(userID: string) {
      await accounts.endSessions(userID, userID);
      await options.revokeAccount(userID, false);
    },
    async users(userID: string) {
      await access.requireSystemManager(userID);
      const users = await database.db
        .select({
          id: authUser.id,
          name: authUser.name,
          email: authUser.email,
          disabled: query<boolean>`${accountAccess.disabledAt} IS NOT NULL`,
          directoryDisabled: query<boolean>`${accountAccess.directoryDisabledAt} IS NOT NULL`,
          systemManager: query<boolean>`${exists(
            database.db
              .select({ userId: administrator.userId })
              .from(administrator)
              .where(eq(administrator.userId, authUser.id)),
          )}`,
        })
        .from(authUser)
        .innerJoin(accountAccess, eq(accountAccess.userId, authUser.id))
        .orderBy(asc(authUser.name), asc(authUser.id));
      return {
        users: users.map((user) => ({
          ...user,
          emergency: user.id === emergencyAdministratorID,
        })),
      };
    },
    async createUser(userID: string, input: z.output<typeof managedUserInput>) {
      await access.requireSystemManager(userID);
      if (identity.policy.companySignIn)
        throw new CommandError("forbidden", "Accounts are provisioned through company sign-in");
      try {
        const created = await identity.createManagedUser(input);
        if (!created)
          throw new CommandError("unavailable", "Account creation outcome is unconfirmed");
        return created;
      } catch (cause) {
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505")
          throw new CommandError("conflict", "An account with that email already exists");
        throw cause;
      }
    },
    async setAccountAccess(actorID: string, userID: string, disabled: boolean) {
      await access.requireSystemManager(actorID);
      await accounts.disable(actorID, userID, disabled);
      await options.revokeAccount(userID, disabled);
    },
    async endAccountSessions(actorID: string, userID: string) {
      await access.requireSystemManager(actorID);
      await accounts.endSessions(actorID, userID);
      await options.revokeAccount(userID, false);
    },
    async members(userID: string, projectID: string) {
      await access.requireProject(userID, projectID, true);
      const members = await database.db
        .select({
          userId: projectMembership.userId,
          role: projectMembership.role,
          manageProject: projectMembership.manageProject,
          name: authUser.name,
          email: authUser.email,
        })
        .from(projectMembership)
        .innerJoin(authUser, eq(authUser.id, projectMembership.userId))
        .where(eq(projectMembership.projectId, projectID))
        .orderBy(asc(authUser.name), asc(authUser.id));
      return { members };
    },
    async setMember(userID: string, projectID: string, input: z.output<typeof memberInput>) {
      await access.requireProject(userID, projectID, true);
      const saved = await memberships.change({ projectID, actorID: userID, target: input });
      if (saved) await options.revokeMember(projectID, saved.userId);
      return saved;
    },
    async removeMember(userID: string, projectID: string, targetID: string) {
      await access.requireProject(userID, projectID, true);
      await memberships.change({ projectID, actorID: userID, target: { userID: targetID } });
      await options.revokeMember(projectID, targetID);
    },
    async identityConfiguration(userID: string) {
      await access.requireSystemManager(userID);
      return identity.view(userID);
    },
    async saveIdentity(userID: string, input: Parameters<typeof identity.save>[1]) {
      await access.requireSystemManager(userID);
      return identity.save(userID, input);
    },
    async activateIdentity(userID: string, commandID: string) {
      await access.requireSystemManager(userID);
      return identity.activate(userID, commandID);
    },
  };
}
