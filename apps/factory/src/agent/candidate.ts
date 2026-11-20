import { and, eq, inArray, sql as query } from "drizzle-orm";
import { z } from "zod";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  change,
  changeCommitOperation,
  changeWriter,
  workspaceSubmission,
} from "../../../../packages/db/src/schema";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { forgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { lockChangeWriterIn } from "../access/change-writer";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;
type CandidateCommit = {
  id: string;
  changeID: string;
  attemptID: string;
  state: string;
  commitSHA: string | null;
};
type PreparedCandidate = CandidateCommit & { commitSHA: string };
type CandidateAction = "git-prepare-commit" | "git-observe-commit" | "git-push";
export type WorkspaceCandidate = CandidateCommit & {
  branch: string;
  expectedHead: string;
  remoteHead: string;
  message: string;
  repositoryURL: string;
  actorID: string;
  epoch: string;
  attempted: boolean;
};

export const noChangesToSubmit = "This turn changed no files, so there is nothing new to submit.";
export const earlierSubmissionUnchanged = " The earlier submission is unchanged.";

// Shared progression accepts the source-specific dispatch and publication callbacks.
export async function advanceCandidateCommit<T extends CandidateCommit>(
  database: Database,
  candidate: T,
  prepare: () => Promise<{ commitSHA?: string }>,
  push: (prepared: T & PreparedCandidate) => Promise<{ remoteSHA?: string }>,
  publish: (prepared: T & PreparedCandidate) => Promise<void>,
) {
  if (candidate.state === "succeeded" || candidate.state === "failed") return;
  let commitSHA = candidate.commitSHA;
  if (candidate.state === "commit-intended") {
    const prepared = await prepare();
    if (!prepared.commitSHA) throw new Error("Runtime returned no commit identity");
    commitSHA = prepared.commitSHA;
    await database.db
      .update(changeCommitOperation)
      .set({
        state: "push-intended",
        commitSha: commitSHA,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(changeCommitOperation.id, candidate.id),
          eq(changeCommitOperation.state, "commit-intended"),
        ),
      );
  }
  if (!commitSHA) throw new Error("Commit identity is missing");
  const prepared = { ...candidate, state: "push-intended", commitSHA };
  const pushed = await push(prepared);
  if (pushed.remoteSHA !== commitSHA) throw new Error("Remote commit was not confirmed");
  await publish(prepared);
}

export async function recordWorkspaceCandidateIn(
  sql: DatabaseTransaction,
  intent: {
    id: string;
    changeID: string;
    attemptID: string;
    workspaceID: string;
    actorID: string;
    branch: string;
    base: string;
    expectedHead: string;
    remoteHead: string;
    message: string;
    repositoryURL: string;
    writerEpoch: string;
  },
) {
  const db = drizzleTransaction(sql);
  await db.insert(changeCommitOperation).values({
    id: intent.id,
    changeId: intent.changeID,
    runtimeAttemptId: intent.attemptID,
    sequence: query`(${db
      .select({ sequence: query<number>`COALESCE(max(${changeCommitOperation.sequence}),0)+1` })
      .from(changeCommitOperation)
      .where(eq(changeCommitOperation.changeId, intent.changeID))})`,
    branchName: intent.branch,
    expectedParentSha: intent.expectedHead,
    integrationBaseSha: intent.base,
    commitMessage: intent.message,
    idempotencyKey: `workspace:${intent.id}`,
    state: "commit-intended",
    createdBy: intent.actorID,
    source: "workspace",
  });
  await db
    .update(changeWriter)
    .set({
      state: "unassigned",
      userId: null,
      turnId: null,
      epoch: query`${changeWriter.epoch}+1`,
      updatedAt: query`now()`,
    })
    .where(eq(changeWriter.changeId, intent.changeID));
  await db.insert(workspaceSubmission).values({
    id: intent.id,
    workspaceId: intent.workspaceID,
    actorId: intent.actorID,
    writerEpoch: query`${intent.writerEpoch}::bigint+1`,
    remoteHead: intent.remoteHead,
    repositoryUrl: intent.repositoryURL,
  });
}

export async function submitWorkspaceCandidate<T extends WorkspaceCandidate>(
  database: Database,
  candidate: T,
  invoke: (candidate: T, action: CandidateAction) => Promise<{ commitSHA?: string }>,
  forge: Pick<ReturnType<typeof createForgejoClient>, "getBranch">,
) {
  try {
    await advanceCandidateCommit(
      database,
      candidate,
      async () => {
        const prepared = await invoke(
          candidate,
          candidate.attempted ? "git-observe-commit" : "git-prepare-commit",
        );
        return {
          commitSHA: z
            .string()
            .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
            .parse(prepared.commitSHA),
        };
      },
      async (prepared) => {
        const repository = forgeRepositoryFromURL(prepared.repositoryURL);
        let remote = await forge.getBranch(repository, prepared.branch);
        if (remote?.headSha !== prepared.commitSHA) {
          if (remote?.headSha !== prepared.remoteHead)
            throw new CommandError(
              "conflict",
              "Ticket branch changed outside this submission. Nothing was force-pushed.",
            );
          await invoke(prepared, "git-push");
          remote = await forge.getBranch(repository, prepared.branch);
        }
        if (remote?.headSha !== prepared.commitSHA)
          throw new CommandError(
            "unavailable",
            "Exact submitted commit is not confirmed on the Ticket branch",
          );
        return { remoteSHA: remote.headSha };
      },
      async (prepared) => {
        await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, prepared.changeID);
          const db = drizzleTransaction(sql);
          await db
            .update(changeCommitOperation)
            .set({
              observedRemoteSha: prepared.commitSHA,
              state: "succeeded",
              completedAt: query`now()`,
              updatedAt: query`now()`,
              lastError: null,
            })
            .where(
              and(
                eq(changeCommitOperation.id, prepared.id),
                eq(changeCommitOperation.state, "push-intended"),
              ),
            );
          // Keep historical Turn and Session state while recording the external receipt.
          if (writer.available && writer.state === "unassigned" && writer.epoch === prepared.epoch)
            await db
              .update(change)
              .set({ state: "active", failure: null, version: query`${change.version}+1` })
              .where(
                and(
                  eq(change.id, prepared.changeID),
                  eq(change.runtimeAttemptId, prepared.attemptID),
                  inArray(change.state, ["starting", "failed"]),
                ),
              );
        });
      },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (
      [
        "workspace has no changes to commit",
        "workspace HEAD no longer matches the commit intent",
        "an ordinary commit cannot accept an unadmitted merge",
      ].includes(message)
    )
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, candidate.changeID);
        const db = drizzleTransaction(sql);
        const [failed] = await db
          .update(changeCommitOperation)
          .set({
            state: "failed",
            lastError: message,
            completedAt: query`now()`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(changeCommitOperation.id, candidate.id),
              eq(changeCommitOperation.state, "commit-intended"),
            ),
          )
          .returning({ id: changeCommitOperation.id });
        if (failed && writer.state === "unassigned" && writer.epoch === candidate.epoch)
          await db
            .update(changeWriter)
            .set({
              state: "human",
              userId: candidate.actorID,
              epoch: query`${changeWriter.epoch}+1`,
              updatedAt: query`now()`,
            })
            .where(eq(changeWriter.changeId, candidate.changeID));
      });
    throw cause;
  }
}
