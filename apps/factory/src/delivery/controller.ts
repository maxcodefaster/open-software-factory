import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createForgejoClient,
  ForgeAmbiguousWriteError,
  type ForgeRepository,
} from "../../../../packages/forge/src/forge";
import { createAccessController, projectDevelopmentAuthorityIn } from "../access/controller";
import type { RuntimeAttemptView } from "../runtime/types";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  startVerification(verificationID: string, userID: string): Promise<RuntimeAttemptView | null>;
  startStagingReplacement(promotionID: string, userID: string): Promise<RuntimeAttemptView | null>;
  stop(attemptID: string): Promise<RuntimeAttemptView | null>;
};
type AgentController = {
  prompt(
    changeID: string,
    text: string,
    userID: string,
    commandID: string,
    repair?: boolean,
  ): Promise<unknown>;
};

const workflowPath = ".forgejo/workflows/factory-verification.yml";
const workflowID = "factory-verification.yml";

function repositoryFromURL(value: string): ForgeRepository {
  const url = new URL(value);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name) throw new Error("Project repository is not a Forge repository URL");
  return { owner, name };
}

function bounded(value: string, limit = 2_000) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function createDeliveryController(
  database: Database,
  runtime: RuntimeController,
  agent: AgentController,
  forgeOverride?: { client: ReturnType<typeof createForgejoClient>; owner: string },
) {
  const { FACTORY_FORGEJO_API_URL, FACTORY_FORGEJO_TOKEN, FACTORY_FORGEJO_OWNER } = process.env;
  function configuredForge() {
    if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER)
      throw new Error("Forgejo configuration is required");
    return {
      client: createForgejoClient({
        apiURL: FACTORY_FORGEJO_API_URL,
        token: FACTORY_FORGEJO_TOKEN,
      }),
      owner: FACTORY_FORGEJO_OWNER,
    };
  }
  const { client: forge, owner: allowedOwner } = forgeOverride ?? configuredForge();
  const running = new Set<string>();

  async function changeRow(changeID: string) {
    const rows = await database.client<
      Array<{
        id: string;
        projectID: string;
        ticketID: string;
        title: string;
        description: string;
        branchName: string;
        baseSHA: string;
        state: string;
        trashed: boolean;
        userID: string;
        repositoryURL: string;
        defaultBranch: string;
        commitSHA: string | null;
        runtimeAttemptID: string | null;
      }>
    >`
      SELECT change.id, change.project_id AS "projectID", change.ticket_id AS "ticketID",
        ticket.title, ticket.description, change.branch_name AS "branchName",
        change.base_sha AS "baseSHA", change.state, ticket.trashed_at IS NOT NULL AS trashed, change.created_by AS "userID",
        project.repository_url AS "repositoryURL", project.default_branch AS "defaultBranch",
        commit.commit_sha AS "commitSHA", change.runtime_attempt_id AS "runtimeAttemptID"
      FROM factory.change change
      JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.project project ON project.id = change.project_id
      LEFT JOIN LATERAL (
        SELECT commit_sha FROM factory.change_commit_operation
        WHERE change_id = change.id AND state = 'succeeded'
        ORDER BY sequence DESC LIMIT 1
      ) commit ON true
      WHERE change.id = ${changeID}
    `;
    return rows[0] ?? null;
  }

  async function ensurePullRequest(change: NonNullable<Awaited<ReturnType<typeof changeRow>>>) {
    const repository = repositoryFromURL(change.repositoryURL);
    if (repository.owner !== allowedOwner) {
      throw new Error("Project Forge owner is not allowed");
    }
    let operations = await database.client<
      Array<{ id: string; state: string; number: string | null; url: string | null }>
    >`
      SELECT id, state, pull_request_number AS number, pull_request_url AS url
      FROM factory.pull_request_operation WHERE change_id = ${change.id}
    `;
    if (!operations[0]) {
      operations = await database.client<
        Array<{ id: string; state: string; number: string | null; url: string | null }>
      >`
        INSERT INTO factory.pull_request_operation(
          id, change_id, repository_owner, repository_name, base_branch, head_branch,
          first_head_sha, title, body, idempotency_key
        ) VALUES (
          ${crypto.randomUUID()}, ${change.id}, ${repository.owner}, ${repository.name},
          ${change.defaultBranch}, ${change.branchName}, ${change.commitSHA}, ${change.title},
          ${bounded(change.description, 10_000)}, ${`change:${change.id}:pull-request`}
        )
        ON CONFLICT(change_id) DO NOTHING
        RETURNING id, state, pull_request_number AS number, pull_request_url AS url
      `;
      if (!operations[0]) {
        operations = await database.client<
          Array<{ id: string; state: string; number: string | null; url: string | null }>
        >`
          SELECT id, state, pull_request_number AS number, pull_request_url AS url
          FROM factory.pull_request_operation WHERE change_id = ${change.id}
        `;
      }
    }
    const operation = operations[0];
    if (!operation) throw new Error("Pull request intent was not created");
    if (operation.state === "failed") throw new Error("Pull request creation failed");
    if (operation.state !== "succeeded") {
      await database.client`
        UPDATE factory.pull_request_operation SET state = 'executing', updated_at = now()
        WHERE id = ${operation.id} AND state IN ('pending', 'ambiguous')
      `;
      try {
        const protectedWorkflow = await forge.getFile(
          repository,
          workflowPath,
          change.defaultBranch,
        );
        if (!protectedWorkflow.trim()) throw new Error("Factory Verification workflow is empty");
        await forge.ensureDefaultBranchProtection(repository, change.defaultBranch);
        const pullRequest = await forge.ensurePullRequest({
          repository,
          baseBranch: change.defaultBranch,
          headBranch: change.branchName,
          expectedHeadSha: change.commitSHA ?? "",
          title: change.title,
          body: bounded(change.description, 10_000),
        });
        await database.client`
          UPDATE factory.pull_request_operation
          SET state = 'succeeded', pull_request_number = ${pullRequest.number},
            pull_request_url = ${pullRequest.url}, completed_at = now(), updated_at = now(),
            last_error = NULL
          WHERE id = ${operation.id} AND state = 'executing'
        `;
        return { repository, pullRequest };
      } catch (cause) {
        const message = bounded(cause instanceof Error ? cause.message : "Pull request failed");
        if (cause instanceof ForgeAmbiguousWriteError) {
          await database.client`
            UPDATE factory.pull_request_operation SET state = 'ambiguous',
              last_error = ${message}, updated_at = now()
            WHERE id = ${operation.id} AND state = 'executing'
          `;
          return null;
        }
        await database.client`
          UPDATE factory.pull_request_operation SET state = 'failed', last_error = ${message},
            completed_at = now(), updated_at = now()
          WHERE id = ${operation.id} AND state = 'executing'
        `;
        throw cause;
      }
    }
    const pullRequest = await forge.getPullRequest(
      repository,
      change.defaultBranch,
      change.branchName,
    );
    if (!pullRequest) throw new Error("Persisted pull request is missing in Forgejo");
    return { repository, pullRequest };
  }

  async function stopVerification(
    repository: ForgeRepository,
    verification: { id: string; runtimeAttemptID: string | null; runnerID: string | null },
  ) {
    if (verification.runtimeAttemptID) {
      await runtime.stop(verification.runtimeAttemptID).catch(() => undefined);
    }
    if (verification.runnerID) {
      try {
        await forge.deleteRunner(repository, Number(verification.runnerID));
        await database.client`UPDATE factory.verification SET runner_id = NULL, updated_at = now()
          WHERE id = ${verification.id} AND runner_id = ${verification.runnerID}`;
      } catch {
        // The retained runner identity lets cancellation retry revocation.
      }
    }
  }

  async function ensureVerification(
    change: NonNullable<Awaited<ReturnType<typeof changeRow>>>,
    repository: ForgeRepository,
    pullRequest: Awaited<ReturnType<typeof forge.getPullRequest>> & {},
  ) {
    if (!change.commitSHA || pullRequest.headSha !== change.commitSHA || pullRequest.merged) return;
    type VerificationRow = {
      id: string;
      state: string;
      actionRunID: string | null;
      runtimeAttemptID: string | null;
      runtimeState: string | null;
      runtimeUpdatedAt: string | null;
      runnerID: string | null;
      runnerUUID: string | null;
      runnerToken: string | null;
      repairPromptedAt: string | null;
    };
    let rows = await database.client<VerificationRow[]>`
      SELECT verification.id, verification.state,
        verification.action_run_id AS "actionRunID",
        verification.runtime_attempt_id AS "runtimeAttemptID",
        attempt.state AS "runtimeState", attempt.updated_at AS "runtimeUpdatedAt",
        verification.runner_id AS "runnerID",
        verification.runner_uuid AS "runnerUUID", verification.runner_token AS "runnerToken",
        verification.repair_prompted_at AS "repairPromptedAt"
      FROM factory.verification verification
      LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
      WHERE verification.change_id = ${change.id} AND verification.commit_sha = ${change.commitSHA}
    `;
    if (!rows[0]) {
      const candidateWorkflow = await forge.getFile(repository, workflowPath, change.commitSHA);
      const protectedWorkflow = await forge.getFile(repository, workflowPath, change.defaultBranch);
      if (candidateWorkflow !== protectedWorkflow) {
        throw new Error("Change modifies the protected Factory Verification workflow");
      }
      const verificationID = crypto.randomUUID();
      await database.client.begin(async (sql) => {
        const active = await sql<Array<{ id: string }>>`
          SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          WHERE change.id = ${change.id} AND change.state = 'active' AND change.cancel_requested_at IS NULL
            AND ticket.trashed_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id = change.id AND (session.state = 'stopped' OR session.stop_pending))
          FOR UPDATE OF change, ticket
        `;
        if (!active[0]) return;
        await sql`INSERT INTO factory.verification(
          id, change_id, commit_sha, pull_request_number, runner_name, created_by
        ) VALUES (
          ${verificationID}, ${change.id}, ${change.commitSHA}, ${pullRequest.number},
          ${`factory-${verificationID.replaceAll("-", "").slice(0, 16)}`}, ${change.userID}
        )
        ON CONFLICT(change_id, commit_sha) DO NOTHING
        `;
      });
      rows = await database.client<VerificationRow[]>`
        SELECT verification.id, verification.state,
          verification.action_run_id AS "actionRunID",
          verification.runtime_attempt_id AS "runtimeAttemptID",
          attempt.state AS "runtimeState", attempt.updated_at AS "runtimeUpdatedAt",
          verification.runner_id AS "runnerID",
          verification.runner_uuid AS "runnerUUID", verification.runner_token AS "runnerToken",
          verification.repair_prompted_at AS "repairPromptedAt"
        FROM factory.verification verification
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
        WHERE verification.change_id = ${change.id} AND verification.commit_sha = ${change.commitSHA}
      `;
    }
    const verification = rows[0];
    if (!verification || ["succeeded", "cancelled"].includes(verification.state)) return;
    const activeVerificationID = verification.id;
    async function stillActive() {
      const [current] = await database.client<Array<{ active: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM factory.verification verification
          JOIN factory.change change ON change.id = verification.change_id
          JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          WHERE verification.id = ${activeVerificationID}
            AND verification.state NOT IN ('succeeded', 'cancelled')
            AND change.state = 'active' AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id = change.id AND (session.state = 'stopped' OR session.stop_pending))) AS active
      `;
      return current?.active === true;
    }
    const actionRuns = await forge.listActionRuns(repository, change.commitSHA);
    const actionRun = actionRuns.find(
      (run) => run.workflowID === workflowID && run.event === "pull_request",
    );
    if (!actionRun) return;
    if (!(await stillActive())) return;
    if (!verification.actionRunID) {
      await database.client`
        UPDATE factory.verification SET action_run_id = ${actionRun.id},
          action_run_url = ${actionRun.url}, updated_at = now()
        WHERE id = ${verification.id} AND action_run_id IS NULL
      `;
      verification.actionRunID = String(actionRun.id);
    }
    if (["success", "failure", "cancelled", "skipped"].includes(actionRun.status)) {
      const succeeded = actionRun.status === "success";
      const summary = succeeded
        ? `Forgejo Actions verified ${change.commitSHA.slice(0, 12)}.`
        : `Forgejo Actions ${actionRun.status} for ${change.commitSHA.slice(0, 12)}. Open the run for full logs: ${actionRun.url}`;
      await database.client`
        UPDATE factory.verification SET state = ${succeeded ? "succeeded" : "failed"}::factory.verification_state,
          summary = ${bounded(summary)}, completed_at = now(), updated_at = now()
        WHERE id = ${verification.id} AND state NOT IN ('succeeded', 'failed', 'cancelled')
      `;
      await stopVerification(repository, verification);
      if (!succeeded && !verification.repairPromptedAt) {
        const sessions = await database.client<Array<{ state: string }>>`
          SELECT state FROM factory.change_agent_session WHERE change_id = ${change.id}
        `;
        if (sessions[0]?.state !== "committed") return;
        const failures = await database.client<Array<{ count: number }>>`
          SELECT COUNT(*)::integer AS count FROM factory.verification
          WHERE change_id = ${change.id} AND state = 'failed' AND repair_prompted_at IS NOT NULL
        `;
        if (Number(failures[0]?.count ?? 0) >= 3)
          throw new Error(
            "Automatic repair paused after three failed Verifications. Review the failures and resume Build manually.",
          );
        await agent.prompt(
          change.id,
          [
            "The Forgejo Actions verification for your latest commit failed.",
            summary,
            "Inspect the current checkout, fix the failure, run the local checks, and finish without committing or pushing. Factory will create the next commit.",
          ].join("\n\n"),
          change.userID,
          verification.id,
          true,
        );
        await database.client`
          UPDATE factory.verification SET repair_prompted_at = now(), updated_at = now()
          WHERE id = ${verification.id} AND repair_prompted_at IS NULL
        `;
      }
      return;
    }
    if (
      actionRun.status === "waiting" &&
      verification.runtimeState === "ready" &&
      verification.runtimeUpdatedAt &&
      Date.now() - new Date(verification.runtimeUpdatedAt).getTime() > 45_000
    ) {
      await stopVerification(repository, verification);
      return;
    }
    const replaceRunner = Boolean(
      verification.runtimeAttemptID &&
        ["failed", "stopped", "cleanup-failed"].includes(verification.runtimeState ?? ""),
    );
    if (
      replaceRunner ||
      !verification.runnerID ||
      !verification.runnerUUID ||
      !verification.runnerToken
    ) {
      if (verification.runnerID) {
        await forge.deleteRunner(repository, Number(verification.runnerID));
      }
      if (!(await stillActive())) return;
      const names = await database.client<Array<{ name: string }>>`
        SELECT runner_name AS name FROM factory.verification WHERE id = ${verification.id}
      `;
      const registration = await forge.registerEphemeralRunner(
        repository,
        names[0]?.name ?? `factory-${verification.id.replaceAll("-", "").slice(0, 16)}`,
      );
      const saved = await database.client`
        UPDATE factory.verification SET
          runtime_attempt_id = CASE WHEN ${replaceRunner} THEN NULL ELSE runtime_attempt_id END,
          runner_id = ${registration.id}, runner_uuid = ${registration.uuid},
          runner_token = ${registration.token}, updated_at = now()
        WHERE id = ${verification.id} AND runner_id IS NOT DISTINCT FROM ${verification.runnerID}::bigint
          AND state IN ('pending', 'runner-starting', 'running')
          AND EXISTS(SELECT 1 FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
            WHERE change.id = ${change.id} AND change.state = 'active' AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id = change.id AND (session.state = 'stopped' OR session.stop_pending)))
      `;
      if (saved.count !== 1) {
        // Retain a late external outcome so cancellation can retry revocation.
        await database.client`UPDATE factory.verification SET runner_id = ${registration.id},
          runner_uuid = ${registration.uuid}, runner_token = ${registration.token}, updated_at = now()
          WHERE id = ${verification.id} AND state = 'cancelled'
            AND (runner_id IS NULL OR runner_id = ${verification.runnerID}::bigint)`;
        await forge.deleteRunner(repository, registration.id);
        await database.client`UPDATE factory.verification SET runner_id = NULL
          WHERE id = ${verification.id} AND state = 'cancelled' AND runner_id = ${registration.id}`;
        return;
      }
      if (replaceRunner) {
        verification.runtimeAttemptID = null;
        verification.runtimeState = null;
        verification.runtimeUpdatedAt = null;
      }
      verification.runnerID = String(registration.id);
      verification.runnerUUID = registration.uuid;
      verification.runnerToken = registration.token;
    }
    if (!(await stillActive())) return;
    if (
      !verification.runtimeAttemptID ||
      ["failed", "stopped", "cleanup-failed"].includes(verification.runtimeState ?? "")
    ) {
      await runtime.startVerification(verification.id, change.userID);
    }
    await database.client`
      UPDATE factory.verification SET
        state = ${actionRun.status === "running" ? "running" : "runner-starting"}::factory.verification_state,
        updated_at = now()
      WHERE id = ${verification.id} AND state IN ('pending', 'runner-starting', 'running')
    `;
  }

  async function cancelVerifications(
    changeID: string,
    repository: ForgeRepository,
    keepCommitSHA: string | null = null,
  ) {
    const verifications = await database.client<
      Array<{ id: string; runtimeAttemptID: string | null; runnerID: string | null }>
    >`
      UPDATE factory.verification verification SET state = 'cancelled', completed_at = COALESCE(completed_at, now()),
        updated_at = now()
      WHERE change_id = ${changeID}
        AND (${keepCommitSHA}::text IS NULL OR (
          commit_sha <> ${keepCommitSHA}
          AND ${keepCommitSHA} = (
            SELECT commit.commit_sha FROM factory.change_commit_operation commit
            WHERE commit.change_id = verification.change_id AND commit.state = 'succeeded'
            ORDER BY commit.sequence DESC LIMIT 1
          )
        ))
        AND (state IN ('pending', 'runner-starting', 'running') OR (
          state = 'cancelled' AND (runner_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM factory.runtime_attempt attempt
            WHERE attempt.id = verification.runtime_attempt_id
              AND attempt.state NOT IN ('stopped', 'failed')
          ))
        ))
      RETURNING id, runtime_attempt_id AS "runtimeAttemptID", runner_id AS "runnerID"
    `;
    for (const verification of verifications) await stopVerification(repository, verification);
  }

  async function reconcileMerge(
    change: NonNullable<Awaited<ReturnType<typeof changeRow>>>,
    repository: ForgeRepository,
  ) {
    const rows = await database.client<
      Array<{
        id: string;
        state: string;
        commitSHA: string;
        baseSHA: string;
        pullRequestNumber: string;
      }>
    >`
      SELECT merge.id, merge.state, merge.commit_sha AS "commitSHA",
        merge.base_sha AS "baseSHA", merge.pull_request_number AS "pullRequestNumber"
      FROM factory.merge_operation merge WHERE merge.change_id = ${change.id}
    `;
    const operation = rows[0];
    if (!operation || operation.state === "failed") return;
    if (operation.state !== "succeeded") {
      const pullRequest = await forge.getPullRequest(
        repository,
        change.defaultBranch,
        change.branchName,
      );
      const base = await forge.getDefaultBranch(repository);
      if (
        base.headSha !== operation.commitSHA &&
        (!pullRequest ||
          pullRequest.headSha !== operation.commitSHA ||
          base.headSha !== operation.baseSHA)
      ) {
        await database.client`
          UPDATE factory.merge_operation SET state = 'failed',
            last_error = 'Delivery gate moved before merge', completed_at = now(), updated_at = now()
          WHERE id = ${operation.id} AND state NOT IN ('succeeded', 'failed')
        `;
        return;
      }
      await database.client`
        UPDATE factory.merge_operation SET state = 'executing', updated_at = now()
        WHERE id = ${operation.id} AND state IN ('pending', 'ambiguous')
      `;
      try {
        const merged =
          base.headSha === operation.commitSHA
            ? { headSha: base.headSha }
            : await forge.mergeFastForward(
                repository,
                Number(operation.pullRequestNumber),
                operation.commitSHA,
                change.defaultBranch,
              );
        await database.client.begin(async (transaction) => {
          await transaction`
            UPDATE factory.merge_operation SET state = 'succeeded',
              observed_default_sha = ${merged.headSha}, completed_at = now(), updated_at = now(),
              last_error = NULL WHERE id = ${operation.id}
          `;
          await transaction`
            INSERT INTO factory.promotion_operation(
              id, change_id, project_id, commit_sha, previous_runtime_attempt_id
            )
            SELECT ${crypto.randomUUID()}, ${change.id}, ${change.projectID}, ${operation.commitSHA},
              runtime_attempt_id FROM factory.staging_preview WHERE project_id = ${change.projectID}
            ON CONFLICT(change_id) DO NOTHING
          `;
          await transaction`
            UPDATE factory.change SET state = 'delivering', failure = NULL, version = version + 1
            WHERE id = ${change.id}
          `;
        });
      } catch (cause) {
        const message = bounded(cause instanceof Error ? cause.message : "Merge failed");
        await database.client`
          UPDATE factory.merge_operation
          SET state = 'ambiguous',
            last_error = ${message},
            completed_at = NULL,
            updated_at = now() WHERE id = ${operation.id}
        `;
      }
    }
  }

  async function reconcilePromotion(
    change: NonNullable<Awaited<ReturnType<typeof changeRow>>>,
    repository: ForgeRepository,
  ) {
    const rows = await database.client<
      Array<{
        id: string;
        commitSHA: string;
        state: string;
        previousAttemptID: string | null;
        replacementAttemptID: string | null;
        replacementState: string | null;
        lastError: string | null;
      }>
    >`
      SELECT promotion.id, promotion.commit_sha AS "commitSHA", promotion.state, promotion.last_error AS "lastError",
        promotion.previous_runtime_attempt_id AS "previousAttemptID",
        promotion.replacement_runtime_attempt_id AS "replacementAttemptID",
        attempt.state AS "replacementState"
      FROM factory.promotion_operation promotion
      LEFT JOIN factory.runtime_attempt attempt
        ON attempt.id = promotion.replacement_runtime_attempt_id
      WHERE promotion.change_id = ${change.id}
    `;
    const promotion = rows[0];
    if (!promotion || promotion.state === "failed") return;
    if (promotion.state === "succeeded") {
      if (promotion.lastError) await cleanupDelivery(change, repository, promotion);
      return;
    }
    if (!promotion.replacementAttemptID) {
      await runtime.startStagingReplacement(promotion.id, change.userID);
      return;
    }
    if (["failed", "stopped", "cleanup-failed"].includes(promotion.replacementState ?? "")) {
      await database.client`
        UPDATE factory.promotion_operation SET state = 'failed',
          last_error = 'Replacement Staging failed before readiness', completed_at = now(),
          updated_at = now() WHERE id = ${promotion.id}
      `;
      return;
    }
    if (promotion.replacementState !== "ready") return;
    await database.client.begin(async (transaction) => {
      await transaction`
        UPDATE factory.promotion_operation SET state = 'switching', updated_at = now()
        WHERE id = ${promotion.id} AND state = 'starting'
      `;
      await transaction`
        UPDATE factory.staging_preview
        SET revision = ${promotion.commitSHA},
          runtime_attempt_id = ${promotion.replacementAttemptID}, updated_at = now()
        WHERE project_id = ${change.projectID}
      `;
      await transaction`
        UPDATE factory.promotion_operation SET state = 'succeeded', completed_at = now(),
          updated_at = now(), last_error = 'Delivery cleanup pending' WHERE id = ${promotion.id}
      `;
      await transaction`
        UPDATE factory.change SET state = 'delivered', cancel_requested_at = now(),
          failure = NULL, version = version + 1 WHERE id = ${change.id}
      `;
      await transaction`
        UPDATE factory.ticket SET state = 'done', version = version + 1, updated_at = now()
        WHERE id = ${change.ticketID}
      `;
    });
    await cleanupDelivery(change, repository, promotion);
  }

  async function cleanupDelivery(
    change: NonNullable<Awaited<ReturnType<typeof changeRow>>>,
    repository: ForgeRepository,
    promotion: { id: string; previousAttemptID: string | null },
  ) {
    try {
      if (promotion.previousAttemptID) await runtime.stop(promotion.previousAttemptID);
      if (change.runtimeAttemptID) await runtime.stop(change.runtimeAttemptID);
      const verifications = await database.client<
        Array<{ runtimeAttemptID: string | null; runnerID: string | null }>
      >`
      SELECT runtime_attempt_id AS "runtimeAttemptID", runner_id AS "runnerID"
      FROM factory.verification WHERE change_id = ${change.id}
    `;
      for (const verification of verifications) {
        if (verification.runtimeAttemptID) await runtime.stop(verification.runtimeAttemptID);
        if (verification.runnerID)
          await forge.deleteRunner(repository, Number(verification.runnerID));
      }
      await forge.deleteBranch(repository, change.branchName);
      await database.client`UPDATE factory.promotion_operation SET last_error = NULL, updated_at = now() WHERE id = ${promotion.id}`;
    } catch (cause) {
      await database.client`UPDATE factory.promotion_operation SET last_error = ${bounded(cause instanceof Error ? cause.message : "Delivery cleanup failed")}, updated_at = now() WHERE id = ${promotion.id}`;
    }
  }

  async function reconcile(changeID: string) {
    if (running.has(changeID)) return;
    running.add(changeID);
    try {
      const change = await changeRow(changeID);
      if (!change) return;
      if (change.trashed || ["cancelling", "cancelled"].includes(change.state)) {
        await cancelVerifications(change.id, repositoryFromURL(change.repositoryURL));
        return;
      }
      if (!change.commitSHA || change.state === "failed") return;
      await cancelVerifications(
        change.id,
        repositoryFromURL(change.repositoryURL),
        change.commitSHA,
      );
      if (change.state === "delivered") {
        await reconcilePromotion(change, repositoryFromURL(change.repositoryURL));
        return;
      }
      const pull = await ensurePullRequest(change);
      if (!pull) return;
      const merge = await database.client<Array<{ exists: boolean }>>`
        SELECT EXISTS(
          SELECT 1 FROM factory.merge_operation WHERE change_id = ${change.id}
        ) AS exists
      `;
      if (merge[0]?.exists) {
        await reconcileMerge(change, pull.repository);
        await reconcilePromotion(change, pull.repository);
        return;
      }
      await ensureVerification(change, pull.repository, pull.pullRequest);
    } catch (cause) {
      const message = bounded(cause instanceof Error ? cause.message : "Delivery failed");
      await database.client`
        UPDATE factory.change SET failure = ${message}, version = version + 1
        WHERE id = ${changeID} AND state NOT IN ('cancelled', 'delivered') AND failure IS DISTINCT FROM ${message}
      `;
    } finally {
      running.delete(changeID);
    }
  }

  async function reconcileAll() {
    const changes = await database.client<Array<{ id: string }>>`
      SELECT DISTINCT change.id
      FROM factory.change change
      JOIN factory.change_commit_operation commit ON commit.change_id = change.id
      LEFT JOIN factory.promotion_operation promotion ON promotion.change_id = change.id
      WHERE commit.state = 'succeeded'
        AND (change.state <> 'cancelled' OR EXISTS(
          SELECT 1 FROM factory.verification verification
          LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
          WHERE verification.change_id = change.id
            AND (verification.runner_id IS NOT NULL
              OR attempt.state NOT IN ('stopped', 'failed'))
        ))
        AND (change.state <> 'delivered' OR promotion.last_error IS NOT NULL)
    `;
    for (const change of changes) void reconcile(change.id);
  }

  return {
    async recover() {
      await database.client`
        UPDATE factory.pull_request_operation SET state = 'ambiguous', updated_at = now()
        WHERE state = 'executing'
      `;
      await database.client`
        UPDATE factory.merge_operation SET state = 'ambiguous', updated_at = now()
        WHERE state = 'executing'
      `;
      await reconcileAll();
      setInterval(() => void reconcileAll(), 1_000).unref();
    },
    async approve(changeID: string, userID: string) {
      const change = await changeRow(changeID);
      if (change)
        await createAccessController(database).requireDevelopment(userID, change.projectID);
      if (!change?.commitSHA) throw new Error("Change has no delivered commit candidate");
      const repository = repositoryFromURL(change.repositoryURL);
      const pullRequest = await forge.getPullRequest(
        repository,
        change.defaultBranch,
        change.branchName,
      );
      const base = await forge.getDefaultBranch(repository);
      const verifications = await database.client<
        Array<{ id: string; actionRunID: string; commitSHA: string }>
      >`
        SELECT id, action_run_id AS "actionRunID", commit_sha AS "commitSHA"
        FROM factory.verification
        WHERE change_id = ${changeID} AND commit_sha = ${change.commitSHA} AND state = 'succeeded'
      `;
      const verification = verifications[0];
      if (
        !verification ||
        !pullRequest ||
        pullRequest.headSha !== verification.commitSHA ||
        base.headSha !== change.baseSHA
      ) {
        throw new Error("Current commit is not eligible for delivery");
      }
      const approvalID = crypto.randomUUID();
      const mergeID = crypto.randomUUID();
      await database.client.begin(async (transaction) => {
        await projectDevelopmentAuthorityIn(transaction, userID, change.projectID);
        const [current] = await transaction<
          Array<{ state: string }>
        >`SELECT change.state FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          WHERE change.id = ${changeID} AND ticket.trashed_at IS NULL FOR UPDATE OF change, ticket`;
        const [work] =
          await transaction`SELECT id FROM factory.agent_turn WHERE change_id = ${changeID}
          AND state IN ('pending', 'dispatching', 'running', 'uncertain')`;
        const [session] = await transaction<
          Array<{ state: string }>
        >`SELECT state FROM factory.change_agent_session WHERE change_id = ${changeID}`;
        const [commit] = await transaction<
          Array<{ sha: string }>
        >`SELECT commit_sha AS sha FROM factory.change_commit_operation
          WHERE change_id = ${changeID} AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1`;
        if (
          current?.state !== "active" ||
          work ||
          (session && session.state !== "committed") ||
          commit?.sha !== verification.commitSHA
        )
          throw new Error("Wait for the current implementation to finish before delivery.");
        await transaction`
          INSERT INTO factory.delivery_approval(
            id, change_id, verification_id, commit_sha, approved_by
          ) VALUES (
            ${approvalID}, ${changeID}, ${verification.id}, ${verification.commitSHA}, ${userID}
          )
          ON CONFLICT(verification_id) DO NOTHING
        `;
        await transaction`
          INSERT INTO factory.merge_operation(
            id, change_id, delivery_approval_id, pull_request_number,
            base_sha, commit_sha, idempotency_key
          )
          SELECT ${mergeID}, ${changeID}, approval.id, ${pullRequest.number},
            ${change.baseSHA}, ${verification.commitSHA}, ${`change:${changeID}:merge`}
          FROM factory.delivery_approval approval
          WHERE approval.verification_id = ${verification.id}
          ON CONFLICT(change_id) DO NOTHING
        `;
        await transaction`
          UPDATE factory.change SET state = 'delivering', failure = NULL, version = version + 1
          WHERE id = ${changeID} AND state = 'active'
        `;
      });
      void reconcile(changeID);
      return this.get(changeID);
    },
    async cancel(changeID: string) {
      const change = await changeRow(changeID);
      if (!change) return;
      const repository = repositoryFromURL(change.repositoryURL);
      await cancelVerifications(changeID, repository);
    },
    async stopForTrash(changeID: string) {
      const change = await changeRow(changeID);
      if (!change) return;
      const repository = repositoryFromURL(change.repositoryURL);
      await cancelVerifications(changeID, repository);
      const deadline = Date.now() + 60_000;
      while (running.has(changeID) && Date.now() < deadline) await Bun.sleep(50);
      if (running.has(changeID)) throw new Error("Verification stop is not confirmed");
      // Observe late runner registration before allowing Restore, then revoke it.
      await cancelVerifications(changeID, repository);
      const retained = await database.client<
        Array<{ id: string; runtimeAttemptID: string | null; runnerID: string | null }>
      >`
        SELECT id, runtime_attempt_id AS "runtimeAttemptID", runner_id AS "runnerID" FROM factory.verification
        WHERE change_id = ${changeID} AND runner_id IS NOT NULL`;
      for (const verification of retained) await stopVerification(repository, verification);
      const [remaining] =
        await database.client`SELECT id FROM factory.verification WHERE change_id = ${changeID} AND runner_id IS NOT NULL LIMIT 1`;
      if (remaining) throw new Error("Verification runner revocation is not confirmed");
    },
    async get(changeID: string) {
      const rows = await database.client<Array<Record<string, unknown>>>`
        SELECT pr.pull_request_number AS "pullRequestNumber",
          pr.pull_request_url AS "pullRequestUrl", pr.state AS "pullRequestState",
          verification.commit_sha AS "verificationCommitSha",
          verification.state AS "verificationState",
          verification.summary AS "verificationSummary",
          verification.action_run_url AS "actionRunUrl",
          approval.approved_at AS "approvedAt",
          merge.state AS "mergeState", merge.observed_default_sha AS "mergedCommitSha",
          promotion.state AS "promotionState",
          promotion.last_error AS "cleanupError",
          promotion.replacement_runtime_attempt_id AS "replacementRuntimeAttemptId",
          replacement.state AS "replacementRuntimeState"
        FROM factory.change change
        LEFT JOIN factory.pull_request_operation pr ON pr.change_id = change.id
        LEFT JOIN LATERAL (
          SELECT * FROM factory.verification WHERE change_id = change.id
            AND commit_sha = (SELECT commit_sha FROM factory.change_commit_operation
              WHERE change_id = change.id AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1)
          ORDER BY created_at DESC LIMIT 1
        ) verification ON true
        LEFT JOIN factory.delivery_approval approval
          ON approval.verification_id = verification.id
        LEFT JOIN factory.merge_operation merge ON merge.change_id = change.id
        LEFT JOIN factory.promotion_operation promotion ON promotion.change_id = change.id
        LEFT JOIN factory.runtime_attempt replacement
          ON replacement.id = promotion.replacement_runtime_attempt_id
        WHERE change.id = ${changeID}
      `;
      return rows[0] ?? null;
    },
    reconcile,
  };
}
