import { z } from "zod";
import type { DatabaseTransaction, createDatabase } from "../../../../packages/db/src/client";
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
    await database.client`UPDATE factory.change_commit_operation
      SET state='push-intended',commit_sha=${commitSHA},updated_at=now()
      WHERE id=${candidate.id} AND state='commit-intended'`;
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
  await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,integration_base_sha,
    commit_message,idempotency_key,state,created_by,source)
    VALUES(${intent.id},${intent.changeID},${intent.attemptID},(SELECT COALESCE(max(sequence),0)+1 FROM factory.change_commit_operation WHERE change_id=${intent.changeID}),
      ${intent.branch},${intent.expectedHead},${intent.base},${intent.message},${`workspace:${intent.id}`},'commit-intended',${intent.actorID},'workspace')`;
  await sql`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,turn_id=NULL,epoch=epoch+1,updated_at=now() WHERE change_id=${intent.changeID}`;
  await sql`INSERT INTO factory.workspace_submission(id,workspace_id,actor_id,writer_epoch,remote_head,repository_url)
    VALUES(${intent.id},${intent.workspaceID},${intent.actorID},${intent.writerEpoch}::bigint+1,${intent.remoteHead},${intent.repositoryURL})`;
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
          await sql`UPDATE factory.change_commit_operation SET observed_remote_sha=${prepared.commitSHA},state='succeeded',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=${prepared.id} AND state='push-intended'`;
          // Keep historical Turn and Session state while recording the external receipt.
          if (writer.available && writer.state === "unassigned" && writer.epoch === prepared.epoch)
            await sql`UPDATE factory.change SET state='active',failure=NULL,version=version+1
              WHERE id=${prepared.changeID} AND runtime_attempt_id=${prepared.attemptID} AND state IN ('starting','failed')`;
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
        const [failed] = await sql<
          { id: string }[]
        >`UPDATE factory.change_commit_operation SET state='failed',last_error=${message},completed_at=now(),updated_at=now()
          WHERE id=${candidate.id} AND state='commit-intended' RETURNING id`;
        if (failed && writer.state === "unassigned" && writer.epoch === candidate.epoch)
          await sql`UPDATE factory.change_writer SET state='human',user_id=${candidate.actorID},epoch=epoch+1,updated_at=now() WHERE change_id=${candidate.changeID}`;
      });
    throw cause;
  }
}
