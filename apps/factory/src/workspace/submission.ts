import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { forgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { workspaceAuthorityIn } from "../access/workspace";
import { lockChangeWriterIn, workspaceWriteAuthorityIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import { runtimeRepositoryCloneURL } from "../runtime/endpoints";
import type { RuntimeHub } from "../runtime/hub";
import type { createWorkspaceCollaboration } from "./collaboration";
import { personalGitStatus } from "./personal-git";

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const workspaceSubmissionInput = z.strictObject({
  requestID: z.uuid(),
  workspaceID: z.uuid(),
  expectedHead: sha,
  expectedRemoteHead: sha,
  message: z.string().trim().min(1).max(240),
});
type Saved = {
  workspaceID: string;
  changeID: string;
  attemptID: string;
  repositoryURL: string;
  branch: string;
  base: string;
  authorName: string;
  authorEmail: string;
};
type Operation = Saved & {
  id: string;
  actorID: string;
  expectedHead: string;
  remoteHead: string;
  message: string;
  state: string;
  commitSHA: string | null;
  attempted: boolean;
  epoch: string;
};
export function createWorkspaceSubmission(
  database: ReturnType<typeof createDatabase>,
  hub: Pick<RuntimeHub, "parentOperation" | "connected">,
  collaboration: Pick<ReturnType<typeof createWorkspaceCollaboration>, "assertSaved">,
  forge: Pick<ReturnType<typeof createForgejoClient>, "getBranch">,
  credentials: { username: string; password: string },
) {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  async function scope(userID: string, workspaceID: string): Promise<Saved> {
    await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID, true));
    const [row] = await database.client<
      Saved[]
    >`SELECT workspace.id AS "workspaceID",workspace.change_id AS "changeID",change.runtime_attempt_id AS "attemptID",
      project.repository_url AS "repositoryURL",change.branch_name AS branch,change.base_sha AS base,person.name AS "authorName",person.email AS "authorEmail"
      FROM factory.development_workspace workspace JOIN factory.change change ON change.id=workspace.change_id
      JOIN factory.project project ON project.id=workspace.project_id JOIN auth."user" person ON person.id=${userID}
      WHERE workspace.id=${workspaceID} AND workspace.kind='ticket' AND change.state IN ('active','starting','failed') AND change.cancel_requested_at IS NULL`;
    if (!row || !hub.connected(row.attemptID))
      throw new CommandError(
        "conflict",
        "Start the selected Ticket Workspace before submitting saved source",
      );
    return row;
  }
  async function row(id: string) {
    const [result] = await database.client<
      Operation[]
    >`SELECT operation.id,submission.workspace_id AS "workspaceID",submission.actor_id AS "actorID",operation.change_id AS "changeID",
      operation.runtime_attempt_id AS "attemptID",project.repository_url AS "repositoryURL",operation.branch_name AS branch,operation.integration_base_sha AS base,
      operation.expected_parent_sha AS "expectedHead",submission.remote_head AS "remoteHead",operation.commit_message AS message,operation.state,operation.commit_sha AS "commitSHA",
      submission.prepare_attempted_at IS NOT NULL AS attempted,submission.writer_epoch::text AS epoch,person.name AS "authorName",person.email AS "authorEmail"
      FROM factory.workspace_submission submission JOIN factory.change_commit_operation operation ON operation.id=submission.id
      JOIN factory.change change ON change.id=operation.change_id JOIN factory.project project ON project.id=change.project_id
      JOIN auth."user" person ON person.id=submission.actor_id WHERE submission.id=${id}`;
    if (!result) throw new CommandError("not-found", "Workspace submission not found");
    return result;
  }
  const view = (op: Operation) => ({
    requestID: op.id,
    workspaceID: op.workspaceID,
    changeID: op.changeID,
    attemptID: op.attemptID,
    state: op.state,
    commitSHA: op.commitSHA,
    submittedBy: op.actorID,
  });
  function sameInput(
    op: Operation,
    userID: string,
    input: z.infer<typeof workspaceSubmissionInput>,
  ) {
    if (
      op.workspaceID !== input.workspaceID ||
      op.actorID !== userID ||
      op.expectedHead !== input.expectedHead ||
      op.remoteHead !== input.expectedRemoteHead ||
      op.message !== input.message
    )
      throw new CommandError("conflict", "Submission identity already records different input");
  }
  async function invoke(
    op: Operation,
    action: "git-prepare-commit" | "git-observe-commit" | "git-push",
  ) {
    return hub.parentOperation(
      op.attemptID,
      {
        operationId: op.id,
        action,
        expectedSha: action === "git-push" ? op.remoteHead : op.expectedHead,
        commitMessage: op.message,
        authorName: op.authorName,
        authorEmail: op.authorEmail,
        ...(action === "git-push"
          ? {
              commitSha: op.commitSHA ?? "",
              branch: op.branch,
              repositoryURL: runtimeRepositoryCloneURL(op.repositoryURL),
              username: credentials.username,
              password: credentials.password,
            }
          : {}),
      },
      async (send) => {
        await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, op.changeID);
          await workspaceAuthorityIn(sql, op.workspaceID, op.actorID, true);
          if (writer.state !== "unassigned" || writer.epoch !== op.epoch || !writer.available)
            throw new CommandError("conflict", "Shared submission authority changed");
          const [active] =
            await sql`SELECT operation.id FROM factory.change_commit_operation operation
              JOIN factory.change change ON change.id=operation.change_id
              JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
              WHERE operation.id=${op.id} AND operation.runtime_attempt_id=${op.attemptID}
                AND change.runtime_attempt_id=attempt.id AND attempt.state='ready'
                AND operation.state=${action === "git-push" ? "push-intended" : "commit-intended"}`;
          if (!active)
            throw new CommandError(
              "conflict",
              "Submission dispatch no longer matches its saved intent",
            );
          send();
        });
      },
    );
  }
  return {
    async inspect(userID: string, workspaceID: string) {
      const saved = await scope(userID, z.uuid().parse(workspaceID));
      const status = await hub.parentOperation(
        saved.attemptID,
        {
          operationId: crypto.randomUUID(),
          action: "workspace-git",
          data: JSON.stringify({ action: "status", branch: saved.branch }),
        },
        async (send) => {
          await database.client.begin(async (sql) => {
            await workspaceAuthorityIn(sql, workspaceID, userID, true);
            send();
          });
        },
      );
      const local = personalGitStatus.parse(JSON.parse(status.data ?? "null"));
      if (local.branch !== saved.branch)
        throw new CommandError("conflict", "Checkout branch differs from the Ticket branch");
      const remote = await forge.getBranch(
        forgeRepositoryFromURL(saved.repositoryURL),
        saved.branch,
      );
      if (!remote) throw new CommandError("unavailable", "Ticket branch could not be observed");
      return {
        workspaceID,
        changeID: saved.changeID,
        head: local.head,
        remoteHead: remote.headSha,
        files: local.files,
      };
    },
    async submit(userID: string, raw: z.infer<typeof workspaceSubmissionInput>) {
      if (closing) throw new CommandError("unavailable", "Factory is stopping");
      const task = (async () => {
        const input = workspaceSubmissionInput.parse(raw);
        const [recorded] =
          await database.client`SELECT id FROM factory.workspace_submission WHERE id=${input.requestID}`;
        if (recorded) {
          const previous = await row(input.requestID);
          await database.client.begin((sql) =>
            workspaceAuthorityIn(sql, input.workspaceID, userID, true),
          );
          sameInput(previous, userID, input);
          if (previous.state === "succeeded" || previous.state === "failed") return view(previous);
        }
        const saved = await scope(userID, input.workspaceID);
        const lock = database.coordination();
        try {
          await lock`SELECT pg_advisory_lock(hashtext(${`workspace-submission:${saved.changeID}`}))`;
          const [exists] =
            await database.client`SELECT id FROM factory.workspace_submission WHERE id=${input.requestID}`;
          if (!exists) {
            await collaboration.assertSaved(input.workspaceID);
            await database.client.begin(async (sql) => {
              await workspaceWriteAuthorityIn(sql, input.workspaceID, userID);
              const writer = await lockChangeWriterIn(sql, saved.changeID);
              const [draft] =
                await sql`SELECT path FROM factory.workspace_shared_document WHERE workspace_id=${input.workspaceID} AND (dirty OR conflict) LIMIT 1`;
              if (draft)
                throw new CommandError(
                  "conflict",
                  "Save or resolve shared editor buffers before submitting the saved checkout.",
                );
              const [work] =
                await sql`SELECT id FROM factory.agent_turn WHERE change_id=${saved.changeID} AND state IN ('pending','dispatching','running','uncertain')
                UNION ALL SELECT id FROM factory.change_commit_operation WHERE change_id=${saved.changeID} AND state NOT IN ('succeeded','failed') LIMIT 1`;
              if (work)
                throw new CommandError(
                  "conflict",
                  "Wait for admitted work to settle before shared submission",
                );
              await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,integration_base_sha,
                commit_message,idempotency_key,state,created_by,source)
                VALUES(${input.requestID},${saved.changeID},${saved.attemptID},(SELECT COALESCE(max(sequence),0)+1 FROM factory.change_commit_operation WHERE change_id=${saved.changeID}),
                  ${saved.branch},${input.expectedHead},${saved.base},${input.message},${`workspace:${input.requestID}`},'commit-intended',${userID},'workspace')`;
              await sql`UPDATE factory.change_writer SET state='unassigned',user_id=NULL,turn_id=NULL,epoch=epoch+1,updated_at=now() WHERE change_id=${saved.changeID}`;
              await sql`INSERT INTO factory.workspace_submission(id,workspace_id,actor_id,writer_epoch,remote_head)
                VALUES(${input.requestID},${input.workspaceID},${userID},${writer.epoch}::bigint+1,${input.expectedRemoteHead})`;
            });
          }
          let op = await row(input.requestID);
          sameInput(op, userID, input);
          if (op.state === "succeeded" || op.state === "failed") return view(op);
          if (op.state === "commit-intended") {
            const action = op.attempted ? "git-observe-commit" : "git-prepare-commit";
            if (!op.attempted)
              await database.client`UPDATE factory.workspace_submission SET prepare_attempted_at=now() WHERE id=${op.id}`;
            const prepared = await invoke(op, action);
            const commit = sha.parse(prepared.commitSHA);
            await database.client`UPDATE factory.change_commit_operation SET commit_sha=${commit},state='push-intended',updated_at=now() WHERE id=${op.id} AND state='commit-intended'`;
            op = await row(op.id);
          }
          if (op.state === "push-intended") {
            const repository = forgeRepositoryFromURL(op.repositoryURL);
            let remote = await forge.getBranch(repository, op.branch);
            if (remote?.headSha !== op.commitSHA) {
              if (remote?.headSha !== op.remoteHead)
                throw new CommandError(
                  "conflict",
                  "Ticket branch changed outside this submission. Nothing was force-pushed.",
                );
              await invoke(op, "git-push");
              remote = await forge.getBranch(repository, op.branch);
            }
            if (remote?.headSha !== op.commitSHA)
              throw new CommandError(
                "unavailable",
                "Exact submitted commit is not confirmed on the Ticket branch",
              );
            await database.client.begin(async (sql) => {
              const writer = await lockChangeWriterIn(sql, op.changeID);
              await sql`UPDATE factory.change_commit_operation SET observed_remote_sha=${op.commitSHA},state='succeeded',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=${op.id} AND state='push-intended'`;
              // An explicit successful human submission can recover earlier failed Coding.
              // A newer handoff or Stop must not be reopened by a late push observation.
              if (writer.available && writer.state === "unassigned" && writer.epoch === op.epoch)
                await sql`UPDATE factory.change SET state='active',failure=NULL,version=version+1
                  WHERE id=${op.changeID} AND runtime_attempt_id=${op.attemptID} AND state IN ('starting','failed')`;
            });
          }
          return view(await row(input.requestID));
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "";
          if (
            [
              "workspace has no changes to commit",
              "workspace HEAD no longer matches the commit intent",
              "an ordinary commit cannot accept an unadmitted merge",
            ].includes(message)
          ) {
            const op = await row(input.requestID).catch(() => undefined);
            if (op?.state === "commit-intended")
              await database.client.begin(async (sql) => {
                const writer = await lockChangeWriterIn(sql, op.changeID);
                await sql`UPDATE factory.change_commit_operation SET state='failed',last_error=${message},completed_at=now(),updated_at=now() WHERE id=${op.id} AND state='commit-intended'`;
                if (writer.state === "unassigned" && writer.epoch === op.epoch)
                  await sql`UPDATE factory.change_writer SET state='human',user_id=${op.actorID},epoch=epoch+1,updated_at=now() WHERE change_id=${op.changeID}`;
              });
          }
          throw cause;
        } finally {
          await lock`SELECT pg_advisory_unlock_all()`.catch(() => {});
          await lock.end({ timeout: 1 });
        }
      })();
      pending.add(task);
      try {
        return await task;
      } finally {
        pending.delete(task);
      }
    },
    async observe(userID: string, id: string) {
      const op = await row(z.uuid().parse(id));
      await database.client.begin((sql) => workspaceAuthorityIn(sql, op.workspaceID, userID));
      return view(op);
    },
    async recover() {
      const rows = await database.client<
        { id: string }[]
      >`SELECT operation.id FROM factory.workspace_submission submission JOIN factory.change_commit_operation operation ON operation.id=submission.id WHERE operation.state IN ('commit-intended','push-intended') ORDER BY submission.created_at LIMIT 16`;
      for (const saved of rows) {
        const op = await row(saved.id);
        await this.submit(op.actorID, {
          requestID: op.id,
          workspaceID: op.workspaceID,
          expectedHead: op.expectedHead,
          expectedRemoteHead: op.remoteHead,
          message: op.message,
        }).catch(() => undefined);
      }
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
    },
  };
}
