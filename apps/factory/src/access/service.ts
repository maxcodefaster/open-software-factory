import type { z } from "zod";
import { emergencyAdministratorID } from "../../../../packages/auth/src/policy";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { ProjectRole } from "../../../../packages/project-domain/src/access";
import { CommandError } from "../command-error";
import { createAccountCommands } from "./accounts";
import type { createIdentityConfiguration } from "./identity-configuration";
import { createAccessController } from "./controller";
import { createMembershipCommands } from "./membership";
import type { managedUserInput, memberInput } from "./commands";

export function createAccessService(options: {
  database: ReturnType<typeof createDatabase>;
  identity: Pick<
    ReturnType<typeof createIdentityConfiguration>,
    "policy" | "createManagedUser" | "view" | "save" | "activate"
  >;
  revokeMember(projectID: string, userID: string): Promise<void>;
  revokeAccount(userID: string, disabled: boolean): Promise<void>;
  forgeOrigin: string | undefined;
}) {
  const { database, identity } = options;
  const access = createAccessController(database);
  const memberships = createMembershipCommands(database);
  const accounts = createAccountCommands(database);
  return {
    async policy() {
      return { ...identity.policy };
    },
    async authentication(userID: string, fresh: boolean) {
      const [person] = await database.client<
        { email: string }[]
      >`SELECT email FROM auth."user" WHERE id=${userID}`;
      return {
        fresh,
        email: person?.email ?? "",
        companySignIn: identity.policy.companySignIn && userID !== emergencyAdministratorID,
      };
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
      const users = await database.client<
        Array<{
          id: string;
          name: string;
          email: string;
          disabled: boolean;
          directoryDisabled: boolean;
          systemManager: boolean;
        }>
      >`SELECT auth."user".id, name, email,
        (access.disabled_at IS NOT NULL) AS disabled,
        (access.directory_disabled_at IS NOT NULL) AS "directoryDisabled",
        EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = auth."user".id) AS "systemManager"
        FROM auth."user" JOIN factory.account_access access ON access.user_id=auth."user".id ORDER BY name, auth."user".id`;
      return { users: [...users] };
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
      const rows = await database.client<
        Array<{
          userId: string;
          role: ProjectRole;
          manageProject: boolean;
          name: string;
          email: string;
        }>
      >`SELECT member.user_id AS "userId", member.role, member.manage_project AS "manageProject", user_row.name, user_row.email
        FROM factory.project_membership member JOIN auth."user" user_row ON user_row.id = member.user_id
        WHERE member.project_id = ${projectID} ORDER BY user_row.name, user_row.id`;
      return { members: [...rows] };
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
