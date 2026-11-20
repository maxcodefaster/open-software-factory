import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeCommitOperation,
  project,
  projectDeliveryQueue,
  requirementApproval,
  requirementRevision,
  runtimeAttempt,
  substrateBinding,
  ticket,
} from "../../../../packages/db/src/schema";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectAuthorityIn } from "../access/controller";
import type { createAgentController } from "../agent/controller";
import { CommandError, plainErrorMessage } from "../command-error";
import { substrateRepositoryCloneURL } from "../runtime/endpoints";
import type { RuntimeHub } from "../runtime/hub";
import { RuntimeParentOperationError } from "../runtime/hub";

type Operation = {
  id: string;
  changeID: string;
  attemptID: string;
  parent: string;
  base: string;
  branch: string;
  message: string;
  state: string;
  sha: string | null;
  error: string | null;
  userID: string;
  repository: string;
};

// Integration uses the existing checkout and Factory commit/push protocol.
// Only an observed Git conflict enters the retained implementation Session.
export function createChangeIntegration(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  agent: {
    prompt(
      ...args: Parameters<ReturnType<typeof createAgentController>["prompt"]>
    ): Promise<unknown>;
  },
  runtime: { startPersisted(id: string, userID: string): Promise<unknown> },
) {
  async function operation(changeID: string) {
    const [row] = await database.db
      .select({
        id: changeCommitOperation.id,
        changeID: changeCommitOperation.changeId,
        attemptID: query<string>`${changeCommitOperation.runtimeAttemptId}`,
        parent: changeCommitOperation.expectedParentSha,
        base: query<string>`${changeCommitOperation.integrationBaseSha}`,
        branch: changeCommitOperation.branchName,
        message: changeCommitOperation.commitMessage,
        state: changeCommitOperation.state,
        sha: changeCommitOperation.commitSha,
        error: changeCommitOperation.lastError,
        userID: changeCommitOperation.createdBy,
        repository: project.repositoryUrl,
      })
      .from(changeCommitOperation)
      .innerJoin(change, eq(change.id, changeCommitOperation.changeId))
      .innerJoin(project, eq(project.id, change.projectId))
      .where(
        and(
          eq(changeCommitOperation.changeId, changeID),
          eq(changeCommitOperation.source, "integration"),
        ),
      )
      .orderBy(desc(changeCommitOperation.sequence))
      .limit(1);
    return row;
  }
  async function send(
    op: Operation,
    action: "git-prepare-integration" | "git-observe-commit" | "git-push",
  ) {
    const currentAttempt = alias(runtimeAttempt, "current");
    const originalAttempt = alias(runtimeAttempt, "original");
    const [current] = await database.db
      .select({ id: currentAttempt.id, nativeIntent: substrateBinding.intent })
      .from(change)
      .innerJoin(currentAttempt, eq(currentAttempt.id, change.runtimeAttemptId))
      .innerJoin(originalAttempt, eq(originalAttempt.id, op.attemptID))
      .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, currentAttempt.id))
      .where(
        and(
          eq(change.id, op.changeID),
          eq(currentAttempt.state, "ready"),
          eq(originalAttempt.workspaceId, currentAttempt.workspaceId),
          isNull(currentAttempt.stopIntendedAt),
          isNull(substrateBinding.deleteIntendedAt),
          isNull(substrateBinding.deletedAt),
        ),
      );
    if (!current)
      throw new CommandError("unavailable", "The Ticket Workspace is not ready for integration.");
    const repositoryURL = substrateRepositoryCloneURL(op.repository, current.nativeIntent);
    return hub.parentOperation(
      current.id,
      {
        operationId: op.id,
        action,
        expectedSha: op.parent,
        mergeParentSha: op.base,
        commitMessage: op.message,
        authorName: "Open Software Factory",
        authorEmail: "factory@localhost",
        repositoryURL,
        branch: op.branch,
        commitSha: op.sha ?? "",
        username: process.env["FACTORY_FORGEJO_OWNER"] ?? "factory",
        password: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
      },
      async (forward) => {
        await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, op.changeID);
          await projectAuthorityIn(sql, op.userID, writer.projectID);
          const db = drizzleTransaction(sql);
          const [valid] = await db
            .select({
              id: changeCommitOperation.id,
              repository: project.repositoryUrl,
              nativeIntent: substrateBinding.intent,
            })
            .from(changeCommitOperation)
            .innerJoin(change, eq(change.id, changeCommitOperation.changeId))
            .innerJoin(project, eq(project.id, change.projectId))
            .innerJoin(ticket, eq(ticket.id, change.ticketId))
            .innerJoin(
              requirementApproval,
              eq(requirementApproval.id, change.requirementApprovalId),
            )
            .innerJoin(changeAgentSession, eq(changeAgentSession.changeId, change.id))
            .innerJoin(currentAttempt, eq(currentAttempt.id, change.runtimeAttemptId))
            .innerJoin(
              originalAttempt,
              eq(originalAttempt.id, changeCommitOperation.runtimeAttemptId),
            )
            .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, currentAttempt.id))
            .innerJoin(
              projectDeliveryQueue,
              and(
                eq(projectDeliveryQueue.projectId, change.projectId),
                eq(projectDeliveryQueue.changeId, change.id),
              ),
            )
            .where(
              and(
                eq(changeCommitOperation.id, op.id),
                eq(changeCommitOperation.source, "integration"),
                eq(changeCommitOperation.expectedParentSha, op.parent),
                eq(changeCommitOperation.mergeParentSha, op.base),
                eq(
                  changeCommitOperation.state,
                  action === "git-push" ? "push-intended" : "commit-intended",
                ),
                action === "git-push"
                  ? eq(changeCommitOperation.commitSha, query`${op.sha}`)
                  : undefined,
                eq(change.state, "active"),
                isNull(change.cancelRequestedAt),
                isNull(ticket.trashedAt),
                eq(changeAgentSession.state, "committed"),
                eq(changeAgentSession.stopPending, false),
                eq(currentAttempt.id, current.id),
                eq(currentAttempt.state, "ready"),
                eq(currentAttempt.workspaceId, originalAttempt.workspaceId),
                isNull(currentAttempt.stopIntendedAt),
                isNull(substrateBinding.deleteIntendedAt),
                isNull(substrateBinding.deletedAt),
                eq(
                  requirementApproval.requirementRevisionId,
                  db
                    .select({ id: requirementRevision.id })
                    .from(requirementRevision)
                    .where(eq(requirementRevision.ticketId, ticket.id))
                    .orderBy(desc(requirementRevision.ordinal))
                    .limit(1),
                ),
                notExists(
                  db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(
                      and(
                        eq(agentTurn.changeId, change.id),
                        inArray(agentTurn.state, [
                          "pending",
                          "dispatching",
                          "running",
                          "uncertain",
                        ]),
                      ),
                    ),
                ),
              ),
            )
            // PostgreSQL's OF list takes unqualified relation identifiers.
            .for("share", { of: [currentAttempt, alias(project, "project")] });
          if (!valid || !writer.available || writer.state !== "agent")
            throw new CommandError(
              "conflict",
              "Integration writing authority changed before dispatch.",
            );
          const destination = substrateRepositoryCloneURL(valid.repository, valid.nativeIntent);
          if (destination !== repositoryURL)
            throw new CommandError("conflict", "Integration destination changed before dispatch.");
          forward();
        });
      },
    );
  }
  async function laterSucceededCommit(changeID: string, operationID: string) {
    const previous = alias(changeCommitOperation, "previous");
    const [later] = await database.db
      .select({ id: changeCommitOperation.id })
      .from(changeCommitOperation)
      .where(
        and(
          eq(changeCommitOperation.changeId, changeID),
          gt(
            changeCommitOperation.sequence,
            database.db
              .select({ sequence: previous.sequence })
              .from(previous)
              .where(eq(previous.id, operationID)),
          ),
          eq(changeCommitOperation.state, "succeeded"),
        ),
      )
      .limit(1);
    return later;
  }
  return {
    async reconcile(changeID: string, base: string) {
      let op = await operation(changeID);
      if (op?.state === "failed" && op.error !== "integration has conflicts") {
        const later = await laterSucceededCommit(changeID, op.id);
        if (!later) return false;
      }
      if (op?.state === "failed" && op.error === "integration has conflicts") {
        const later = await laterSucceededCommit(changeID, op.id);
        if (!later) {
          await agent.prompt(
            changeID,
            [
              `Factory started integration of exact main commit ${op.base} into candidate ${op.parent}. Git reported conflicts.`,
              "The existing Ticket checkout retains this exact merge. Resolve only where both approved intentions are clear.",
              "If resolution needs a product or architecture decision, ask the human and stop. Do not silently change approved scope.",
              "Do not start another merge, abort this merge, rebase, commit or push. Preserve MERGE_HEAD. Resolve the files and run relevant checks.",
              "Factory will create the two-parent commit, fresh Verification and independent review.",
            ].join("\n\n"),
            op.userID,
            op.id,
            true,
          );
          return false;
        }
      }
      if (!op || ["succeeded", "failed"].includes(op.state)) {
        const created = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          if (!writer.available || writer.state !== "agent") return false;
          const db = drizzleTransaction(sql);
          const [row] = await db
            .select({
              id: change.id,
              userID: change.createdBy,
              attemptID: change.runtimeAttemptId,
              branch: change.branchName,
            })
            .from(change)
            .innerJoin(changeAgentSession, eq(changeAgentSession.changeId, change.id))
            .innerJoin(projectDeliveryQueue, eq(projectDeliveryQueue.changeId, change.id))
            .where(
              and(
                eq(change.id, changeID),
                eq(changeAgentSession.state, "committed"),
                eq(changeAgentSession.stopPending, false),
                notExists(
                  db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(
                      and(
                        eq(agentTurn.changeId, change.id),
                        inArray(agentTurn.state, [
                          "pending",
                          "dispatching",
                          "running",
                          "uncertain",
                        ]),
                      ),
                    ),
                ),
                notExists(
                  db
                    .select({ id: changeCommitOperation.id })
                    .from(changeCommitOperation)
                    .where(
                      and(
                        eq(changeCommitOperation.changeId, change.id),
                        notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                      ),
                    ),
                ),
              ),
            );
          if (!row) return false;
          await projectAuthorityIn(sql, row.userID, writer.projectID);
          const latestCommit = db
            .select({ sha: changeCommitOperation.commitSha })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, changeID),
                eq(changeCommitOperation.state, "succeeded"),
              ),
            )
            .orderBy(desc(changeCommitOperation.sequence))
            .limit(1);
          // The writer lock retains Change identity. Sequence and exact candidate
          // are still read in the same INSERT snapshot as the durable intent.
          await db.insert(changeCommitOperation).values({
            id: crypto.randomUUID(),
            changeId: row.id,
            runtimeAttemptId: row.attemptID,
            sequence: query`(${db
              .select({
                sequence: query<number>`coalesce(max(${changeCommitOperation.sequence}), 0) + 1`,
              })
              .from(changeCommitOperation)
              .where(eq(changeCommitOperation.changeId, changeID))})`,
            branchName: row.branch,
            expectedParentSha: query`(${latestCommit})`,
            integrationBaseSha: base,
            mergeParentSha: base,
            commitMessage: "Integrate current main",
            idempotencyKey: query`${`integration:${changeID}:${base}:`} || (${latestCommit})`,
            state: "commit-intended",
            createdBy: row.userID,
            source: "integration",
          });
          return true;
        });
        if (!created) return false;
        op = await operation(changeID);
      }
      if (!op) return false;
      try {
        await runtime.startPersisted(changeID, op.userID);
      } catch (cause) {
        if (
          cause instanceof CommandError &&
          cause.code === "forbidden" &&
          op.state === "commit-intended" &&
          op.error === null &&
          op.sha === null
        ) {
          const refused = op;
          const failure =
            `Integration did not start. Take over editing or start Coding again to continue. ${plainErrorMessage(cause.message)}`.slice(
              0,
              2000,
            );
          await database.client.begin(async (sql) => {
            const writer = await lockChangeWriterIn(sql, changeID);
            if (!writer.available) return;
            // Only retire the exact still-undispatched current intent. Another
            // reconciler may have recorded dispatch while startup was pending.
            const db = drizzleTransaction(sql);
            const history = alias(changeCommitOperation, "history");
            const [retired] = await db
              .update(changeCommitOperation)
              .set({
                state: "failed",
                lastError: failure,
                completedAt: query`now()`,
                updatedAt: query`now()`,
              })
              .from(change)
              .where(
                and(
                  eq(changeCommitOperation.id, refused.id),
                  eq(changeCommitOperation.changeId, change.id),
                  eq(change.id, changeID),
                  eq(change.state, "active"),
                  eq(changeCommitOperation.source, "integration"),
                  eq(changeCommitOperation.runtimeAttemptId, refused.attemptID),
                  eq(changeCommitOperation.createdBy, refused.userID),
                  eq(changeCommitOperation.branchName, refused.branch),
                  eq(changeCommitOperation.expectedParentSha, refused.parent),
                  eq(changeCommitOperation.integrationBaseSha, refused.base),
                  eq(changeCommitOperation.mergeParentSha, refused.base),
                  eq(changeCommitOperation.state, "commit-intended"),
                  isNull(changeCommitOperation.lastError),
                  isNull(changeCommitOperation.commitSha),
                  isNull(changeCommitOperation.observedRemoteSha),
                  eq(
                    changeCommitOperation.sequence,
                    db
                      .select({ sequence: query<number>`max(${history.sequence})` })
                      .from(history)
                      .where(eq(history.changeId, changeID)),
                  ),
                ),
              )
              .returning({ id: changeCommitOperation.id });
            if (retired)
              await db
                .update(change)
                .set({ failure })
                .where(and(eq(change.id, changeID), eq(change.state, "active")));
          });
        }
        // Transient preparation and previously dispatched/unknown Git writes
        // retain their original evidence. A failed Start is never a replay grant.
        return false;
      }
      const [ready] = await database.db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(
          and(
            eq(
              runtimeAttempt.id,
              database.db
                .select({ id: change.runtimeAttemptId })
                .from(change)
                .where(eq(change.id, changeID)),
            ),
            eq(runtimeAttempt.state, "ready"),
          ),
        );
      if (!ready) return false;
      try {
        if (op.state === "commit-intended") {
          const recovering = op.error !== null;
          await database.db
            .update(changeCommitOperation)
            .set({
              lastError: "Integration dispatched; exact outcome pending",
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(changeCommitOperation.id, op.id),
                eq(changeCommitOperation.state, "commit-intended"),
              ),
            );
          const result = await send(
            op,
            recovering ? "git-observe-commit" : "git-prepare-integration",
          );
          if (!result.commitSHA) throw new Error("Integrated commit was not confirmed.");
          op.sha = result.commitSHA;
          await database.db
            .update(changeCommitOperation)
            .set({ state: "push-intended", commitSha: op.sha, updatedAt: query`now()` })
            .where(
              and(
                eq(changeCommitOperation.id, op.id),
                eq(changeCommitOperation.state, "commit-intended"),
              ),
            );
        }
        const result = await send(op, "git-push");
        if (!op.sha || result.remoteSHA !== op.sha)
          throw new Error("Integrated remote commit was not confirmed.");
        await database.db
          .update(changeCommitOperation)
          .set({
            state: "succeeded",
            observedRemoteSha: op.sha,
            lastError: null,
            completedAt: query`now()`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(changeCommitOperation.id, op.id),
              eq(changeCommitOperation.state, "push-intended"),
            ),
          );
        await database.db
          .update(change)
          .set({ failure: null })
          .where(
            and(eq(change.id, changeID), eq(change.state, "active"), isNotNull(change.failure)),
          );
        return true;
      } catch (cause) {
        const conflict =
          cause instanceof RuntimeParentOperationError &&
          cause.message === "integration has conflicts";
        const rejected = cause instanceof CommandError && op.error === null;
        await database.db
          .update(changeCommitOperation)
          .set({
            state: conflict || rejected ? "failed" : changeCommitOperation.state,
            completedAt: conflict || rejected ? query`now()` : null,
            lastError: (cause instanceof Error
              ? cause.message
              : "Integration outcome unknown"
            ).slice(0, 2000),
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(changeCommitOperation.id, op.id),
              notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
            ),
          );
        await database.db
          .update(change)
          .set({
            failure: (cause instanceof Error ? cause.message : "Integration outcome unknown").slice(
              0,
              2000,
            ),
          })
          .where(and(eq(change.id, changeID), eq(change.state, "active")));
        return false;
      }
    },
  };
}
