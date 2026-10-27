import { createServerFn } from "@tanstack/solid-start";
import { z } from "zod";
import { libraryCoverInput } from "../../../../packages/conversation-domain/src/library-covers";
import {
  personalSkillSettingsInput,
  projectSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skill-inheritance";
import {
  skillChoiceInput,
  skillLibrarySaveInput,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillRole,
  skillPublishInput,
  skillRoleInput,
  systemSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skills";
import { repositorySkillImportInput, skillImportInput, skillShareInput } from "../skills/commands";
import { factoryFunction, factoryFunctionContext } from "./context";

export const getSkillLibrary = createServerFn({ method: "POST", strict: { input: false } })
  .validator((args: [projectID?: string | undefined]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().optional().parse(projectID);
      const context = factoryFunctionContext();
      return context.skills.library(context.actorID, project);
    });
  });
export const getSkillInvocations = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, role: SkillRole, changeID?: string | undefined]) => args)
  .handler(async ({ data: [projectID, role, changeID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const workType = skillRoleInput.parse(role);
      const change = z.uuid().optional().parse(changeID);
      const context = factoryFunctionContext();
      return context.skills.invocations(context.actorID, project, workType, change);
    });
  });
export const previewSkillImport = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof skillImportInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = skillImportInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.previewImport(context.actorID, command);
    });
  });
export const previewRepositorySkill = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof repositorySkillImportInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = repositorySkillImportInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.previewRepository(context.actorID, command);
    });
  });
export const saveSkill = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof skillLibrarySaveInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = skillLibrarySaveInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.save(context.actorID, command);
    });
  });
export const saveSkillCover = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof libraryCoverInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = libraryCoverInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.cover(context.actorID, command);
    });
  });
export const saveSkillChoice = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof skillChoiceInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = skillChoiceInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.choose(context.actorID, command);
    });
  });
export const proposeSkillSharing = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof skillShareInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = skillShareInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.propose(context.actorID, command);
    });
  });
export const acceptSkillSharing = createServerFn({ method: "POST" })
  .validator((args: [id: string]) => args)
  .handler(async ({ data: [id] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.accept(context.actorID, identity);
    });
  });
export const getSkillRevision = createServerFn({ method: "POST" })
  .validator((args: [id: string, projectID?: string | undefined]) => args)
  .handler(async ({ data: [id, projectID] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const project = z.uuid().optional().parse(projectID);
      const context = factoryFunctionContext();
      return context.skills.revision(context.actorID, identity, project);
    });
  });
export const checkSkillSourceUpdate = createServerFn({ method: "POST" })
  .validator((args: [id: string, projectID?: string | undefined]) => args)
  .handler(async ({ data: [id, projectID] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const project = z.uuid().optional().parse(projectID);
      const context = factoryFunctionContext();
      return context.skills.sourceUpdate(context.actorID, identity, project);
    });
  });
export const getInheritedSkills = createServerFn({ method: "POST" })
  .validator((args: [projectID: string]) => args)
  .handler(async ({ data: [projectID] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const context = factoryFunctionContext();
      return context.skills.inherited(context.actorID, project);
    });
  });
export const saveProjectSkills = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof projectSkillSettingsInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const command = projectSkillSettingsInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.saveProject(context.actorID, project, command);
    });
  });
export const savePersonalSkills = createServerFn({ method: "POST" })
  .validator((args: [projectID: string, input: z.input<typeof personalSkillSettingsInput>]) => args)
  .handler(async ({ data: [projectID, input] }) => {
    return factoryFunction(async () => {
      const project = z.uuid().parse(projectID);
      const command = personalSkillSettingsInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.savePersonal(context.actorID, project, command);
    });
  });
export const getSystemSkills = createServerFn({ method: "POST" })
  .validator((args: never[]) => args)
  .handler(async () => {
    return factoryFunction(async () => {
      const context = factoryFunctionContext();
      return context.skills.system(context.actorID);
    });
  });
export const publishSkill = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof skillPublishInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = skillPublishInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.publish(context.actorID, command);
    });
  });
export const saveSystemSkills = createServerFn({ method: "POST" })
  .validator((args: [input: z.input<typeof systemSkillSettingsInput>]) => args)
  .handler(async ({ data: [input] }) => {
    return factoryFunction(async () => {
      const command = systemSkillSettingsInput.parse(input);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.saveSystem(context.actorID, command);
    });
  });
export const setSkillPublication = createServerFn({ method: "POST" })
  .validator((args: [id: string, published: boolean]) => args)
  .handler(async ({ data: [id, published] }) => {
    return factoryFunction(async () => {
      const identity = z.uuid().parse(id);
      const state = z.boolean().parse(published);
      const context = factoryFunctionContext();
      await context.beforeWrite(false);
      return context.skills.setPublication(context.actorID, identity, state);
    });
  });
