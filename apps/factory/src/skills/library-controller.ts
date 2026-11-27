import type { SkillRevision } from "#conversation-domain/skills";
import type { createDatabase, DatabaseTransaction } from "#db/client";
import {
  acceptSkillSharingIn,
  chooseSkillIn,
  proposeSkillSharingIn,
  saveSkillCoverIn,
  saveSkillIn,
} from "./library-controller-mutations";
import {
  checkSkillSourceForUser,
  inspectSkillRevisionIn,
  previewSkillForUser,
  viewSkillLibraryIn,
} from "./library-controller-queries";
import { lockSkillsIn, seedStarterSkillsIn, skillCapabilitiesIn } from "./library-controller-store";

export function createSkillLibraryController(database: ReturnType<typeof createDatabase>) {
  return {
    async checkSource(revisionId: string, userId: string, projectId?: string) {
      return checkSkillSourceForUser(database, revisionId, userId, projectId);
    },
    async preview(value: unknown, userId: string, repository = false) {
      return previewSkillForUser(database, value, userId, repository);
    },
    async viewIn(sql: DatabaseTransaction, userId: string, projectId?: string) {
      await lockSkillsIn(sql);
      await skillCapabilitiesIn(sql, userId, projectId);
      await seedStarterSkillsIn(sql, userId);
      return viewSkillLibraryIn(sql, userId, projectId);
    },
    async saveIn(sql: DatabaseTransaction, value: unknown, userId: string) {
      return saveSkillIn(sql, value, userId);
    },
    async save(value: unknown, userId: string) {
      return database.client.begin((sql) => saveSkillIn(sql, value, userId));
    },
    async cover(value: unknown, userId: string) {
      return database.client.begin((sql) => saveSkillCoverIn(sql, value, userId));
    },
    async chooseIn(sql: DatabaseTransaction, value: unknown, userId: string) {
      return chooseSkillIn(sql, value, userId);
    },
    async choose(value: unknown, userId: string) {
      return database.client.begin((sql) => chooseSkillIn(sql, value, userId));
    },
    async propose(
      id: string,
      revisionId: string,
      target: "project" | "system",
      projectId: string | undefined,
      userId: string,
    ) {
      return database.client.begin((sql) =>
        proposeSkillSharingIn(sql, id, revisionId, target, projectId, userId),
      );
    },
    async accept(proposalId: string, userId: string) {
      return database.client.begin((sql) => acceptSkillSharingIn(sql, proposalId, userId));
    },
    async inspect(revisionId: string, userId: string, projectId?: string): Promise<SkillRevision> {
      return database.client.begin((sql) =>
        inspectSkillRevisionIn(sql, revisionId, userId, projectId),
      );
    },
  };
}
