import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { forgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { lockChangeWriterIn, workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { recordWorkspaceCandidateIn, submitWorkspaceCandidate } from "../agent/candidate";
import { CommandError } from "../command-error";
import { substrateRepositoryCloneURL } from "../runtime/endpoints";
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
  nativeIntent: unknown;
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
  writing: {
    fenceSource(changeID: string, epoch: string, writable: false): Promise<void>;
    protect(changeID: string, writers: readonly string[]): Promise<void>;
  },
) {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  async function scope(userID: string, workspaceID: string): Promise<Saved> {
    await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID, true));
    const [row] = await database.client<
      Saved[]
    >`SELECT workspace.id AS "workspaceID",workspace.change_id AS "changeID",change.runtime_attempt_id AS "attemptID",
      project.repository_url AS "repositoryURL",binding.intent AS "nativeIntent",change.branch_name AS branch,change.base_sha AS base,person.name AS "authorName",person.email AS "authorEmail"
      FROM factory.development_workspace workspace JOIN factory.change change ON change.id=workspace.change_id
      JOIN factory.runtime_attempt attempt ON attempt.id=change.runtime_attempt_id AND attempt.workspace_id=workspace.id
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      JOIN factory.project project ON project.id=workspace.project_id JOIN auth."user" person ON person.id=${userID}
      WHERE workspace.id=${workspaceID} AND workspace.kind='ticket' AND change.state IN ('active','starting','failed') AND change.cancel_requested_at IS NULL
        AND attempt.state='ready' AND attempt.stop_intended_at IS NULL AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id=change.id AND session.stop_pending)`;
    if (!row || !hub.connected(row.attemptID))
      throw new CommandError(
        "conflict",
        "Start the selected Ticket Workspace before submitting saved source",
      );
    substrateRepositoryCloneURL(row.repositoryURL, row.nativeIntent);
    return row;
  }
  async function row(id: string) {
    const [result] = await database.client<
      Operation[]
    >`SELECT operation.id,submission.workspace_id AS "workspaceID",submission.actor_id AS "actorID",operation.change_id AS "changeID",
      operation.runtime_attempt_id AS "attemptID",submission.repository_url AS "repositoryURL",binding.intent AS "nativeIntent",operation.branch_name AS branch,operation.integration_base_sha AS base,
      operation.expected_parent_sha AS "expectedHead",submission.remote_head AS "remoteHead",operation.commit_message AS message,operation.state,operation.commit_sha AS "commitSHA",
      submission.prepare_attempted_at IS NOT NULL AS attempted,submission.writer_epoch::text AS epoch,person.name AS "authorName",person.email AS "authorEmail"
      FROM factory.workspace_submission submission JOIN factory.change_commit_operation operation ON operation.id=submission.id
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=operation.runtime_attempt_id
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
    const repositoryURL =
      action === "git-push"
        ? substrateRepositoryCloneURL(op.repositoryURL, op.nativeIntent)
        : undefined;
    async function authorize(sql: Parameters<typeof lockChangeWriterIn>[0]) {
      const writer = await lockChangeWriterIn(sql, op.changeID);
      await workspaceAuthorityIn(sql, op.workspaceID, op.actorID, true);
      if (writer.state !== "unassigned" || writer.epoch !== op.epoch || !writer.available)
        throw new CommandError("conflict", "Shared submission authority changed");
      const [active] = await sql<
        { id: string; repositoryURL: string; nativeIntent: unknown }[]
      >`SELECT operation.id,project.repository_url AS "repositoryURL",binding.intent AS "nativeIntent"
          FROM factory.change_commit_operation operation
          JOIN factory.change change ON change.id=operation.change_id
          JOIN factory.project project ON project.id=change.project_id
          JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
          JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
          WHERE operation.id=${op.id} AND operation.runtime_attempt_id=${op.attemptID}
            AND change.runtime_attempt_id=attempt.id AND attempt.state='ready'
            AND attempt.stop_intended_at IS NULL AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id=change.id AND session.stop_pending)
            AND operation.state=${action === "git-push" ? "push-intended" : "commit-intended"}
          FOR SHARE OF attempt,project`;
      if (!active)
        throw new CommandError(
          "conflict",
          "Submission dispatch no longer matches its saved intent",
        );
      if (
        substrateRepositoryCloneURL(active.repositoryURL, active.nativeIntent) !== op.repositoryURL
      )
        throw new CommandError("conflict", "Submission destination changed before dispatch");
    }
    await database.client.begin(authorize);
    // Source fencing owns its transaction and may lock Change. Do not retain the
    // admission locks across it. The actual frame rechecks the same authority.
    await writing.fenceSource(op.changeID, op.epoch, false);
    if (action === "git-prepare-commit")
      await database.client`UPDATE factory.workspace_submission SET prepare_attempted_at=now() WHERE id=${op.id}`;
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
              repositoryURL: repositoryURL ?? "",
              username: credentials.username,
              password: credentials.password,
            }
          : {}),
      },
      async (send) => {
        await database.client.begin(async (sql) => {
          await authorize(sql);
          if (action === "git-push") await writing.protect(op.changeID, [credentials.username]);
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
              await recordWorkspaceCandidateIn(sql, {
                id: input.requestID,
                changeID: saved.changeID,
                attemptID: saved.attemptID,
                workspaceID: input.workspaceID,
                actorID: userID,
                branch: saved.branch,
                base: saved.base,
                expectedHead: input.expectedHead,
                remoteHead: input.expectedRemoteHead,
                message: input.message,
                repositoryURL: substrateRepositoryCloneURL(saved.repositoryURL, saved.nativeIntent),
                writerEpoch: writer.epoch,
              });
            });
          }
          const op = await row(input.requestID);
          sameInput(op, userID, input);
          await submitWorkspaceCandidate(database, op, invoke, forge);
          return view(await row(input.requestID));
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
