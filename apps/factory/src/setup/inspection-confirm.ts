import { drizzleTransaction } from "#db/client";
import type { createForgejoClient } from "#forge/forge";
import {
  type SetupInspectionView,
  setupFeedbackKey,
  setupInspectionOutput,
} from "#project-domain/setup";
import type { createAccessController } from "../access/api";
import { CommandError } from "../command-error";
import {
  type Database,
  type InspectionDb,
  loadInspectionRow,
  transitionInspectionToConfirmed,
  transitionInspectionToConfirmingIn,
  transitionInspectionToSuperseded,
} from "./inspection-store";

export type InspectionProject = {
  url: string;
  branch: string;
  repository: { owner: string; name: string };
};

export async function validateAndSupersedeParentIn(
  tx: InspectionDb,
  projectID: string,
  headSha: string,
  command: { parentID: string; answers: Record<string, string> },
): Promise<void> {
  const parent = await loadInspectionRow(tx, command.parentID, true);
  if (!parent || parent.projectID !== projectID || !["proposal", "failed"].includes(parent.state))
    throw new CommandError("conflict", "The setup question changed");
  // A failed inspection retained no proposal. A changed default branch is the usual
  // reason to retry, so only a proposal or open questions are bound to their commit.
  if (parent.sourceCommit !== headSha && parent.state !== "failed")
    throw new CommandError("conflict", "Source changed. Inspect the current configuration again.");
  if (parent.state === "failed") {
    if (Object.keys(command.answers).length)
      throw new CommandError("conflict", "Retry keeps the confirmed answers unchanged");
    return;
  }
  const output = setupInspectionOutput.parse(parent.output);
  const refining = output.files.length > 0 && !output.questions.length;
  if (
    (refining && !command.answers[setupFeedbackKey]) ||
    output.questions.some((question) => !command.answers[question.id]) ||
    Object.keys(command.answers).some(
      (key) =>
        !(refining && key === setupFeedbackKey) &&
        !output.questions.some((question) => question.id === key),
    )
  ) {
    throw new CommandError(
      "conflict",
      refining
        ? "Describe the required configuration changes before continuing"
        : "Answer the current setup questions before continuing",
    );
  }
  await transitionInspectionToSuperseded(tx, parent.id, ["proposal"], false);
}

export function createSetupInspectionConfirmer(deps: {
  database: Database;
  forge: ReturnType<typeof createForgejoClient>;
  access: ReturnType<typeof createAccessController>;
  loadProject(projectID: string, userID: string): Promise<InspectionProject>;
  view(projectID: string, userID: string): Promise<SetupInspectionView | null>;
  ready(projectID: string, userID: string): Promise<void>;
}) {
  const sql = deps.database.client;
  const db = deps.database.db;

  return async function confirm(projectID: string, userID: string, id: string) {
    const current = await deps.loadProject(projectID, userID);
    const connection = await sql.reserve();
    try {
      const [lock] = await connection<
        { held: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext(${`setup-confirm:${id}`})) AS held`;
      if (!lock?.held) throw new CommandError("conflict", "Confirmation is already running");
      try {
        const value = await loadInspectionRow(db, id);
        if (
          !value ||
          value.projectID !== projectID ||
          !["proposal", "confirming", "confirmed"].includes(value.state)
        )
          throw new CommandError("conflict", "Setup proposal is unavailable");
        if (value.state === "confirmed") return deps.view(projectID, userID);
        const output = setupInspectionOutput.parse(value.output);
        if (output.questions.length || !output.files.length)
          throw new CommandError("conflict", "Answer the remaining setup questions first");
        const head = await deps.forge.getDefaultBranch(current.repository);
        await deps.forge.ensureDefaultBranchProtection(current.repository, current.branch, false);
        const branchName = `factory/setup-${id}`;
        if (value.state === "proposal" && head.headSha !== value.sourceCommit) {
          throw new CommandError(
            "conflict",
            "Source changed. Inspect its current configuration again before confirming",
          );
        }
        await sql.begin(async (transaction) => {
          await transitionInspectionToConfirmingIn(
            drizzleTransaction(transaction),
            id,
            projectID,
            userID,
          );
        });
        const commit = await deps.forge.applySetupFiles({
          repository: current.repository,
          branch: branchName,
          baseCommit: value.sourceCommit,
          files: output.files,
          proposalID: id,
        });
        await deps.access.requireProject(userID, projectID, true);
        const observed = await deps.forge.getDefaultBranch(current.repository);
        if (observed.headSha !== value.sourceCommit && observed.headSha !== commit) {
          throw new CommandError(
            "conflict",
            "Main branch changed; confirmed files were not merged",
          );
        }
        if (observed.headSha !== commit) {
          const pull = await deps.forge.ensurePullRequest({
            repository: current.repository,
            baseBranch: current.branch,
            headBranch: branchName,
            expectedHeadSha: commit,
            title: "Configure Project for Factory",
            body: "Exact human-confirmed Project setup. No application code changes.",
          });
          if (pull.baseSha !== value.sourceCommit)
            throw new CommandError("conflict", "Main branch changed before setup merge");
          const merge = output.files.some(
            (file) => file.path === ".forgejo/workflows/factory-verification.yml",
          )
            ? () =>
                deps.forge.mergeInitialSetupWorkflow(
                  current.repository,
                  pull.number,
                  commit,
                  current.branch,
                  value.sourceCommit,
                )
            : () =>
                deps.forge.mergeFastForward(
                  current.repository,
                  pull.number,
                  commit,
                  current.branch,
                );
          await merge();
        }
        await deps.forge.protectSetupWorkflow(current.repository, current.branch);
        await transitionInspectionToConfirmed(db, id);
        await deps.ready(projectID, userID);
        return deps.view(projectID, userID);
      } finally {
        await connection`SELECT pg_advisory_unlock(hashtext(${`setup-confirm:${id}`}))`;
      }
    } finally {
      connection.release();
    }
  };
}
