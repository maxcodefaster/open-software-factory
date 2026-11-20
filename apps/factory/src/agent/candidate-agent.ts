import { advanceCandidateCommit, earlierSubmissionUnchanged, noChangesToSubmit } from "./candidate";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { substrateRepositoryCloneURL } from "../runtime/endpoints";
import { type RuntimeHub, RuntimeParentOperationError } from "../runtime/hub";
import { createAgentCommitTransport } from "./commit-transport";
import { bounded, readableError } from "./native-errors";
import { type AgentTurnTransaction, createAgentTurnStore } from "./turn-store";

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
    const operations = await database.client<Array<{ id: string }>>`
      SELECT operation.id FROM factory.change_commit_operation operation
      JOIN factory.runtime_attempt original ON original.id = operation.runtime_attempt_id
      JOIN factory.change change ON change.id = operation.change_id
      JOIN factory.runtime_attempt current ON current.id = change.runtime_attempt_id
      WHERE operation.source = 'agent' AND operation.state NOT IN ('succeeded', 'failed')
        AND (original.id = ${attemptID} OR current.id = ${attemptID} AND current.state = 'ready'
          AND operation.state = 'commit-intended' AND original.state IN ('stopped', 'failed')
          AND original.workspace_id IS NOT NULL AND current.workspace_id = original.workspace_id)
      ORDER BY operation.created_at`;
    for (const operation of operations) {
      const previous = committing.get(operation.id);
      if (previous) await previous;
      if (isClosed()) return;
      await reconcileCommit(operation.id, true);
    }
  }

  async function performCommit(operationID: string, recovering: boolean) {
    if (isClosed()) return;
    const operations = await database.client<
      Array<{
        id: string;
        changeID: string;
        attemptID: string;
        branchName: string;
        expectedParentSHA: string;
        mergeParentSHA: string | null;
        commitSHA: string | null;
        commitMessage: string;
        state: string;
        lastError: string | null;
        repositoryURL: string;
        nativeIntent: unknown;
      }>
    >`
      SELECT operation.id, operation.change_id AS "changeID", operation.runtime_attempt_id AS "attemptID",
        operation.branch_name AS "branchName", operation.expected_parent_sha AS "expectedParentSHA",
        operation.merge_parent_sha AS "mergeParentSHA",
        operation.commit_sha AS "commitSHA", operation.commit_message AS "commitMessage", operation.state, operation.last_error AS "lastError",
        project.repository_url AS "repositoryURL",
        binding.intent AS "nativeIntent"
      FROM factory.change_commit_operation operation
      JOIN factory.change change ON change.id=operation.change_id
      JOIN factory.project project ON project.id=change.project_id
      JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      WHERE operation.id = ${operationID} AND operation.source = 'agent'
    `;
    const operation = operations[0];
    if (!operation || ["succeeded", "failed"].includes(operation.state)) return;
    try {
      await advanceCandidateCommit(
        database,
        operation,
        async () => {
          const payload = {
            operationId: operation.id,
            expectedSha: operation.expectedParentSHA,
            mergeParentSha: operation.mergeParentSHA ?? "",
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
            mergeParentSha: operation.mergeParentSHA ?? "",
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
            const recorded = await transaction<Array<{ id: string }>>`
              UPDATE factory.change_commit_operation
              SET state = 'succeeded', observed_remote_sha = ${commitSHA}, completed_at = now(),
                updated_at = now(), last_error = NULL
              WHERE id = ${operation.id} AND state IN ('committed', 'push-intended')
              RETURNING id
            `;
            if (!recorded[0] || !current) return;
            await transaction`
              UPDATE factory.change_agent_session
              SET state = 'committed', active_inbox_id = NULL, last_error = NULL, updated_at = now()
              WHERE change_id = ${operation.changeID}
                AND state = 'waiting' AND active_turn_id = ${operation.id}
                AND runtime_attempt_id = ${operation.attemptID} AND NOT stop_pending
                AND EXISTS(SELECT 1 FROM factory.change WHERE id = ${operation.changeID}
                  AND runtime_attempt_id = ${operation.attemptID})
                AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
                  WHERE intent.turn_id = ${operation.id} AND intent.runtime_attempt_id = ${operation.attemptID}
                    AND intent.session_id = factory.change_agent_session.opencode_session_id)
            `;
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
          const [previousSubmission] = emptyCheckout
            ? await transaction<Array<{ id: string }>>`
                SELECT id FROM factory.change_commit_operation
                WHERE change_id = ${operation.changeID} AND state = 'succeeded'
                  AND sequence < (SELECT sequence FROM factory.change_commit_operation WHERE id = ${operation.id})
                LIMIT 1`
            : [];
          const diagnostic = emptyCheckout
            ? noChangesToSubmit + (previousSubmission ? earlierSubmissionUnchanged : "")
            : "Prepared commit was not found. Files were left untouched; review the checkout before starting a new Build turn.";
          const recorded = await transaction<Array<{ id: string }>>`
            UPDATE factory.change_commit_operation SET state = 'failed',
              last_error = ${diagnostic}, completed_at = now(), updated_at = now()
            WHERE id = ${operation.id} AND state = 'commit-intended' AND commit_sha IS NULL RETURNING id`;
          if (!recorded[0]) return;
          await transaction`
            UPDATE factory.change_agent_session SET state = ${absentPreparedCommit ? "failed" : "waiting"}::factory.change_agent_state,
              last_error = ${diagnostic}, active_inbox_id = NULL, updated_at = now()
            WHERE change_id = ${operation.changeID} AND state = 'waiting' AND active_turn_id = ${operation.id}
              AND runtime_attempt_id = ${operation.attemptID} AND NOT stop_pending
              AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent WHERE intent.turn_id = ${operation.id}
                AND intent.runtime_attempt_id = ${operation.attemptID} AND intent.session_id = factory.change_agent_session.opencode_session_id)`;
        });
        return;
      }
      // Only an authority rejection proves this frame did not execute. Transport,
      // Connector and persistence errors can follow a successful commit or push.
      // A prior unresolved outcome also survives a later authority rejection.
      const rejected = cause instanceof CommandError && !recovering;
      const detail = readableError(cause);
      await turns.observeCommit(operation.id, async (transaction) => {
        const recorded = await transaction<Array<{ id: string; state: string }>>`
          UPDATE factory.change_commit_operation
          SET state = CASE WHEN ${rejected} AND last_error IS NULL THEN 'failed'::factory.change_commit_state ELSE state END,
            last_error = CASE WHEN ${rejected} AND last_error IS NULL THEN ${bounded(detail, 4_000)}
              ELSE ${bounded(`Commit outcome not confirmed. New Build waits for recovery. ${detail}`, 4_000)} END,
            completed_at = CASE WHEN ${rejected} AND last_error IS NULL THEN now() ELSE NULL END,
            updated_at = now()
          WHERE id = ${operation.id} AND state NOT IN ('succeeded', 'failed')
          RETURNING id, state
        `;
        if (!recorded[0]) return;
        await transaction`
          UPDATE factory.change_agent_session
          SET state = CASE WHEN ${recorded[0].state === "failed"} THEN 'failed'::factory.change_agent_state ELSE state END,
            last_error = (SELECT last_error FROM factory.change_commit_operation WHERE id = ${operation.id}), updated_at = now()
          WHERE change_id = ${operation.changeID}
            AND state = 'waiting' AND active_turn_id = ${operation.id}
            AND runtime_attempt_id = ${operation.attemptID} AND NOT stop_pending
            AND EXISTS(SELECT 1 FROM factory.change WHERE id = ${operation.changeID}
              AND runtime_attempt_id = ${operation.attemptID})
            AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              WHERE intent.turn_id = ${operation.id} AND intent.runtime_attempt_id = ${operation.attemptID}
                AND intent.session_id = factory.change_agent_session.opencode_session_id)
        `;
      });
    }
  }

  async function recordCommit(
    sql: AgentTurnTransaction,
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
      const modes = await sql<Array<{ mode: string }>>`SELECT mode FROM factory.ticket_conversation
        WHERE id = ${allowed[0].conversationID} FOR UPDATE`;
      if (modes[0]?.mode !== "build")
        throw new CommandError("conflict", "Build mode changed before committing");
    }
    const changeID = active.changeID;
    const operationID = turnID;
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO factory.change_commit_operation(
        id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
        integration_base_sha, merge_parent_sha, commit_message, idempotency_key, state, created_by
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
        (SELECT merge_parent_sha FROM factory.change_commit_operation integration
          WHERE integration.change_id=change.id AND integration.source='integration'
            AND integration.state='failed' AND integration.last_error='integration has conflicts'
            AND integration.sequence>COALESCE((SELECT MAX(sequence) FROM factory.change_commit_operation
              WHERE change_id=change.id AND state='succeeded'),0)
          ORDER BY integration.sequence DESC LIMIT 1),
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
    pending: () => database.client<Array<{ id: string }>>`
      SELECT id FROM factory.change_commit_operation
      WHERE source='agent' AND state NOT IN ('succeeded','failed') ORDER BY created_at`,
  };
}
