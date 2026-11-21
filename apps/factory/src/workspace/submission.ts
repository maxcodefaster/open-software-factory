import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  authUser,
  change,
  changeAgentSession,
  changeCommitOperation,
  developmentWorkspace,
  project,
  runtimeAttempt,
  substrateBinding,
  workspaceSharedDocument,
  workspaceSubmission,
} from "../../../../packages/db/src/schema";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { forgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { lockChangeWriterIn, workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { recordWorkspaceCandidateIn, submitWorkspaceCandidate } from "../agent/candidate-api";
import { CommandError } from "../command-error";
import { substrateRepositoryCloneURL } from "../runtime/endpoints";
import { type RuntimeHub } from "../runtime/transport-api";
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
type Operation = Omit<Saved, "base"> & {
  base: string | null;
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
    const db = database.db;
    const [row] = await db
      .select({
        workspaceID: developmentWorkspace.id,
        changeID: change.id,
        attemptID: runtimeAttempt.id,
        repositoryURL: project.repositoryUrl,
        nativeIntent: substrateBinding.intent,
        branch: change.branchName,
        base: change.baseSha,
        authorName: authUser.name,
        authorEmail: authUser.email,
      })
      .from(developmentWorkspace)
      .innerJoin(change, eq(change.id, developmentWorkspace.changeId))
      .innerJoin(
        runtimeAttempt,
        and(
          eq(runtimeAttempt.id, change.runtimeAttemptId),
          eq(runtimeAttempt.workspaceId, developmentWorkspace.id),
        ),
      )
      .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
      .innerJoin(project, eq(project.id, developmentWorkspace.projectId))
      .innerJoin(authUser, eq(authUser.id, userID))
      .where(
        and(
          eq(developmentWorkspace.id, workspaceID),
          eq(developmentWorkspace.kind, "ticket"),
          inArray(change.state, ["active", "starting", "failed"]),
          isNull(change.cancelRequestedAt),
          eq(runtimeAttempt.state, "ready"),
          isNull(runtimeAttempt.stopIntendedAt),
          isNull(substrateBinding.deleteIntendedAt),
          isNull(substrateBinding.deletedAt),
          notExists(
            db
              .select({ id: changeAgentSession.changeId })
              .from(changeAgentSession)
              .where(
                and(eq(changeAgentSession.changeId, change.id), changeAgentSession.stopPending),
              ),
          ),
        ),
      );
    if (!row || !hub.connected(row.attemptID))
      throw new CommandError(
        "conflict",
        "Start the selected Ticket Workspace before submitting saved source",
      );
    substrateRepositoryCloneURL(row.repositoryURL, row.nativeIntent);
    return row;
  }
  async function row(id: string) {
    const [result] = await database.db
      .select({
        id: changeCommitOperation.id,
        workspaceID: workspaceSubmission.workspaceId,
        actorID: workspaceSubmission.actorId,
        changeID: changeCommitOperation.changeId,
        attemptID: substrateBinding.runtimeAttemptId,
        repositoryURL: workspaceSubmission.repositoryUrl,
        nativeIntent: substrateBinding.intent,
        branch: changeCommitOperation.branchName,
        base: changeCommitOperation.integrationBaseSha,
        expectedHead: changeCommitOperation.expectedParentSha,
        remoteHead: workspaceSubmission.remoteHead,
        message: changeCommitOperation.commitMessage,
        state: changeCommitOperation.state,
        commitSHA: changeCommitOperation.commitSha,
        attempted: isNotNull(workspaceSubmission.prepareAttemptedAt).mapWith(Boolean),
        epoch: query<string>`${workspaceSubmission.writerEpoch}::text`,
        authorName: authUser.name,
        authorEmail: authUser.email,
      })
      .from(workspaceSubmission)
      .innerJoin(changeCommitOperation, eq(changeCommitOperation.id, workspaceSubmission.id))
      .innerJoin(
        substrateBinding,
        eq(substrateBinding.runtimeAttemptId, changeCommitOperation.runtimeAttemptId),
      )
      .innerJoin(authUser, eq(authUser.id, workspaceSubmission.actorId))
      .where(eq(workspaceSubmission.id, id));
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
      const db = drizzleTransaction(sql);
      const attempt = alias(runtimeAttempt, "attempt");
      const destination = alias(project, "project");
      const [active] = await db
        .select({
          id: changeCommitOperation.id,
          repositoryURL: destination.repositoryUrl,
          nativeIntent: substrateBinding.intent,
        })
        .from(changeCommitOperation)
        .innerJoin(change, eq(change.id, changeCommitOperation.changeId))
        .innerJoin(destination, eq(destination.id, change.projectId))
        .innerJoin(attempt, eq(attempt.id, changeCommitOperation.runtimeAttemptId))
        .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, attempt.id))
        .where(
          and(
            eq(changeCommitOperation.id, op.id),
            eq(changeCommitOperation.runtimeAttemptId, op.attemptID),
            eq(change.runtimeAttemptId, attempt.id),
            eq(attempt.state, "ready"),
            isNull(attempt.stopIntendedAt),
            isNull(substrateBinding.deleteIntendedAt),
            isNull(substrateBinding.deletedAt),
            notExists(
              db
                .select({ id: changeAgentSession.changeId })
                .from(changeAgentSession)
                .where(
                  and(eq(changeAgentSession.changeId, change.id), changeAgentSession.stopPending),
                ),
            ),
            eq(
              changeCommitOperation.state,
              action === "git-push" ? "push-intended" : "commit-intended",
            ),
          ),
        )
        .for("share", { of: [attempt, destination] });
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
      await database.db
        .update(workspaceSubmission)
        .set({ prepareAttemptedAt: query`now()` })
        .where(eq(workspaceSubmission.id, op.id));
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
        const [recorded] = await database.db
          .select({ id: workspaceSubmission.id })
          .from(workspaceSubmission)
          .where(eq(workspaceSubmission.id, input.requestID));
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
          const [exists] = await database.db
            .select({ id: workspaceSubmission.id })
            .from(workspaceSubmission)
            .where(eq(workspaceSubmission.id, input.requestID));
          if (!exists) {
            await collaboration.assertSaved(input.workspaceID);
            await database.client.begin(async (sql) => {
              await workspaceWriteAuthorityIn(sql, input.workspaceID, userID);
              const writer = await lockChangeWriterIn(sql, saved.changeID);
              const db = drizzleTransaction(sql);
              const [draft] = await db
                .select({ path: workspaceSharedDocument.path })
                .from(workspaceSharedDocument)
                .where(
                  and(
                    eq(workspaceSharedDocument.workspaceId, input.workspaceID),
                    or(workspaceSharedDocument.dirty, workspaceSharedDocument.conflict),
                  ),
                )
                .limit(1);
              if (draft)
                throw new CommandError(
                  "conflict",
                  "Save or resolve shared editor buffers before submitting the saved checkout.",
                );
              const [work] = await db
                .select({ id: agentTurn.id })
                .from(agentTurn)
                .where(
                  and(
                    eq(agentTurn.changeId, saved.changeID),
                    inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                  ),
                )
                .unionAll(
                  db
                    .select({ id: changeCommitOperation.id })
                    .from(changeCommitOperation)
                    .where(
                      and(
                        eq(changeCommitOperation.changeId, saved.changeID),
                        notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                      ),
                    ),
                )
                .limit(1);
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
      const rows = await database.db
        .select({ id: changeCommitOperation.id })
        .from(workspaceSubmission)
        .innerJoin(changeCommitOperation, eq(changeCommitOperation.id, workspaceSubmission.id))
        .where(inArray(changeCommitOperation.state, ["commit-intended", "push-intended"]))
        .orderBy(asc(workspaceSubmission.createdAt))
        .limit(16);
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
