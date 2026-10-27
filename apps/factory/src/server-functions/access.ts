import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { identityConfigurationWrite } from "../../../../packages/identity-domain/src/configuration";
import { managedUserInput, memberInput } from "../access/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getSecurityPolicy = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => factoryFunctionContext().access.policy());
  });

export const getAuthenticationState = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.access.authentication(context.actorID, await context.isFresh());
    });
  });

export const getSignOutDestination = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => factoryFunctionContext().access.signOutDestination());
  });

export const endOwnSessions = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      await context.access.endOwnSessions(context.actorID);
    });
  });

export const getAccounts = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.access.users(context.actorID);
    });
  });

export const createAccount = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof managedUserInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = managedUserInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.access.createUser(context.actorID, command);
    });
  });

export const setAccountAccess = createServerFn({ method: "POST" })
  .validator((args: [userID: string, disabled: boolean]) => args)
  .handler(async ({ data: [userID, disabled] }) => {
    return factoryFunction(async () => {
      const user = z.uuid().parse(userID);
      const value = z.boolean().parse(disabled);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      await context.access.setAccountAccess(context.actorID, user, value);
    });
  });

export const endAccountSessions = createServerFn({ method: "POST" })
  .validator((args: [userID: string]) => args)
  .handler(async ({ data: [userID] }) => {
    return factoryFunction(async () => {
      const user = z.uuid().parse(userID);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      await context.access.endAccountSessions(context.actorID, user);
    });
  });

export const getProjectMembers = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      return context.access.members(context.actorID, project);
    });
  });

export const saveProjectMember = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof memberInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const command = memberInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.access.setMember(context.actorID, project, command);
    });
  });

export const removeProjectMember = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, userID: string]) => args)
  .handler(async ({ data: [projectID, userID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const user = z.uuid().parse(userID);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      await context.access.removeMember(context.actorID, project, user);
    });
  });

export const getIdentityConfiguration = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.access.identityConfiguration(context.actorID);
    });
  });

export const saveIdentityConfiguration = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof identityConfigurationWrite>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = identityConfigurationWrite.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.access.saveIdentity(context.actorID, command);
    });
  });

export const activateIdentityConfiguration = createServerFn({ method: "POST" })
  .validator((args: [commandID: string]) => args)
  .handler(async ({ data: [commandID] }) => {
    return factoryFunction(async () => {
      const command = z.uuid().parse(commandID);
      const context = factoryFunctionContext();
      await context.beforeWrite(true);
      return context.access.activateIdentity(context.actorID, command);
    });
  });
