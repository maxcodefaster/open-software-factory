import { z } from "zod";
import { identityConfigurationWrite } from "../../../../packages/identity-domain/src/configuration";
import { managedUserInput, memberInput } from "../access/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getSecurityPolicy() {
  "use server";
  return factoryFunction(async () => factoryFunctionContext().access.policy());
}

export async function getAuthenticationState() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.access.authentication(context.actorID, await context.isFresh());
  });
}

export async function getSignOutDestination() {
  "use server";
  return factoryFunction(async () => factoryFunctionContext().access.signOutDestination());
}

export async function endOwnSessions() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    await context.access.endOwnSessions(context.actorID);
  });
}

export async function getAccounts() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.access.users(context.actorID);
  });
}

export async function createAccount(input: z.input<typeof managedUserInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = managedUserInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    return context.access.createUser(context.actorID, command);
  });
}

export async function setAccountAccess(userID: string, disabled: boolean) {
  "use server";
  return factoryFunction(async () => {
    const user = z.uuid().parse(userID);
    const value = z.boolean().parse(disabled);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    await context.access.setAccountAccess(context.actorID, user, value);
  });
}

export async function endAccountSessions(userID: string) {
  "use server";
  return factoryFunction(async () => {
    const user = z.uuid().parse(userID);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    await context.access.endAccountSessions(context.actorID, user);
  });
}

export async function getProjectMembers(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    return context.access.members(context.actorID, project);
  });
}

export async function saveProjectMember(projectID: string, input: z.input<typeof memberInput>) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const command = memberInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    return context.access.setMember(context.actorID, project, command);
  });
}

export async function removeProjectMember(projectID: string, userID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const user = z.uuid().parse(userID);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    await context.access.removeMember(context.actorID, project, user);
  });
}

export async function getIdentityConfiguration() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.access.identityConfiguration(context.actorID);
  });
}

export async function saveIdentityConfiguration(input: z.input<typeof identityConfigurationWrite>) {
  "use server";
  return factoryFunction(async () => {
    const command = identityConfigurationWrite.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    return context.access.saveIdentity(context.actorID, command);
  });
}

export async function activateIdentityConfiguration(commandID: string) {
  "use server";
  return factoryFunction(async () => {
    const command = z.uuid().parse(commandID);
    const context = factoryFunctionContext();
    await context.beforeWrite(true);
    return context.access.activateIdentity(context.actorID, command);
  });
}
