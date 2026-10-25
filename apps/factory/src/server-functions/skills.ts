import { z } from "zod";
import {
  skillLibrarySaveInput,
  skillChoiceInput,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  skillPublishInput,
  skillRoleInput,
  systemSkillSettingsInput,
  type SkillRole,
} from "../../../../packages/conversation-domain/src/skills";
import {
  projectSkillSettingsInput,
  personalSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skill-inheritance";
import { skillImportInput, repositorySkillImportInput, skillShareInput } from "../skills/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export async function getSkillLibrary(projectID?: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().optional().parse(projectID);
    const context = factoryFunctionContext();
    return context.skills.library(context.actorID, project);
  });
}
export async function getSkillInvocations(projectID: string, role: SkillRole, changeID?: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const workType = skillRoleInput.parse(role);
    const change = z.uuid().optional().parse(changeID);
    const context = factoryFunctionContext();
    return context.skills.invocations(context.actorID, project, workType, change);
  });
}
export async function previewSkillImport(input: z.input<typeof skillImportInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = skillImportInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.previewImport(context.actorID, command);
  });
}
export async function previewRepositorySkill(input: z.input<typeof repositorySkillImportInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = repositorySkillImportInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.previewRepository(context.actorID, command);
  });
}
export async function saveSkill(input: z.input<typeof skillLibrarySaveInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = skillLibrarySaveInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.save(context.actorID, command);
  });
}
export async function saveSkillChoice(input: z.input<typeof skillChoiceInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = skillChoiceInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.choose(context.actorID, command);
  });
}
export async function proposeSkillSharing(input: z.input<typeof skillShareInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = skillShareInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.propose(context.actorID, command);
  });
}
export async function acceptSkillSharing(id: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.accept(context.actorID, identity);
  });
}
export async function getSkillRevision(id: string, projectID?: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const project = z.uuid().optional().parse(projectID);
    const context = factoryFunctionContext();
    return context.skills.revision(context.actorID, identity, project);
  });
}
export async function checkSkillSourceUpdate(id: string, projectID?: string) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const project = z.uuid().optional().parse(projectID);
    const context = factoryFunctionContext();
    return context.skills.sourceUpdate(context.actorID, identity, project);
  });
}
export async function getInheritedSkills(projectID: string) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const context = factoryFunctionContext();
    return context.skills.inherited(context.actorID, project);
  });
}
export async function saveProjectSkills(
  projectID: string,
  input: z.input<typeof projectSkillSettingsInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const command = projectSkillSettingsInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.saveProject(context.actorID, project, command);
  });
}
export async function savePersonalSkills(
  projectID: string,
  input: z.input<typeof personalSkillSettingsInput>,
) {
  "use server";
  return factoryFunction(async () => {
    const project = z.uuid().parse(projectID);
    const command = personalSkillSettingsInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.savePersonal(context.actorID, project, command);
  });
}
export async function getSystemSkills() {
  "use server";
  return factoryFunction(async () => {
    const context = factoryFunctionContext();
    return context.skills.system(context.actorID);
  });
}
export async function publishSkill(input: z.input<typeof skillPublishInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = skillPublishInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.publish(context.actorID, command);
  });
}
export async function saveSystemSkills(input: z.input<typeof systemSkillSettingsInput>) {
  "use server";
  return factoryFunction(async () => {
    const command = systemSkillSettingsInput.parse(input);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.saveSystem(context.actorID, command);
  });
}
export async function setSkillPublication(id: string, published: boolean) {
  "use server";
  return factoryFunction(async () => {
    const identity = z.uuid().parse(id);
    const state = z.boolean().parse(published);
    const context = factoryFunctionContext();
    await context.beforeWrite(false);
    return context.skills.setPublication(context.actorID, identity, state);
  });
}
