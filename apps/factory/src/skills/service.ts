import type { z } from "zod";
import type { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import type { createSkillController } from "./controller";
import type { repositorySkillImportInput, skillImportInput, skillShareInput } from "./commands";
import {
  skillLibraryView,
  type skillLibrarySaveInput,
  type skillChoiceInput,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  skillInvocationViewInput,
  type SkillRole,
  type skillPublishInput,
  type systemSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skills";
import type {
  personalSkillSettingsInput,
  projectSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skill-inheritance";

export function createSkillService(
  skills: ReturnType<typeof createSkillController>,
  access: Pick<
    ReturnType<typeof createAccessController>,
    "requireProject" | "requireSystemManager"
  >,
) {
  async function project(userID: string, projectID?: string) {
    if (projectID) await access.requireProject(userID, projectID);
  }
  async function preview(userID: string, input: unknown, repository: boolean) {
    try {
      return await skills.library.preview(input, userID, repository);
    } catch (cause) {
      if (cause instanceof CommandError) throw cause;
      throw new CommandError(
        "invalid",
        cause instanceof Error ? cause.message : "Could not preview this package",
      );
    }
  }
  return {
    async library(userID: string, projectID?: string) {
      // SQL RowLists must not escape into the native serializer.
      return skillLibraryView.parse(await skills.getLibrary(userID, projectID));
    },
    async invocations(userID: string, projectID: string, role: SkillRole, changeID?: string) {
      await project(userID, projectID);
      return skillInvocationViewInput.parse(
        await skills.invocations(projectID, userID, role, changeID),
      );
    },
    previewImport(userID: string, input: z.output<typeof skillImportInput>) {
      return preview(userID, input, false);
    },
    previewRepository(userID: string, input: z.output<typeof repositorySkillImportInput>) {
      return preview(userID, input, true);
    },
    save(userID: string, input: z.output<typeof skillLibrarySaveInput>) {
      return skills.library.save(input, userID);
    },
    choose(userID: string, input: z.output<typeof skillChoiceInput>) {
      return skills.chooseLibrary(input, userID, input.projectId);
    },
    propose(userID: string, input: z.output<typeof skillShareInput>) {
      return skills.library.propose(
        input.id,
        input.revisionId,
        input.target,
        input.projectId,
        userID,
      );
    },
    accept(userID: string, id: string) {
      return skills.library.accept(id, userID);
    },
    revision(userID: string, id: string, projectID?: string) {
      return skills.library.inspect(id, userID, projectID);
    },
    sourceUpdate(userID: string, id: string, projectID?: string) {
      return skills.library.checkSource(id, userID, projectID);
    },
    async inherited(userID: string, projectID: string) {
      await project(userID, projectID);
      return skills.getInherited(projectID, userID);
    },
    async saveProject(
      userID: string,
      projectID: string,
      input: z.output<typeof projectSkillSettingsInput>,
    ) {
      await project(userID, projectID);
      return skills.setProject(projectID, userID, input);
    },
    async savePersonal(
      userID: string,
      projectID: string,
      input: z.output<typeof personalSkillSettingsInput>,
    ) {
      await project(userID, projectID);
      return skills.setPersonal(projectID, userID, input);
    },
    async system(userID: string) {
      await access.requireSystemManager(userID);
      return skills.getSystem(userID);
    },
    async publish(userID: string, input: z.output<typeof skillPublishInput>) {
      await access.requireSystemManager(userID);
      const revision = await skills.publish(input, userID);
      if (!revision)
        throw new CommandError("unavailable", "Skill publication outcome is unconfirmed");
      return revision;
    },
    async saveSystem(userID: string, input: z.output<typeof systemSkillSettingsInput>) {
      await access.requireSystemManager(userID);
      return skills.setSystem(input, userID);
    },
    async setPublication(userID: string, id: string, published: boolean) {
      await access.requireSystemManager(userID);
      return skills.setPublication(id, published, userID);
    },
  };
}
