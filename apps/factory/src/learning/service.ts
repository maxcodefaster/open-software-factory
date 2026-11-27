import type { LearningDatabase } from "./command-ledger";
import { requestReviewNow, setLearningPolicy } from "./policy-commands";
import { decideLearningProposal, rollbackLearningApplication } from "./proposal-commands";
import { createLearningTargets } from "./targets";
import { loadLearningView } from "./view-query";

export function createLearningService(database: LearningDatabase) {
  const targets = createLearningTargets(database);
  return {
    get(userId: string, projectId: string | null, personal = false) {
      return loadLearningView(database, targets, userId, projectId, personal);
    },
    set(userId: string, raw: unknown) {
      return setLearningPolicy(database, userId, raw);
    },
    reviewNow(userId: string, raw: unknown) {
      return requestReviewNow(database, userId, raw);
    },
    decide(userId: string, raw: unknown) {
      return decideLearningProposal(database, targets, userId, raw);
    },
    rollback(userId: string, raw: unknown) {
      return rollbackLearningApplication(database, targets, userId, raw);
    },
  };
}
