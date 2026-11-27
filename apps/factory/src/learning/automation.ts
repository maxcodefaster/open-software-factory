import { CommandError } from "../command-error";
import { admitTrial } from "./automation-adoption";
import { expireStaleTrials, queryCandidateRows } from "./automation-candidates";
import { executeTrial } from "./automation-trials";
import {
  type AutomationDependencies,
  type LearningDatabase,
  parseCandidateRow,
} from "./automation-types";
import { createLearningTargets } from "./targets";

export function createLearningAutomation(
  database: LearningDatabase,
  dependencies: AutomationDependencies,
) {
  const targets = createLearningTargets(database);
  let closed = false;
  const running = new Set<AbortController>();
  let cursor = "";

  return {
    async sweep() {
      if (closed) return false;
      await expireStaleTrials(database);
      const rows = await queryCandidateRows(database, cursor);
      if (!rows.length) {
        cursor = "";
        return false;
      }
      for (const rawRow of rows) {
        cursor = rawRow.proposalId;
        if (closed) break;
        const row = parseCandidateRow(rawRow);
        if (!row) continue;
        try {
          const admitted = await admitTrial(database, targets, dependencies, row);
          if (admitted) {
            await executeTrial(database, targets, dependencies, running, admitted);
            return true;
          }
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
        }
      }
      return false;
    },
    close() {
      closed = true;
      for (const item of running) item.abort();
    },
  };
}
