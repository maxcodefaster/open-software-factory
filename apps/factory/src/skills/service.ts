import type { z } from "zod";
import type { libraryCoverInput } from "../../../../packages/conversation-domain/src/library-covers";
import {
  type skillChoiceInput,
  type skillLibrarySaveInput,
  skillLibraryView,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillRole,
  skillInvocationViewInput,
} from "../../../../packages/conversation-domain/src/skills";
import { type createAccessController } from "../access/api";
import { CommandError } from "../command-error";
import type { repositorySkillImportInput, skillImportInput, skillShareInput } from "./commands";
import type { createSkillController } from "./controller";

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
    cover(userID: string, input: z.output<typeof libraryCoverInput>) {
      return skills.library.cover(input, userID);
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
    async setPublication(userID: string, id: string, published: boolean) {
      await access.requireSystemManager(userID);
      return skills.setPublication(id, published, userID);
    },
  };
}
