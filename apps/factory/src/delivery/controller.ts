import type { z } from "zod";
import type { deliveryDelegationInput } from "../../../../packages/change-domain/src/delivery";
import { candidateReviewResultInput } from "../../../../packages/conversation-domain/src/candidate-review";
import {
  verificationChangeScope,
  verificationDiagnosisInput,
  verificationRepairInstructions,
} from "../../../../packages/conversation-domain/src/verification";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createForgejoClient,
  ForgeAmbiguousWriteError,
  type ForgeRepository,
} from "../../../../packages/forge/src/forge";
import { lockChangeWriterIn } from "../access/change-writer";
import {
  createAccessController,
  projectAuthorityIn,
  projectDevelopmentAuthorityIn,
} from "../access/controller";
import { CommandError } from "../command-error";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import { monitoringCandidate } from "../monitoring/candidate";
import type { RuntimeAttemptView } from "../runtime/types";
import { createDeliveryCoordination, deliveryDelegationIn } from "./coordination";
import type { createChangeIntegration } from "./integration";
import { createDeliveryPromotion } from "./promotion";
import { retryPromotion } from "./promotion-retry";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  startVerification(verificationID: string, userID: string): Promise<RuntimeAttemptView | null>;
  startStagingReplacement(promotionID: string, userID: string): Promise<RuntimeAttemptView | null>;
  stop(attemptID: string): Promise<RuntimeAttemptView | null>;
};
type AgentController = {
  review?(changeID: string, reviewID: string, userID: string): Promise<unknown>;
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
  retireBranch: (changeID: string) => Promise<void>,
  forgeOverride?: { client: ReturnType<typeof createForgejoClient>; owner: string },
  integration?: Pick<ReturnType<typeof createChangeIntegration>, "reconcile">,
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
  const reconcilePromotion = createDeliveryPromotion(database, runtime, forge, retireBranch);
  const running = new Set<string>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let reconcilingAll = false;
  const coordination = createDeliveryCoordination(database);
  async function failedCorrections(changeID: string) {
    const [row] = await database.client<{ count: number }[]>`
      SELECT ((SELECT COUNT(*) FROM factory.verification WHERE change_id=${changeID}
        AND state='failed' AND repair_prompted_at IS NOT NULL)
        + (SELECT COUNT(*) FROM factory.candidate_review WHERE change_id=${changeID}
          AND state='changes-requested' AND repair_prompted_at IS NOT NULL))::integer AS count`;
    return Number(row?.count ?? 0);
  }

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
        deliveryWaitingSHA: string | null;
        deliveryWaitingPolicyID: string | null;
      }>
    >`
      SELECT change.id, change.project_id AS "projectID", change.ticket_id AS "ticketID",
        ticket.title, ticket.description, change.branch_name AS "branchName",
        COALESCE(commit.integration_base_sha,change.base_sha) AS "baseSHA", change.state, ticket.trashed_at IS NOT NULL AS trashed, change.created_by AS "userID",
        project.repository_url AS "repositoryURL", project.default_branch AS "defaultBranch",
        commit.commit_sha AS "commitSHA", change.runtime_attempt_id AS "runtimeAttemptID",
        change.delivery_waiting_sha AS "deliveryWaitingSHA",change.delivery_waiting_policy_id AS "deliveryWaitingPolicyID"
      FROM factory.change change
      JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.project project ON project.id = change.project_id
      LEFT JOIN LATERAL (
        SELECT commit_sha,integration_base_sha FROM factory.change_commit_operation
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
      const [attempt] = await database.client<{ state: string; stopping: boolean }[]>`
        SELECT state,stop_intended_at IS NOT NULL AS stopping FROM factory.runtime_attempt
        WHERE id=${verification.runtimeAttemptID}`;
      // Stop is durable intent, not completed cleanup. Its runtime owner keeps
      // reconciling; another Delivery sweep must not reset its retry policy.
      if (attempt && attempt.state !== "stopped" && !attempt.stopping)
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

  async function verificationCleanupConfirmed(verificationID: string) {
    const [confirmed] = await database.client`SELECT verification.id
      FROM factory.verification verification
      WHERE verification.id=${verificationID} AND verification.runner_id IS NULL
        AND (verification.runtime_attempt_id IS NULL OR EXISTS(
          SELECT 1 FROM factory.runtime_attempt attempt
          WHERE attempt.id=verification.runtime_attempt_id AND attempt.state='stopped'
        ))`;
    return Boolean(confirmed);
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
      diagnosis: unknown;
    };
    let rows = await database.client<VerificationRow[]>`
      SELECT verification.id, verification.state,
        verification.action_run_id AS "actionRunID",
        verification.runtime_attempt_id AS "runtimeAttemptID",
        attempt.state AS "runtimeState", attempt.updated_at AS "runtimeUpdatedAt",
        verification.runner_id AS "runnerID",
        verification.runner_uuid AS "runnerUUID", verification.runner_token AS "runnerToken",
        verification.repair_prompted_at AS "repairPromptedAt", verification.diagnosis
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
          verification.repair_prompted_at AS "repairPromptedAt", verification.diagnosis
        FROM factory.verification verification
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
        WHERE verification.change_id = ${change.id} AND verification.commit_sha = ${change.commitSHA}
      `;
    }
    const verification = rows[0];
    if (!verification || verification.state === "cancelled") return;
    if (verification.state === "succeeded") {
      await stopVerification(repository, verification);
      return;
    }
    const activeVerificationID = verification.id;
    async function stillActive() {
      const [current] = await database.client<Array<{ active: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM factory.verification verification
          JOIN factory.change change ON change.id = verification.change_id
          JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          WHERE verification.id = ${activeVerificationID}
            AND verification.state NOT IN ('succeeded', 'cancelled')
            AND verification.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
              WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
            AND change.state = 'active' AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id = change.id AND (session.state = 'stopped' OR session.stop_pending))) AS active
      `;
      return current?.active === true;
    }
    const actionRuns = await forge.listActionRuns(repository, change.commitSHA);
    const actionRun = actionRuns.find(
      (run) =>
        run.workflowID === workflowID &&
        run.event === "pull_request" &&
        (!verification.actionRunID || String(run.id) === verification.actionRunID),
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
      let diagnosis = succeeded
        ? null
        : verification.diagnosis
          ? verificationDiagnosisInput.parse(verification.diagnosis)
          : verificationDiagnosisInput.parse(
              await forge.diagnoseVerification(repository, actionRun.id, change.commitSHA),
            );
      if (diagnosis?.kind === "pending" || !(await stillActive())) return;
      if (!succeeded && !diagnosis) throw new Error("Failed Verification requires its diagnosis");
      // Reuse the compact observation column, preserving historical failure diagnosis.
      // No new log store, workflow scheduler or agent-authored result authority.
      let receipt = null;
      if (succeeded) {
        receipt = await forge.observeVerification(repository, actionRun.id, change.commitSHA);
        if (receipt.status !== "success" && receipt.status !== "unknown") return;
        try {
          const [before, after] = await Promise.all([
            forge.listFiles(repository, change.baseSHA),
            forge.listFiles(repository, change.commitSHA),
          ]);
          receipt.changes = verificationChangeScope(change.baseSHA, before, after);
        } catch {
          receipt.changes = null;
        }
      }
      if (!(await stillActive())) return;
      const summary = diagnosis
        ? diagnosis.summary
        : `Forgejo Actions passed ${change.commitSHA.slice(0, 12)}.${receipt?.complete ? "" : " Detailed check observations are incomplete."}`;
      const [recorded] = await database.client<{ diagnosis: unknown }[]>`
        UPDATE factory.verification SET state = ${succeeded ? "succeeded" : "failed"}::factory.verification_state,
          summary = ${bounded(summary)},
          diagnosis=CASE WHEN ${succeeded} THEN
            CASE WHEN octet_length((COALESCE(diagnosis,'{}'::jsonb) || ${JSON.stringify({ receipt })}::jsonb)::text)<=24000
              THEN COALESCE(diagnosis,'{}'::jsonb) || ${JSON.stringify({ receipt })}::jsonb ELSE diagnosis END
            ELSE ${diagnosis ? JSON.stringify(diagnosis) : null}::jsonb END,
          completed_at = now(), updated_at = now()
        WHERE id = ${verification.id} AND state NOT IN ('succeeded', 'cancelled')
          AND (diagnosis IS NULL OR ${succeeded})
        RETURNING diagnosis
      `;
      if (!succeeded) {
        // A competing reconciler may have saved another observed attempt.
        // The correction must use the saved packet, never this process's later read.
        const persisted =
          recorded ??
          (verification.diagnosis
            ? verification
            : (
                await database.client<
                  { diagnosis: unknown }[]
                >`SELECT diagnosis FROM factory.verification WHERE id=${verification.id}`
              )[0]);
        diagnosis = persisted?.diagnosis
          ? verificationDiagnosisInput.parse(persisted.diagnosis)
          : null;
      }
      await stopVerification(repository, verification);
      // The next Build/Review has its own private Docker state. Wait for the
      // previous runtime's confirmed cleanup, not just its completed checks.
      if (!(await verificationCleanupConfirmed(verification.id))) return;
      if (!succeeded && diagnosis?.kind === "check-failed" && !verification.repairPromptedAt) {
        if (!(await stillActive())) return;
        const sessions = await database.client<Array<{ state: string }>>`
          SELECT state FROM factory.change_agent_session WHERE change_id = ${change.id}
        `;
        if (sessions[0]?.state !== "committed") return;
        if ((await failedCorrections(change.id)) >= 3)
          throw new Error(
            "Automatic repair paused after three failed Verifications. Review the failures and resume Build manually.",
          );
        await agent.prompt(
          change.id,
          verificationRepairInstructions({
            verificationId: verification.id,
            commit: change.commitSHA,
            runURL: actionRun.url,
            diagnosis,
          }),
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

  async function ensureReview(change: NonNullable<Awaited<ReturnType<typeof changeRow>>>) {
    const [verification] = await database.client<{ id: string }[]>`
      SELECT id FROM factory.verification
      WHERE change_id=${change.id} AND commit_sha=${change.commitSHA} AND state='succeeded'`;
    if (!verification || !(await verificationCleanupConfirmed(verification.id))) return;
    await database.client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by,focus_review_id)
      VALUES(${crypto.randomUUID()},${verification.id},${change.id},${change.commitSHA},${change.baseSHA},${change.userID},
        (SELECT review.id FROM factory.candidate_review review JOIN factory.agent_turn turn ON turn.id=review.turn_id
          WHERE review.change_id=${change.id} AND review.commit_sha<>${change.commitSHA}
            AND review.state IN ('passed','changes-requested') AND turn.state='completed'
            AND (review.state='passed' OR review.repair_prompted_at IS NOT NULL)
          ORDER BY review.created_at DESC,review.ordinal DESC LIMIT 1))
      ON CONFLICT(verification_id,ordinal) DO NOTHING`;
    const [review] = await database.client<
      {
        id: string;
        userID: string;
        turnID: string | null;
        state: string;
        result: unknown;
        repairCommandID: string;
        repaired: boolean;
        findingSourceID: string | null;
      }[]
    >`SELECT id,turn_id AS "turnID",state,result,repair_command_id AS "repairCommandID",
      repair_prompted_at IS NOT NULL AS repaired,created_by AS "userID",finding_source_id AS "findingSourceID"
      FROM factory.candidate_review
      WHERE verification_id=${verification.id} AND commit_sha=${change.commitSHA}
      ORDER BY ordinal DESC LIMIT 1`;
    if (!review) return;
    const [session] = await database.client<{ state: string; stopping: boolean }[]>`
      SELECT state,stop_pending AS stopping FROM factory.change_agent_session WHERE change_id=${change.id}`;
    if (session?.stopping || (session && session.state !== "committed")) return;
    const [work] =
      await database.client`SELECT id FROM factory.agent_turn WHERE change_id=${change.id}
      AND state IN ('pending','dispatching','running','uncertain')`;
    if (work) return;
    if (!review.turnID) {
      if (!agent.review) throw new Error("Independent candidate review is not configured");
      await agent.review(change.id, review.id, review.userID);
      return;
    }
    if (review.state !== "changes-requested" || review.repaired) return;
    if (!review.findingSourceID) {
      // One fresh, batched check only when discovery proposes blockers. Its
      // separate row retains the original report and uses all existing lifecycle gates.
      const [created] = await database.client`INSERT INTO factory.candidate_review(
        id,verification_id,ordinal,change_id,commit_sha,base_sha,created_by,finding_source_id,focus_review_id)
        SELECT ${crypto.randomUUID()},verification_id,ordinal+1,change_id,commit_sha,base_sha,created_by,id,focus_review_id
        FROM factory.candidate_review source WHERE source.id=${review.id}
          AND EXISTS(SELECT 1 FROM factory.agent_turn WHERE id=source.turn_id AND state='completed')
        ON CONFLICT DO NOTHING RETURNING id`;
      if (created) await ensureReview(change);
      return;
    }
    if ((await failedCorrections(change.id)) >= 3)
      throw new Error(
        "Automatic correction paused after three failed candidates. Review the findings and resume Build manually.",
      );
    const result = candidateReviewResultInput.parse(review.result);
    const findings = result.findings.filter((finding) => finding.severity === "blocking");
    await agent.prompt(
      change.id,
      [
        `Independent review of commit ${change.commitSHA} found these reproducible defects within the approved scope:`,
        ...findings.map(
          (finding, index) =>
            `${index + 1}. ${finding.title}${finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}\n${finding.explanation}\nReproduction: ${finding.reproduction}`,
        ),
        "Add or extend regression coverage for each fixed defect where the existing test toolchain supports it. Do not replace failing checks with skipped or weaker tests.",
        "Fix these defects in the retained checkout, preserve unrelated human edits and run the relevant checks. Do not weaken tests, expand scope for cosmetic preferences, commit or push. Factory will submit the corrected candidate for new exact Verification and independent review.",
      ].join("\n\n"),
      change.userID,
      review.repairCommandID,
      true,
    );
    await database.client`UPDATE factory.candidate_review SET repair_prompted_at=now()
      WHERE id=${review.id} AND repair_prompted_at IS NULL`;
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
        monitoringIncidentID: string | null;
        deliveryPolicyID: string | null;
      }>
    >`
      SELECT merge.id, merge.state, merge.commit_sha AS "commitSHA",
        merge.base_sha AS "baseSHA", merge.pull_request_number AS "pullRequestNumber",
        approval.monitoring_incident_id AS "monitoringIncidentID",approval.delivery_policy_id AS "deliveryPolicyID"
      FROM factory.merge_operation merge JOIN factory.delivery_approval approval ON approval.id=merge.delivery_approval_id
      WHERE merge.change_id = ${change.id}
      ORDER BY (merge.state<>'failed') DESC,merge.requested_at DESC,merge.id DESC LIMIT 1
    `;
    const operation = rows[0];
    if (!operation || operation.state === "failed") return;
    const outcomeUnknown = operation.state === "ambiguous" || operation.state === "executing";
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
        if (outcomeUnknown) {
          // A later default-branch commit cannot prove whether the earlier
          // merge happened. Keep the Project fenced rather than replaying it.
          await database.client`
            UPDATE factory.merge_operation SET state='ambiguous',
              last_error='Default branch moved before the earlier merge outcome was confirmed',
              completed_at=NULL,updated_at=now() WHERE id=${operation.id}
              AND state IN ('executing','ambiguous')
          `;
          return;
        }
        await database.client`
          UPDATE factory.merge_operation SET state = 'failed',
            last_error = 'Delivery gate moved before merge', completed_at = now(), updated_at = now()
          WHERE id = ${operation.id} AND state NOT IN ('succeeded', 'failed')
        `;
        await database.client`UPDATE factory.change SET state='active',failure='Delivery basis changed before merge',version=version+1
          WHERE id=${change.id} AND state='delivering'`;
        return;
      }
      await database.client`
        UPDATE factory.merge_operation SET state = 'executing', updated_at = now()
        WHERE id = ${operation.id} AND state IN ('pending', 'ambiguous')
      `;
      try {
        const pullRequestNumber = operation.pullRequestNumber;
        const commitSHA = operation.commitSHA;
        const deliveryPolicyID = operation.deliveryPolicyID;
        const monitoringIncidentID = operation.monitoringIncidentID;
        async function performMerge() {
          return forge.mergeFastForward(
            repository,
            Number(pullRequestNumber),
            commitSHA,
            change.defaultBranch,
          );
        }
        async function delegatedMerge() {
          const coordination = database.coordination();
          try {
            return await coordination.begin(async (sql) => {
              // Revocation and this irreversible command serialize on the
              // same authority rows, without holding the application pool.
              await sql`SELECT id FROM factory.change WHERE id=${change.id} FOR UPDATE`;
              if (deliveryPolicyID)
                await deliveryDelegationIn(sql, change.projectID, deliveryPolicyID);
              else if (monitoringIncidentID)
                await monitoringChangeAuthorityIn(database, sql, change.id, monitoringIncidentID);
              return performMerge();
            });
          } finally {
            await coordination.end();
          }
        }
        const merged =
          base.headSha === operation.commitSHA
            ? { headSha: base.headSha }
            : operation.monitoringIncidentID || operation.deliveryPolicyID
              ? await delegatedMerge()
              : await performMerge();
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
            ON CONFLICT(change_id,ordinal) DO NOTHING
          `;
          await transaction`
            UPDATE factory.change SET state = 'delivering', failure = NULL, version = version + 1
            WHERE id = ${change.id}
          `;
        });
      } catch (cause) {
        const message = bounded(cause instanceof Error ? cause.message : "Merge failed");
        if (
          cause instanceof CommandError &&
          (operation.monitoringIncidentID || operation.deliveryPolicyID) &&
          !outcomeUnknown
        ) {
          await database.client`UPDATE factory.merge_operation SET state='failed',last_error=${message},
            completed_at=now(),updated_at=now() WHERE id=${operation.id} AND state='executing'`;
          await database.client`UPDATE factory.change SET state='active',failure=${message},version=version+1
            WHERE id=${change.id} AND state='delivering'`;
          return;
        }
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

  function reconcile(changeID: string): Promise<void> {
    if (closed) return Promise.resolve();
    const task = reconcileChange(changeID);
    pending.add(task);
    const settled = () => {
      pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }

  async function reconcileChange(changeID: string) {
    if (running.has(changeID)) return;
    running.add(changeID);
    let projectLock: ReturnType<Database["coordination"]> | undefined;
    let projectLockID: string | undefined;
    try {
      let change = await changeRow(changeID);
      if (!change) return;
      if (integration) {
        projectLock = database.coordination();
        const key = `delivery-project:${change.projectID}`;
        const [claim] = await projectLock<{ held: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS held`;
        if (!claim?.held) return;
        projectLockID = key;
        // The snapshot used to find the immutable Project is not authority for
        // source or merge work after another process finished reconciliation.
        change = await changeRow(changeID);
        if (!change) return;
      }
      if (change.trashed || ["cancelling", "cancelled"].includes(change.state)) {
        if (integration) await coordination.release(change.id);
        await cancelVerifications(change.id, repositoryFromURL(change.repositoryURL));
        return;
      }
      if (!change.commitSHA || change.state === "failed") {
        if (integration) await coordination.release(change.id);
        return;
      }
      await cancelVerifications(
        change.id,
        repositoryFromURL(change.repositoryURL),
        change.commitSHA,
      );
      if (change.state === "delivered") {
        await reconcilePromotion(change, repositoryFromURL(change.repositoryURL));
        if (integration) await coordination.release(change.id);
        return;
      }
      if (integration) {
        if (change.state === "active" && change.deliveryWaitingSHA === change.commitSHA) {
          const policy = await coordination.activePolicy(change.projectID);
          if ((policy?.id ?? null) === change.deliveryWaitingPolicyID) {
            await coordination.release(changeID);
            return;
          }
          await database.client`UPDATE factory.change SET delivery_waiting_sha=NULL,delivery_waiting_policy_id=NULL
            WHERE id=${changeID} AND delivery_waiting_sha=${change.commitSHA}`;
        }
        const [blocked] =
          await database.client`SELECT session.change_id FROM factory.change_agent_session session
          JOIN factory.change_writer writer ON writer.change_id=session.change_id
          LEFT JOIN factory.agent_turn turn ON turn.id=session.active_turn_id
          WHERE session.change_id=${changeID} AND (session.stop_pending OR session.state IN ('failed','stopped','waiting')
            OR (session.state IN ('starting','working') AND turn.authority->'review' IS NULL)
            OR writer.state IN ('human','handoff') OR EXISTS(
              SELECT 1 FROM factory.candidate_review review
              JOIN factory.verification verification ON verification.id=review.verification_id
              LEFT JOIN factory.agent_turn reviewer ON reviewer.id=review.turn_id
              WHERE review.change_id=${changeID} AND verification.commit_sha=${change.commitSHA}
                AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
                AND (review.state='incomplete' OR reviewer.state IN ('failed','stopped','uncertain')))
            OR EXISTS(
              SELECT 1 FROM factory.review_feedback WHERE change_id=${changeID} AND kind='thread' AND state<>'resolved'))`;
        if (blocked && change.state !== "delivering") {
          await coordination.release(changeID);
          return;
        }
        if (!(await coordination.claim(change.projectID, change.id))) return;
        if (change.state === "active") {
          const currentBase = await forge.getDefaultBranch(repositoryFromURL(change.repositoryURL));
          if (currentBase.headSha !== change.baseSHA) {
            if (!(await integration.reconcile(changeID, currentBase.headSha))) {
              await coordination.release(changeID);
              return;
            }
            change = await changeRow(changeID);
            if (!change) return;
            if (change.baseSHA !== currentBase.headSha) return;
          }
        }
      }
      const pull = await ensurePullRequest(change);
      if (!pull) return;
      const merge = await database.client<Array<{ exists: boolean }>>`
        SELECT EXISTS(
          SELECT 1 FROM factory.merge_operation WHERE change_id = ${change.id} AND state<>'failed'
        ) AS exists
      `;
      if (merge[0]?.exists) {
        await reconcileMerge(change, pull.repository);
        await reconcilePromotion(change, pull.repository);
        if (integration) {
          const [terminal] =
            await database.client`SELECT id FROM factory.merge_operation WHERE change_id=${changeID} AND state='failed'`;
          if (terminal) await coordination.release(changeID);
        }
        return;
      }
      await ensureVerification(change, pull.repository, pull.pullRequest);
      if (pull.pullRequest.headSha === change.commitSHA && !pull.pullRequest.merged)
        await ensureReview(change);
      if (integration) {
        const [review] = await database.client<
          { state: string }[]
        >`SELECT review.state FROM factory.candidate_review review
          JOIN factory.verification verification ON verification.id=review.verification_id
          WHERE review.change_id=${changeID} AND review.commit_sha=${change.commitSHA}
            AND review.base_sha=${change.baseSHA} AND verification.state='succeeded'
          ORDER BY review.created_at DESC,review.ordinal DESC LIMIT 1`;
        if (review?.state === "passed") {
          const policy = await coordination.activePolicy(change.projectID);
          if (policy) {
            try {
              await api.approve(changeID, policy.userID, undefined, policy.id);
              return;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              await database.client`UPDATE factory.change SET failure=${cause.message.slice(0, 2000)}
                WHERE id=${changeID} AND state='active' AND failure IS DISTINCT FROM ${cause.message.slice(0, 2000)}`;
            }
          }
          await database.client`UPDATE factory.change SET delivery_waiting_sha=${change.commitSHA},
            delivery_waiting_policy_id=${policy?.id ?? null} WHERE id=${changeID} AND state='active'
            AND ROW(delivery_waiting_sha,delivery_waiting_policy_id) IS DISTINCT FROM ROW(${change.commitSHA}::text,${policy?.id ?? null}::uuid)`;
          await coordination.release(changeID);
        } else if (review && !["pending", "running"].includes(review.state)) {
          await coordination.release(changeID);
        }
      }
    } catch (cause) {
      if (integration) await coordination.release(changeID);
      const message = bounded(cause instanceof Error ? cause.message : "Delivery failed");
      await database.client`
        UPDATE factory.change SET failure = ${message}, version = version + 1
        WHERE id = ${changeID} AND state NOT IN ('cancelled', 'delivered') AND failure IS DISTINCT FROM ${message}
      `;
    } finally {
      running.delete(changeID);
      if (projectLock) {
        try {
          if (projectLockID)
            await projectLock`SELECT pg_advisory_unlock(hashtextextended(${projectLockID},0))`;
        } finally {
          await projectLock.end();
        }
      }
    }
  }

  async function reconcileAll() {
    if (closed || reconcilingAll) return;
    reconcilingAll = true;
    try {
      const changes = await database.client<Array<{ id: string; projectID: string }>>`
      SELECT DISTINCT change.id,change.project_id AS "projectID",change.created_at
      FROM factory.change change
      JOIN factory.change_commit_operation commit ON commit.change_id = change.id
      LEFT JOIN factory.current_promotion promotion ON promotion.change_id = change.id
      WHERE commit.state = 'succeeded'
        AND (change.state <> 'cancelled' OR EXISTS(
          SELECT 1 FROM factory.verification verification
          LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
          WHERE verification.change_id = change.id
            AND (verification.runner_id IS NOT NULL
              OR attempt.state NOT IN ('stopped', 'failed'))
        ))
        AND (change.state <> 'delivered' OR promotion.last_error IS NOT NULL)
      ORDER BY change.created_at,change.id
    `;
      // Let blocked work release its slot before the next independent candidate
      // competes for it. Overlapping sweeps cannot repeatedly starve that candidate.
      const projects = new Map<string, string[]>();
      for (const change of changes)
        projects.set(change.projectID, [...(projects.get(change.projectID) ?? []), change.id]);
      await Promise.all(
        [...projects.values()].map(async (ids) => {
          for (const id of ids) await reconcile(id);
        }),
      );
    } finally {
      reconcilingAll = false;
    }
  }

  const api = {
    settings: coordination.settings.bind(coordination),
    configure: (
      projectID: string,
      userID: string,
      input: z.input<typeof deliveryDelegationInput>,
    ) => coordination.configure(projectID, userID, input),
    async recover() {
      await database.client`
        UPDATE factory.pull_request_operation SET state = 'ambiguous', updated_at = now()
        WHERE state = 'executing'
      `;
      await database.client`
        UPDATE factory.merge_operation SET state = 'ambiguous', updated_at = now()
        WHERE state = 'executing'
      `;
    },
    sweep: reconcileAll,
    close() {
      closed = true;
      closing ??= Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
    async approve(
      changeID: string,
      userID: string,
      monitoringIncidentID?: string,
      deliveryPolicyID?: string,
    ) {
      const change = await changeRow(changeID);
      if (change)
        await createAccessController(database).requireDevelopment(userID, change.projectID);
      if (!change?.commitSHA) throw new Error("Change has no delivered commit candidate");
      if (integration)
        await database.client`UPDATE factory.change SET delivery_waiting_sha=NULL,delivery_waiting_policy_id=NULL
          WHERE id=${changeID} AND state='active' AND delivery_waiting_sha=${change.commitSHA}`;
      if (integration && !(await coordination.claim(change.projectID, changeID)))
        throw new CommandError(
          "conflict",
          "Another Change or its Staging recovery owns Delivery. This candidate stays queued.",
        );
      if (deliveryPolicyID) {
        const delegator = await database.client.begin((sql) =>
          deliveryDelegationIn(sql, change.projectID, deliveryPolicyID),
        );
        if (delegator !== userID)
          throw new CommandError("forbidden", "Use the recorded Delivery delegator.");
      }
      if (monitoringIncidentID) {
        const delegated = await database.client.begin((sql) =>
          monitoringChangeAuthorityIn(database, sql, changeID, monitoringIncidentID),
        );
        if (delegated.userId !== userID)
          throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
      }
      const repository = repositoryFromURL(change.repositoryURL);
      const pullRequest = await forge.getPullRequest(
        repository,
        change.defaultBranch,
        change.branchName,
      );
      const base = await forge.getDefaultBranch(repository);
      const verifications = await database.client<
        Array<{ id: string; actionRunID: string; commitSHA: string; reviewID: string }>
      >`
        SELECT verification.id,verification.action_run_id AS "actionRunID",verification.commit_sha AS "commitSHA",
          review.id AS "reviewID"
        FROM factory.verification verification
        JOIN factory.candidate_review review ON review.verification_id=verification.id
        JOIN factory.agent_turn turn ON turn.id=review.turn_id
        WHERE verification.change_id = ${changeID} AND verification.commit_sha = ${change.commitSHA}
          AND verification.state = 'succeeded' AND review.state='passed' AND turn.state='completed'
          AND review.change_id=verification.change_id AND review.commit_sha=verification.commit_sha
          AND review.base_sha=${change.baseSHA}
          AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
      `;
      const verification = verifications[0];
      if (deliveryPolicyID && verification) {
        const [eligible] = await database.client`SELECT id FROM factory.candidate_review
          WHERE id=${verification.reviewID} AND result->>'delivery'='ordinary'`;
        if (!eligible)
          throw new CommandError("conflict", "This review requires a human Delivery decision.");
      }
      if (
        !verification ||
        !pullRequest ||
        pullRequest.headSha !== verification.commitSHA ||
        base.headSha !== change.baseSHA
      ) {
        if (integration) {
          await database.client`UPDATE factory.change SET delivery_waiting_sha=NULL,delivery_waiting_policy_id=NULL
            WHERE id=${changeID} AND state='active'`;
          void reconcile(changeID);
        }
        throw new Error("Current commit is not eligible for delivery");
      }
      const approvalID = crypto.randomUUID();
      const mergeID = crypto.randomUUID();
      const candidateDigest =
        monitoringIncidentID || deliveryPolicyID
          ? await monitoringCandidate(forge, repository, change.baseSHA, verification.commitSHA)
          : null;
      await database.client.begin(async (transaction) => {
        await projectDevelopmentAuthorityIn(transaction, userID, change.projectID);
        // Read scope only after the lock wait. A joined statement's earlier
        // snapshot cannot authorize Requirements committed while it waited.
        await transaction`SELECT change.id FROM factory.change change
          JOIN factory.ticket ticket ON ticket.id=change.ticket_id
          WHERE change.id=${changeID} FOR UPDATE OF change,ticket`;
        if (integration) {
          const [slot] = await transaction`SELECT project_id FROM factory.project_delivery_queue
            WHERE project_id=${change.projectID} AND change_id=${changeID} FOR SHARE`;
          if (!slot)
            throw new CommandError(
              "conflict",
              "This candidate no longer owns the Project Delivery slot.",
            );
        }
        const delegated = monitoringIncidentID
          ? await monitoringChangeAuthorityIn(database, transaction, changeID, monitoringIncidentID)
          : null;
        if (deliveryPolicyID)
          await deliveryDelegationIn(transaction, change.projectID, deliveryPolicyID);
        if (delegated && delegated.userId !== userID)
          throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
        if (delegated) {
          const [human] =
            await transaction`SELECT turn.id FROM factory.agent_turn turn WHERE change_id=${changeID}
            AND input->>'kind'='change-prompt' LIMIT 1`;
          const [writer] =
            await transaction`SELECT change_id FROM factory.change_writer WHERE change_id=${changeID}
            AND (state IN ('human','handoff') OR user_id IS NOT NULL)`;
          if (human || writer)
            throw new CommandError(
              "conflict",
              "A human took over this Change. Automatic Delivery is disabled.",
            );
        }
        if (deliveryPolicyID) {
          const [human] =
            await transaction`SELECT change_id FROM factory.change_writer WHERE change_id=${changeID}
            AND state IN ('human','handoff')
            UNION ALL SELECT change_id FROM factory.change_commit_operation WHERE change_id=${changeID} AND source='repository-document'
            UNION ALL SELECT change_id FROM factory.change_editing_decision WHERE change_id=${changeID} AND kind IN ('takeover','idle-takeover','approve') LIMIT 1`;
          if (human)
            throw new CommandError(
              "conflict",
              "Human editing requires human Delivery approval for this Change.",
            );
        }
        const [current] = await transaction<
          Array<{ state: string; requirementsCurrent: boolean }>
        >`SELECT change.state,approval.requirement_revision_id=(SELECT id FROM factory.requirement_revision
            WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1) AS "requirementsCurrent"
          FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
          JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
          WHERE change.id = ${changeID} AND ticket.trashed_at IS NULL`;
        if (current && !current.requirementsCurrent)
          throw new CommandError(
            "conflict",
            "Requirements changed. Verify and review the current approved scope before Delivery.",
          );
        const [thread] = await transaction`SELECT id FROM factory.review_feedback
          WHERE change_id=${changeID} AND kind='thread' AND state<>'resolved' LIMIT 1`;
        if (thread)
          throw new CommandError("conflict", "Resolve the open review Threads before Delivery.");
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
        const [review] = await transaction`
          SELECT review.id FROM factory.candidate_review review
          JOIN factory.verification verification ON verification.id=review.verification_id
          JOIN factory.agent_turn turn ON turn.id=review.turn_id
          WHERE review.id=${verification.reviewID} AND review.change_id=${changeID}
            AND review.commit_sha=${verification.commitSHA} AND review.base_sha=${change.baseSHA}
            AND review.state='passed' AND turn.state='completed' AND verification.state='succeeded'
            AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
          FOR SHARE OF review,verification,turn`;
        if (
          current?.state !== "active" ||
          work ||
          (session && session.state !== "committed") ||
          commit?.sha !== verification.commitSHA ||
          !review
        )
          throw new Error("Wait for the current implementation to finish before delivery.");
        await transaction`
          INSERT INTO factory.delivery_approval(
            id, change_id, verification_id, commit_sha, approved_by,candidate_review_id,
            monitoring_incident_id,monitoring_policy_id,delivery_policy_id
          ) VALUES (
            ${approvalID}, ${changeID}, ${verification.id}, ${verification.commitSHA}, ${userID},${verification.reviewID},
            ${monitoringIncidentID ?? null},${delegated?.policyId ?? null},${deliveryPolicyID ?? null}
          )
          ON CONFLICT DO NOTHING
        `;
        if (delegated && candidateDigest)
          await transaction`INSERT INTO factory.monitoring_evidence(id,incident_id,kind,digest,commit_sha)
            VALUES(${crypto.randomUUID()},${delegated.id},'delivery-candidate',${candidateDigest},${verification.commitSHA})`;
        await transaction`
          INSERT INTO factory.merge_operation(
            id, change_id, delivery_approval_id, pull_request_number,
            base_sha, commit_sha, idempotency_key
          )
          SELECT ${mergeID}, ${changeID}, approval.id, ${pullRequest.number},
            ${change.baseSHA}, ${verification.commitSHA}, ${`change:${changeID}:merge:`} || approval.id::text
          FROM factory.delivery_approval approval
          WHERE approval.verification_id = ${verification.id}
            AND approval.candidate_review_id=${verification.reviewID}
            AND approval.approved_by=${userID}
            AND approval.monitoring_policy_id IS NOT DISTINCT FROM ${delegated?.policyId ?? null}::uuid
            AND approval.delivery_policy_id IS NOT DISTINCT FROM ${deliveryPolicyID ?? null}::uuid
          ON CONFLICT DO NOTHING
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
    async retryPromotion(changeID: string, userID: string, commandID: string, promotionID: string) {
      const admitted = await retryPromotion(
        database,
        changeID,
        userID,
        commandID,
        promotionID,
        async (url) => (await forge.getDefaultBranch(repositoryFromURL(url))).headSha,
      );
      if (admitted) await reconcile(changeID);
      return this.get(changeID);
    },
    async resumeChecks(
      changeID: string,
      userID: string,
      commandID: string,
      verificationID: string,
      stopID: string,
    ) {
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, changeID);
        await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
        const input = { changeID, verificationID, stopID };
        const scope = `checks-resume:${changeID}`;
        const [previous] = await sql<
          { scope: string; userID: string; input: typeof input }[]
        >`SELECT scope,actor_id AS "userID",input FROM factory.execution_policy_command
          WHERE command_id=${commandID}`;
        if (previous) {
          if (
            previous.scope !== scope ||
            previous.userID !== userID ||
            previous.input.changeID !== changeID ||
            previous.input.verificationID !== verificationID ||
            previous.input.stopID !== stopID
          )
            throw new CommandError("conflict", "Checks resume changed target");
          return;
        }
        const [candidate] = await sql<
          { state: string; stopping: boolean; stopID: string | null; submitted: boolean }[]
        >`
          SELECT session.state,session.stop_pending AS stopping,session.stop_id AS "stopID",
            (commit.id=session.active_turn_id AND turn.state='completed') AS submitted
          FROM factory.verification verification
          JOIN factory.change change ON change.id=verification.change_id
          JOIN factory.change_agent_session session ON session.change_id=change.id
          JOIN LATERAL (
            SELECT id,commit_sha FROM factory.change_commit_operation
            WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1
          ) commit ON commit.commit_sha=verification.commit_sha
          LEFT JOIN factory.agent_turn turn ON turn.id=session.active_turn_id
          WHERE verification.id=${verificationID} AND change.id=${changeID}
            AND verification.state<>'cancelled' AND change.state='active'`;
        const [active] = await sql`SELECT id FROM factory.agent_turn WHERE change_id=${changeID}
          AND state IN ('pending','dispatching','running','uncertain')`;
        const [committing] = await sql`SELECT id FROM factory.change_commit_operation
          WHERE change_id=${changeID} AND state NOT IN ('succeeded','failed')`;
        if (
          !writer.available ||
          !["agent", "unassigned"].includes(writer.state) ||
          !candidate?.submitted ||
          candidate.state !== "stopped" ||
          candidate.stopping ||
          candidate.stopID !== stopID ||
          active ||
          committing
        )
          throw new CommandError(
            "conflict",
            "Resume checks only after Stop is confirmed and the current implementation is submitted",
          );
        // Restore only the completed candidate's delivery eligibility. No turn,
        // prompt, source edit or Stop confirmation is created or replayed here.
        await sql`UPDATE factory.change_agent_session SET state='committed',last_error=NULL,
          updated_at=now() WHERE change_id=${changeID}`;
        await sql`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
          VALUES(${commandID},${scope},${userID},${JSON.stringify(input)}::jsonb,'{}'::jsonb)`;
      });
      await reconcile(changeID);
      return this.get(changeID);
    },
    async retryReview(
      changeID: string,
      userID: string,
      commandID: string,
      previousReviewID: string,
    ) {
      if (!agent.review)
        throw new CommandError("unavailable", "Independent candidate review is not configured");
      await database.client.begin(async (sql) => {
        await lockChangeWriterIn(sql, changeID);
        const [change] = await sql<
          {
            projectID: string;
            sha: string;
            base: string;
            state: string;
            runtimeState: string | null;
          }[]
        >`
          SELECT change.project_id AS "projectID",COALESCE((SELECT integration_base_sha FROM factory.change_commit_operation
            WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),change.base_sha) AS base,change.state,
            attempt.state AS "runtimeState",
            (SELECT commit_sha FROM factory.change_commit_operation WHERE change_id=change.id
              AND state='succeeded' ORDER BY sequence DESC LIMIT 1) AS sha
          FROM factory.change change
          LEFT JOIN factory.runtime_attempt attempt ON attempt.id=change.runtime_attempt_id
          WHERE change.id=${changeID}`;
        if (!change) throw new CommandError("not-found", "Change not found");
        await projectAuthorityIn(sql, userID, change.projectID);
        const [old] = await sql<
          { changeID: string; userID: string; previousID: string | null }[]
        >`SELECT change_id AS "changeID",created_by AS "userID",supersedes_id AS "previousID"
          FROM factory.candidate_review WHERE id=${commandID}`;
        if (old) {
          if (
            old.changeID !== changeID ||
            old.userID !== userID ||
            old.previousID !== previousReviewID
          )
            throw new CommandError("conflict", "Review retry changed target");
          return;
        }
        const [previous] = await sql<
          {
            id: string;
            verificationID: string;
            ordinal: number;
            state: string;
            turnState: string | null;
          }[]
        >`
          SELECT review.id,review.verification_id AS "verificationID",review.ordinal,review.state,turn.state AS "turnState"
          FROM factory.candidate_review review
          LEFT JOIN factory.agent_turn turn ON turn.id=review.turn_id
          JOIN factory.verification verification ON verification.id=review.verification_id
          WHERE review.change_id=${changeID} AND review.commit_sha=${change.sha}
            AND verification.state='succeeded' ORDER BY review.ordinal DESC LIMIT 1`;
        const [session] = await sql<{ stopping: boolean }[]>`SELECT stop_pending AS stopping
          FROM factory.change_agent_session WHERE change_id=${changeID}`;
        const [active] = await sql`SELECT id FROM factory.agent_turn WHERE change_id=${changeID}
          AND state IN ('pending','dispatching','running','uncertain')`;
        if (
          !(
            change.state === "active" ||
            (["starting", "failed"].includes(change.state) &&
              ["stopped", "failed"].includes(change.runtimeState ?? ""))
          ) ||
          !previous ||
          previous.id !== previousReviewID ||
          active ||
          session?.stopping ||
          !(
            previous.state === "incomplete" ||
            ["failed", "stopped"].includes(previous.turnState ?? "")
          )
        )
          throw new CommandError(
            "conflict",
            "Resolve active, stale or uncertain work before retrying an incomplete review",
          );
        await sql`INSERT INTO factory.candidate_review(id,verification_id,ordinal,change_id,commit_sha,base_sha,created_by,supersedes_id,
          finding_source_id,focus_review_id)
          SELECT ${commandID},${previous.verificationID},${previous.ordinal + 1},${changeID},${change.sha},${change.base},${userID},${previousReviewID},
            finding_source_id,focus_review_id FROM factory.candidate_review WHERE id=${previousReviewID}`;
      });
      await agent.review(changeID, commandID, userID);
      return this.get(changeID);
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
          verification.id AS "verificationId",
          CASE WHEN session.state='stopped' AND NOT session.stop_pending
            AND writer.state IN ('agent','unassigned') AND change.cancel_requested_at IS NULL
            AND session.active_turn_id=(SELECT id FROM factory.change_commit_operation
              WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
            AND EXISTS(SELECT 1 FROM factory.agent_turn WHERE id=session.active_turn_id AND state='completed')
            AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id
              AND state IN ('pending','dispatching','running','uncertain'))
            AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=change.id
              AND state NOT IN ('succeeded','failed'))
            AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id AND trashed_at IS NULL)
            AND verification.state<>'cancelled' AND change.state='active'
            THEN session.stop_id END AS "checksStopId",
          review.id AS "reviewId",
          pr.pull_request_url AS "pullRequestUrl", pr.state AS "pullRequestState",
          verification.commit_sha AS "verificationCommitSha",
          CASE WHEN failed_verification.id IS NOT NULL THEN 'failed'
            ELSE verification.state::text END AS "verificationState",
          CASE WHEN failed_verification.id IS NOT NULL THEN
            COALESCE(left(failed_verification.failure,1000),'Verification compute failed before checks completed.')
            ELSE verification.summary END AS "verificationSummary",
          CASE WHEN verification.state IN ('pending','runner-starting')
            AND verification_runtime.state IN ('create-intended','starting')
            THEN left(nullif(verification_runtime.failure,''),1000) END AS "verificationPreparationFailure",
          CASE WHEN failed_verification.id IS NOT NULL THEN 'execution-failed'
            WHEN verification.state='failed' THEN verification.diagnosis->>'kind' END AS "verificationFailureKind",
          CASE WHEN latest_turn.input->>'kind'='change-repair' THEN latest_turn.state::text END AS "correctionState",
          verification.action_run_url AS "actionRunUrl",
          CASE WHEN review.state IN ('pending','running') AND review_turn.state IN ('failed','stopped','uncertain')
            THEN review_turn.state::text ELSE review.state END AS "reviewState",
          (review.turn_id IS NOT NULL AND review.turn_id=(SELECT id FROM factory.agent_turn
            WHERE change_id=change.id ORDER BY created_at DESC,id DESC LIMIT 1)) AS "reviewCurrent",
          COALESCE(review.result->>'summary',review_turn.outcome_summary) AS "reviewSummary",
          review.result->'findings' AS "reviewFindings",
          (SELECT count(*)::int FROM factory.review_feedback
            WHERE change_id=change.id AND kind='thread' AND state<>'resolved') AS "openReviewThreads",
          approval.approved_at AS "approvedAt",
          approval.monitoring_policy_id AS "monitoringPolicyId",
          approval.delivery_policy_id AS "deliveryPolicyId",
          autofix.id AS "monitoringIncidentId",autofix.state AS "monitoringState",
          autofix.reason AS "monitoringReason",
          merge.state AS "mergeState", merge.observed_default_sha AS "mergedCommitSha",
          promotion.id AS "promotionId",promotion.state AS "promotionState",
          promotion.last_error AS "cleanupError",
          promotion.replacement_runtime_attempt_id AS "replacementRuntimeAttemptId",
          replacement.state AS "replacementRuntimeState",
          left(replacement.failure,2000) AS "promotionFailure"
        FROM factory.change change
        LEFT JOIN factory.monitoring_incident autofix ON autofix.ticket_id=change.ticket_id
        LEFT JOIN factory.change_agent_session session ON session.change_id=change.id
        LEFT JOIN factory.change_writer writer ON writer.change_id=change.id
        LEFT JOIN LATERAL (
          SELECT input,state FROM factory.agent_turn WHERE change_id=change.id
          ORDER BY created_at DESC,id DESC LIMIT 1
        ) latest_turn ON true
        LEFT JOIN factory.pull_request_operation pr ON pr.change_id = change.id
        LEFT JOIN LATERAL (
          SELECT * FROM factory.verification WHERE change_id = change.id
            AND commit_sha = (SELECT commit_sha FROM factory.change_commit_operation
              WHERE change_id = change.id AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1)
          ORDER BY created_at DESC LIMIT 1
        ) verification ON true
        LEFT JOIN factory.runtime_attempt verification_runtime ON verification_runtime.id=verification.runtime_attempt_id
        LEFT JOIN factory.runtime_attempt failed_verification ON failed_verification.id=verification.runtime_attempt_id
          AND verification.state IN ('pending','runner-starting','running')
          AND (failed_verification.state IN ('failed','cleanup-failed')
            OR (failed_verification.state='stopped' AND failed_verification.failure IS NOT NULL))
        LEFT JOIN LATERAL (
          SELECT * FROM factory.candidate_review WHERE verification_id=verification.id ORDER BY ordinal DESC LIMIT 1
        ) review ON true
        LEFT JOIN factory.agent_turn review_turn ON review_turn.id=review.turn_id
        LEFT JOIN LATERAL (
          SELECT * FROM factory.merge_operation WHERE change_id=change.id AND commit_sha=verification.commit_sha
          ORDER BY (state<>'failed') DESC,requested_at DESC,id DESC LIMIT 1
        ) merge ON true
        LEFT JOIN LATERAL (
          SELECT * FROM factory.delivery_approval WHERE verification_id=verification.id
            AND (merge.delivery_approval_id IS NULL OR id=merge.delivery_approval_id)
          ORDER BY approved_at DESC,id DESC LIMIT 1
        ) approval ON true
        LEFT JOIN factory.current_promotion promotion ON promotion.change_id = change.id
        LEFT JOIN factory.runtime_attempt replacement
          ON replacement.id = promotion.replacement_runtime_attempt_id
        WHERE change.id = ${changeID}
      `;
      return rows[0] ?? null;
    },
    reconcile,
  };
  return api;
}
