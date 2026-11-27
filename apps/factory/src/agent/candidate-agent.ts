import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  project,
  runtimeAttempt,
  ticketConversation,
} from "#db/schema";
import { CommandError } from "../command-error";
import { substrateRepositoryCloneURL } from "../runtime/endpoints";
import { type RuntimeHub, RuntimeParentOperationError } from "../runtime/transport-api";
import { advanceCandidateCommit, earlierSubmissionUnchanged, noChangesToSubmit } from "./candidate";
import { createAgentCommitTransport } from "./commit-transport";
import { bounded, readableError } from "./native-errors";
import { createAgentTurnStore } from "./turn-store";

type Database = ReturnType<typeof createDatabase>;

export function createAgentCandidates(
  database: Database,
  hub: RuntimeHub,
  isClosed: () => boolean,
) {
  const committing = new Map<string, Promise<void>>();
  const turns = createAgentTurnStore(database);
  const commitTransport = createAgentCommitTransport(database, hub);

  async function reconcileCommit(operationID: string, recovering = false) {
    if (isClosed()) return;
    const existing = committing.get(operationID);
    if (existing) return existing;
    const work = performCommit(operationID, recovering).finally(() => {
      if (committing.get(operationID) === work) committing.delete(operationID);
    });
    committing.set(operationID, work);
    await work;
  }

  async function recoverRuntimeCommits(attemptID: string) {
    if (isClosed()) return;
    const original = alias(runtimeAttempt, "original");
    const current = alias(runtimeAttempt, "current");
    const operations = await database.db
      .select({ id: changeCommitOperation.id })
      .from(changeCommitOperation)
      .innerJoin(original, eq(original.id, changeCommitOperation.runtimeAttemptId))
      .innerJoin(change, eq(change.id, changeCommitOperation.changeId))
      .innerJoin(current, eq(current.id, change.runtimeAttemptId))
      .where(
        and(
          eq(changeCommitOperation.source, "agent"),
          notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
          or(
            eq(original.id, attemptID),
            and(
              eq(current.id, attemptID),
              eq(current.state, "ready"),
              eq(changeCommitOperation.state, "commit-intended"),
              inArray(original.state, ["stopped", "failed"]),
              isNotNull(original.workspaceId),
              eq(current.workspaceId, original.workspaceId),
            ),
          ),
        ),
      )
      .orderBy(changeCommitOperation.createdAt);
    for (const operation of operations) {
      const previous = committing.get(operation.id);
      if (previous) await previous;
      if (isClosed()) return;
      await reconcileCommit(operation.id, true);
    }
  }

  async function performCommit(operationID: string, recovering: boolean) {
    if (isClosed()) return;
    const operations = await database.db
      .select({
        id: changeCommitOperation.id,
        changeID: changeCommitOperation.changeId,
        attemptID: changeCommitOperation.runtimeAttemptId,
        branchName: changeCommitOperation.branchName,
        expectedParentSHA: changeCommitOperation.expectedParentSha,
        integrationBaseSHA: changeCommitOperation.integrationBaseSha,
        isMerge: changeCommitOperation.isMerge,
        commitSHA: changeCommitOperation.commitSha,
        commitMessage: changeCommitOperation.commitMessage,
        state: changeCommitOperation.state,
        lastError: changeCommitOperation.lastError,
        repositoryURL: project.repositoryUrl,
        nativeIntent: runtimeAttempt.bindingIntent,
      })
      .from(changeCommitOperation)
      .innerJoin(change, eq(change.id, changeCommitOperation.changeId))
      .innerJoin(project, eq(project.id, change.projectId))
      .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeCommitOperation.runtimeAttemptId))
      .where(
        and(
          eq(changeCommitOperation.id, operationID),
          eq(changeCommitOperation.source, "agent"),
          isNotNull(runtimeAttempt.atespace),
        ),
      );
    const operation = operations[0];
    if (!operation || ["succeeded", "failed"].includes(operation.state)) return;
    const mergeParentSha = operation.isMerge ? (operation.integrationBaseSHA ?? "") : "";
    try {
      await advanceCandidateCommit(
        database,
        operation,
        async () => {
          const payload = {
            operationId: operation.id,
            expectedSha: operation.expectedParentSHA,
            mergeParentSha,
            commitMessage: operation.commitMessage,
            authorName: "Open Software Factory",
            authorEmail: "factory@localhost",
          };
          return recovering
            ? commitTransport.observeRetainedCheckout(operation.attemptID, {
                ...payload,
                action: "git-observe-commit",
              })
            : commitTransport(operation.attemptID, {
                ...payload,
                action: "git-prepare-commit",
              });
        },
        (prepared) =>
          commitTransport(operation.attemptID, {
            operationId: operation.id,
            action: "git-push",
            branch: operation.branchName,
            expectedSha: operation.expectedParentSHA,
            mergeParentSha,
            commitSha: prepared.commitSHA,
            repositoryURL: substrateRepositoryCloneURL(
              operation.repositoryURL,
              operation.nativeIntent,
            ),
            username:
              process.env["FACTORY_FORGEJO_USERNAME"] ??
              process.env["FACTORY_FORGEJO_OWNER"] ??
              "factory",
            password: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
          }),
        async (prepared) => {
          const commitSHA = prepared.commitSHA;
          await turns.observeCommit(operation.id, async (transaction, current) => {
            const db = drizzleTransaction(transaction);
            const recorded = await db
              .update(changeCommitOperation)
              .set({
                state: "succeeded",
                observedRemoteSha: commitSHA,
                completedAt: query`now()`,
                updatedAt: query`now()`,
                lastError: null,
              })
              .where(
                and(
                  eq(changeCommitOperation.id, operation.id),
                  inArray(changeCommitOperation.state, ["committed", "push-intended"]),
                ),
              )
              .returning({ id: changeCommitOperation.id });
            if (!recorded[0] || !current) return;
            await db
              .update(changeAgentSession)
              .set({
                state: "committed",
                activeInboxId: null,
                lastError: null,
                updatedAt: query`now()`,
              })
              .where(
                and(
                  eq(changeAgentSession.changeId, operation.changeID),
                  eq(changeAgentSession.state, "waiting"),
                  eq(changeAgentSession.activeTurnId, operation.id),
                  eq(changeAgentSession.runtimeAttemptId, operation.attemptID),
                  eq(changeAgentSession.stopPending, false),
                  exists(
                    db
                      .select({ id: change.id })
                      .from(change)
                      .where(
                        and(
                          eq(change.id, operation.changeID),
                          eq(change.runtimeAttemptId, operation.attemptID),
                        ),
                      ),
                  ),
                  exists(
                    db
                      .select({ id: changeAgentTurnIntent.turnId })
                      .from(changeAgentTurnIntent)
                      .where(
                        and(
                          eq(changeAgentTurnIntent.turnId, operation.id),
                          eq(changeAgentTurnIntent.runtimeAttemptId, operation.attemptID),
                          eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                        ),
                      ),
                  ),
                ),
              );
          });
        },
      );
    } catch (cause) {
      const emptyCheckout =
        cause instanceof RuntimeParentOperationError &&
        operation.state === "commit-intended" &&
        !recovering &&
        cause.action === "git-prepare-commit" &&
        cause.message === "workspace has no changes to commit" &&
        operation.lastError === null;
      const absentPreparedCommit =
        cause instanceof RuntimeParentOperationError &&
        operation.state === "commit-intended" &&
        recovering &&
        cause.action === "git-observe-commit" &&
        cause.message ===
          "the exact prepared commit was not found; current files were not committed";
      if (emptyCheckout || absentPreparedCommit) {
        await turns.observeCommit(operation.id, async (transaction) => {
          const db = drizzleTransaction(transaction);
          const [previousSubmission] = emptyCheckout
            ? await db
                .select({ id: changeCommitOperation.id })
                .from(changeCommitOperation)
                .where(
                  and(
                    eq(changeCommitOperation.changeId, operation.changeID),
                    eq(changeCommitOperation.state, "succeeded"),
                    lt(
                      changeCommitOperation.sequence,
                      query`(${db
                        .select({ sequence: changeCommitOperation.sequence })
                        .from(changeCommitOperation)
                        .where(eq(changeCommitOperation.id, operation.id))})`,
                    ),
                  ),
                )
                .limit(1)
            : [];
          const diagnostic = emptyCheckout
            ? noChangesToSubmit + (previousSubmission ? earlierSubmissionUnchanged : "")
            : "Prepared commit was not found. Files were left untouched; review the checkout before starting a new Build turn.";
          const recorded = await db
            .update(changeCommitOperation)
            .set({
              state: "failed",
              lastError: diagnostic,
              completedAt: query`now()`,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(changeCommitOperation.id, operation.id),
                eq(changeCommitOperation.state, "commit-intended"),
                isNull(changeCommitOperation.commitSha),
              ),
            )
            .returning({ id: changeCommitOperation.id });
          if (!recorded[0]) return;
          await db
            .update(changeAgentSession)
            .set({
              state: absentPreparedCommit ? "failed" : "waiting",
              lastError: diagnostic,
              activeInboxId: null,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(changeAgentSession.changeId, operation.changeID),
                eq(changeAgentSession.state, "waiting"),
                eq(changeAgentSession.activeTurnId, operation.id),
                eq(changeAgentSession.runtimeAttemptId, operation.attemptID),
                eq(changeAgentSession.stopPending, false),
                exists(
                  db
                    .select({ id: changeAgentTurnIntent.turnId })
                    .from(changeAgentTurnIntent)
                    .where(
                      and(
                        eq(changeAgentTurnIntent.turnId, operation.id),
                        eq(changeAgentTurnIntent.runtimeAttemptId, operation.attemptID),
                        eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                      ),
                    ),
                ),
              ),
            );
        });
        return;
      }
      // Only an authority rejection proves this frame did not execute. Transport,
      // Connector and persistence errors can follow a successful commit or push.
      // A prior unresolved outcome also survives a later authority rejection.
      const rejected = cause instanceof CommandError && !recovering;
      const detail = readableError(cause);
      await turns.observeCommit(operation.id, async (transaction) => {
        const db = drizzleTransaction(transaction);
        const recorded = await db
          .update(changeCommitOperation)
          .set({
            state: query`CASE WHEN ${rejected} AND ${changeCommitOperation.lastError} IS NULL THEN 'failed'::factory.change_commit_state ELSE ${changeCommitOperation.state} END`,
            lastError: query`CASE WHEN ${rejected} AND ${changeCommitOperation.lastError} IS NULL THEN ${bounded(detail, 4_000)}
            ELSE ${bounded(`Commit outcome not confirmed. New Build waits for recovery. ${detail}`, 4_000)} END`,
            completedAt: query`CASE WHEN ${rejected} AND ${changeCommitOperation.lastError} IS NULL THEN now() ELSE NULL END`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(changeCommitOperation.id, operation.id),
              notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
            ),
          )
          .returning({ id: changeCommitOperation.id, state: changeCommitOperation.state });
        if (!recorded[0]) return;
        await db
          .update(changeAgentSession)
          .set({
            state: query`CASE WHEN ${recorded[0].state === "failed"} THEN 'failed'::factory.change_agent_state ELSE ${changeAgentSession.state} END`,
            lastError: query`(${db.select({ lastError: changeCommitOperation.lastError }).from(changeCommitOperation).where(eq(changeCommitOperation.id, operation.id))})`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(changeAgentSession.changeId, operation.changeID),
              eq(changeAgentSession.state, "waiting"),
              eq(changeAgentSession.activeTurnId, operation.id),
              eq(changeAgentSession.runtimeAttemptId, operation.attemptID),
              eq(changeAgentSession.stopPending, false),
              exists(
                db
                  .select({ id: change.id })
                  .from(change)
                  .where(
                    and(
                      eq(change.id, operation.changeID),
                      eq(change.runtimeAttemptId, operation.attemptID),
                    ),
                  ),
              ),
              exists(
                db
                  .select({ id: changeAgentTurnIntent.turnId })
                  .from(changeAgentTurnIntent)
                  .where(
                    and(
                      eq(changeAgentTurnIntent.turnId, operation.id),
                      eq(changeAgentTurnIntent.runtimeAttemptId, operation.attemptID),
                      eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
                    ),
                  ),
              ),
            ),
          );
      });
    }
  }

  async function recordCommit(
    sql: DatabaseTransaction,
    active: { changeID: string; runtimeAttemptID: string; ticketTitle: string },
    userID: string,
    turnID: string,
  ) {
    const allowed = await sql<
      Array<{ conversationID: string | null }>
    >`SELECT turn.conversation_id AS "conversationID"
      FROM factory.agent_turn turn JOIN factory.change change ON change.id = turn.change_id
      JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
      WHERE turn.id = ${turnID} AND change.state IN ('starting', 'active')
        AND ticket.trashed_at IS NULL
        AND approval.requirement_revision_id = (SELECT id FROM factory.requirement_revision
          WHERE ticket_id = ticket.id ORDER BY ordinal DESC LIMIT 1)
      FOR UPDATE OF change, ticket`;
    if (!allowed[0]) throw new CommandError("conflict", "Build approval changed before committing");
    if (allowed[0].conversationID) {
      const modes = await drizzleTransaction(sql)
        .select({ mode: ticketConversation.mode })
        .from(ticketConversation)
        .where(eq(ticketConversation.id, allowed[0].conversationID))
        .for("update");
      if (modes[0]?.mode !== "build")
        throw new CommandError("conflict", "Build mode changed before committing");
    }
    const changeID = active.changeID;
    const operationID = turnID;
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO factory.change_commit_operation(
        id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
        integration_base_sha, is_merge, commit_message, idempotency_key, state, created_by
      )
      SELECT ${operationID}, change.id, ${active.runtimeAttemptID},
        COALESCE(MAX(previous.sequence), 0) + 1, change.branch_name,
        COALESCE(
          (SELECT observed_remote_sha FROM factory.change_commit_operation latest
            WHERE latest.change_id = change.id AND latest.state = 'succeeded'
            ORDER BY latest.sequence DESC LIMIT 1),
          change.base_sha
        ),
        (SELECT integration_base_sha FROM factory.change_commit_operation latest
          WHERE latest.change_id=change.id AND (latest.state='succeeded' OR (
            latest.source='integration' AND latest.state='failed' AND latest.last_error='integration has conflicts'))
          ORDER BY latest.sequence DESC LIMIT 1),
        COALESCE(
          (SELECT integration.is_merge FROM factory.change_commit_operation integration
            WHERE integration.change_id=change.id AND integration.source='integration'
              AND integration.state='failed' AND integration.last_error='integration has conflicts'
              AND integration.sequence>COALESCE((SELECT MAX(sequence) FROM factory.change_commit_operation
                WHERE change_id=change.id AND state='succeeded'),0)
            ORDER BY integration.sequence DESC LIMIT 1),
          false
        ),
        ${active.ticketTitle}, ${`change-commit:${changeID}:${operationID}`},
        'commit-intended', ${userID}
      FROM factory.change change
      LEFT JOIN factory.change_commit_operation previous ON previous.change_id = change.id
      WHERE change.id = ${changeID}
        AND EXISTS (SELECT 1 FROM factory.change_agent_session session
          WHERE session.change_id = change.id AND session.state = 'waiting' AND session.active_turn_id = ${turnID})
        AND NOT EXISTS (
          SELECT 1 FROM factory.change_commit_operation pending
          WHERE pending.change_id = change.id AND pending.state NOT IN ('succeeded', 'failed')
        )
      GROUP BY change.id
      RETURNING id
    `;
    if (!created[0])
      throw new CommandError("conflict", "Build commit intent no longer owns this session");
    return created[0].id;
  }

  return {
    record: recordCommit,
    reconcile: reconcileCommit,
    recoverRuntime: recoverRuntimeCommits,
    pending: () =>
      database.db
        .select({ id: changeCommitOperation.id })
        .from(changeCommitOperation)
        .where(
          and(
            eq(changeCommitOperation.source, "agent"),
            notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
          ),
        )
        .orderBy(changeCommitOperation.createdAt),
  };
}
