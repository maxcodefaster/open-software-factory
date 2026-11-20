import {
  and,
  asc,
  count,
  DrizzleQueryError,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import type { z } from "zod";
import type { deliveryDelegationInput } from "../../../../packages/change-domain/src/delivery";
import { candidateReviewResultInput } from "../../../../packages/conversation-domain/src/candidate-review";
import {
  verificationChangeScope,
  verificationDiagnosisInput,
  verificationRepairInstructions,
} from "../../../../packages/conversation-domain/src/verification";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  candidateReview,
  changeAgentSession,
  changeCommitOperation,
  change as changeTable,
  deliveryApproval,
  executionPolicyCommand,
  mergeOperation,
  monitoringEvidence,
  project,
  projectDeliveryQueue,
  promotionOperation,
  pullRequestOperation,
  reviewFeedback,
  runtimeAttempt,
  stagingPreview,
  ticket,
  verification as verificationTable,
} from "../../../../packages/db/src/schema";
import {
  createForgejoClient,
  ForgeAmbiguousWriteError,
  type ForgeRepository,
} from "../../../../packages/forge/src/forge";
import { forgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { lockChangeWriterIn } from "../access/change-writer";
import {
  createAccessController,
  projectAuthorityIn,
  projectDevelopmentAuthorityIn,
} from "../access/controller";
import { publishWorkspaceCandidate, submittedCandidate } from "../agent/candidate-state";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import { monitoringCandidate } from "../monitoring/candidate";
import type { RuntimeAttemptView } from "../runtime/types";
import { createDeliveryCoordination, deliveryDelegationIn } from "./coordination";
import type { createChangeIntegration } from "./integration";
import { createDeliveryPromotion } from "./promotion";
import { retryPromotion } from "./promotion-retry";
import { retryVerificationBootstrap } from "./verification-retry";

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

function bounded(value: string, limit = 2_000) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function failureMessage(cause: unknown, fallback: string): string {
  // Drizzle's wrapper includes SQL parameters. Persist the original driver
  // message as before, never runner credentials or other query inputs.
  if (cause instanceof DrizzleQueryError) return failureMessage(cause.cause, fallback);
  return bounded(cause instanceof Error ? cause.message : fallback);
}

function pendingReviewColumns() {
  // INSERT SELECT must supply every model column in model order. Reset the
  // fields omitted by the original insert to their native fresh-review defaults.
  return {
    ...getTableColumns(candidateReview),
    supersedesId: query<null>`NULL::uuid`.as("supersedes_id"),
    findingChecks: query<null>`NULL::jsonb`.as("finding_checks"),
    turnId: query<null>`NULL::uuid`.as("turn_id"),
    state: query<string>`'pending'::text`.as("state"),
    uiRequired: query<boolean>`false`.as("ui_required"),
    result: query<null>`NULL::jsonb`.as("result"),
    evidence: query<unknown[]>`'[]'::jsonb`.as("evidence"),
    repairCommandId: query<string>`gen_random_uuid()`.as("repair_command_id"),
    repairPromptedAt: query<null>`NULL::timestamptz`.as("repair_prompted_at"),
    createdAt: query<Date>`now()`.as("created_at"),
    completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
    coverageVersion: query<number>`1`.as("coverage_version"),
  };
}

export function createDeliveryController(
  database: Database,
  runtime: RuntimeController,
  agent: AgentController,
  retireBranch: (changeID: string) => Promise<void>,
  forgeOverride?: { client: ReturnType<typeof createForgejoClient>; owner: string },
  integration?: Pick<ReturnType<typeof createChangeIntegration>, "reconcile">,
) {
  const db = drizzleTransaction(database.client);
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
    const failedVerifications = db
      .select({ count: count() })
      .from(verificationTable)
      .where(
        and(
          eq(verificationTable.changeId, changeID),
          eq(verificationTable.state, "failed"),
          isNotNull(verificationTable.repairPromptedAt),
        ),
      );
    const failedReviews = db
      .select({ count: count() })
      .from(candidateReview)
      .where(
        and(
          eq(candidateReview.changeId, changeID),
          eq(candidateReview.state, "changes-requested"),
          isNotNull(candidateReview.repairPromptedAt),
        ),
      );
    const [row] = await db
      .select({
        count: query<number>`((${failedVerifications}) + (${failedReviews}))::integer`,
      })
      .from(changeTable)
      .where(eq(changeTable.id, changeID));
    return Number(row?.count ?? 0);
  }

  async function changeRow(changeID: string) {
    const commit = db
      .select({
        commitSHA: changeCommitOperation.commitSha,
        integrationBaseSHA: changeCommitOperation.integrationBaseSha,
      })
      .from(changeCommitOperation)
      .where(
        and(
          eq(changeCommitOperation.changeId, changeTable.id),
          eq(changeCommitOperation.state, "succeeded"),
        ),
      )
      .orderBy(desc(changeCommitOperation.sequence))
      .limit(1)
      .as("commit");
    const rows = await db
      .select({
        id: changeTable.id,
        projectID: changeTable.projectId,
        ticketID: changeTable.ticketId,
        title: ticket.title,
        description: ticket.description,
        branchName: changeTable.branchName,
        baseSHA: query<string>`COALESCE(${commit.integrationBaseSHA},${changeTable.baseSha})`,
        state: changeTable.state,
        trashed: isNotNull(ticket.trashedAt),
        userID: changeTable.createdBy,
        repositoryURL: project.repositoryUrl,
        defaultBranch: project.defaultBranch,
        commitSHA: commit.commitSHA,
        runtimeAttemptID: changeTable.runtimeAttemptId,
        deliveryWaitingSHA: changeTable.deliveryWaitingSha,
        deliveryWaitingPolicyID: changeTable.deliveryWaitingPolicyId,
      })
      .from(changeTable)
      .innerJoin(ticket, eq(ticket.id, changeTable.ticketId))
      .innerJoin(project, eq(project.id, changeTable.projectId))
      .leftJoinLateral(commit, query`true`)
      .where(eq(changeTable.id, changeID));
    return rows[0] ?? null;
  }

  async function ensurePullRequest(change: NonNullable<Awaited<ReturnType<typeof changeRow>>>) {
    const repository = forgeRepositoryFromURL(change.repositoryURL);
    if (repository.owner !== allowedOwner) {
      throw new Error("Project Forge owner is not allowed");
    }
    const selection = {
      id: pullRequestOperation.id,
      state: pullRequestOperation.state,
      number: query<string | null>`${pullRequestOperation.pullRequestNumber}::text`,
      url: pullRequestOperation.pullRequestUrl,
    };
    const readOperation = () =>
      db
        .select(selection)
        .from(pullRequestOperation)
        .where(eq(pullRequestOperation.changeId, change.id));
    let operations = await readOperation();
    if (!operations[0]) {
      operations = await db
        .insert(pullRequestOperation)
        .values({
          id: crypto.randomUUID(),
          changeId: change.id,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          baseBranch: change.defaultBranch,
          headBranch: change.branchName,
          firstHeadSha: query`${change.commitSHA}`,
          title: change.title,
          body: bounded(change.description, 10_000),
          idempotencyKey: `change:${change.id}:pull-request`,
        })
        .onConflictDoNothing({ target: pullRequestOperation.changeId })
        .returning(selection);
      if (!operations[0]) operations = await readOperation();
    }
    const operation = operations[0];
    if (!operation) throw new Error("Pull request intent was not created");
    if (operation.state === "failed") throw new Error("Pull request creation failed");
    if (operation.state !== "succeeded") {
      await db
        .update(pullRequestOperation)
        .set({ state: "executing", updatedAt: query`now()` })
        .where(
          and(
            eq(pullRequestOperation.id, operation.id),
            inArray(pullRequestOperation.state, ["pending", "ambiguous"]),
          ),
        );
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
        await db
          .update(pullRequestOperation)
          .set({
            state: "succeeded",
            pullRequestNumber: pullRequest.number,
            pullRequestUrl: pullRequest.url,
            completedAt: query`now()`,
            updatedAt: query`now()`,
            lastError: null,
          })
          .where(
            and(
              eq(pullRequestOperation.id, operation.id),
              eq(pullRequestOperation.state, "executing"),
            ),
          );
        return { repository, pullRequest };
      } catch (cause) {
        const message = failureMessage(cause, "Pull request failed");
        if (cause instanceof ForgeAmbiguousWriteError) {
          await db
            .update(pullRequestOperation)
            .set({ state: "ambiguous", lastError: message, updatedAt: query`now()` })
            .where(
              and(
                eq(pullRequestOperation.id, operation.id),
                eq(pullRequestOperation.state, "executing"),
              ),
            );
          return null;
        }
        await db
          .update(pullRequestOperation)
          .set({
            state: "failed",
            lastError: message,
            completedAt: query`now()`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(pullRequestOperation.id, operation.id),
              eq(pullRequestOperation.state, "executing"),
            ),
          );
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
      const [attempt] = await db
        .select({
          state: runtimeAttempt.state,
          stopping: query<boolean>`${runtimeAttempt.stopIntendedAt} IS NOT NULL`,
        })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.id, verification.runtimeAttemptID));
      // Stop is durable intent, not completed cleanup. Its runtime owner keeps
      // reconciling; another Delivery sweep must not reset its retry policy.
      if (attempt && attempt.state !== "stopped" && !attempt.stopping)
        await runtime
          .stop(verification.runtimeAttemptID)
          .catch(reportFailure("Verification runtime stop"));
    }
    if (verification.runnerID) {
      try {
        await forge.deleteRunner(repository, Number(verification.runnerID));
        await db
          .update(verificationTable)
          .set({ runnerId: null, updatedAt: query`now()` })
          .where(
            and(
              eq(verificationTable.id, verification.id),
              eq(verificationTable.runnerId, query`${verification.runnerID}::bigint`),
            ),
          );
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
          JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
          WHERE attempt.id=verification.runtime_attempt_id AND attempt.state='stopped'
            AND binding.deleted_at IS NOT NULL
        ))`;
    return Boolean(confirmed);
  }

  async function ensureVerification(
    change: NonNullable<Awaited<ReturnType<typeof changeRow>>>,
    repository: ForgeRepository,
    pullRequest: Awaited<ReturnType<typeof forge.getPullRequest>> & {},
  ) {
    if (!change.commitSHA || pullRequest.headSha !== change.commitSHA || pullRequest.merged) return;
    const commitSHA = change.commitSHA;
    const readVerification = () =>
      db
        .select({
          id: verificationTable.id,
          state: verificationTable.state,
          actionRunID: query<string | null>`${verificationTable.actionRunId}::text`,
          runtimeAttemptID: verificationTable.runtimeAttemptId,
          runtimeState: runtimeAttempt.state,
          // Keep native precision; these are observations, not Date-based write tokens.
          runtimeUpdatedAt: query<string | null>`${runtimeAttempt.updatedAt}::text`,
          runtimeFailure: runtimeAttempt.failure,
          runnerID: query<string | null>`${verificationTable.runnerId}::text`,
          runnerUUID: verificationTable.runnerUuid,
          runnerToken: verificationTable.runnerToken,
          repairPromptedAt: query<string | null>`${verificationTable.repairPromptedAt}::text`,
          diagnosis: verificationTable.diagnosis,
        })
        .from(verificationTable)
        .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, verificationTable.runtimeAttemptId))
        .where(
          and(
            eq(verificationTable.changeId, change.id),
            eq(verificationTable.commitSha, commitSHA),
          ),
        );
    let rows = await readVerification();
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
        await drizzleTransaction(sql)
          .insert(verificationTable)
          .values({
            id: verificationID,
            changeId: change.id,
            commitSha: commitSHA,
            pullRequestNumber: pullRequest.number,
            runnerName: `factory-${verificationID.replaceAll("-", "").slice(0, 16)}`,
            createdBy: change.userID,
          })
          .onConflictDoNothing({
            target: [verificationTable.changeId, verificationTable.commitSha],
          });
      });
      rows = await readVerification();
    }
    const verification = rows[0];
    if (!verification || verification.state === "cancelled") return;
    if (verification.state === "succeeded") {
      await stopVerification(repository, verification);
      return;
    }
    const previousDiagnosis = verificationDiagnosisInput.safeParse(verification.diagnosis);
    const heldFailure =
      verification.state === "failed" &&
      (!previousDiagnosis.success || previousDiagnosis.data.kind !== "check-failed");
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
      await db
        .update(verificationTable)
        .set({
          actionRunId: actionRun.id,
          actionRunUrl: actionRun.url,
          updatedAt: query`now()`,
        })
        .where(
          and(eq(verificationTable.id, verification.id), isNull(verificationTable.actionRunId)),
        );
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
      const [recorded] = await db
        .update(verificationTable)
        .set({
          state: succeeded ? "succeeded" : "failed",
          summary: bounded(summary),
          diagnosis: query`CASE WHEN ${succeeded} THEN
          CASE WHEN octet_length((COALESCE(${verificationTable.diagnosis},'{}'::jsonb) || ${JSON.stringify({ receipt })}::jsonb)::text)<=24000
            THEN COALESCE(${verificationTable.diagnosis},'{}'::jsonb) || ${JSON.stringify({ receipt })}::jsonb ELSE ${verificationTable.diagnosis} END
          ELSE ${diagnosis ? JSON.stringify(diagnosis) : null}::jsonb END`,
          completedAt: query`now()`,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(verificationTable.id, verification.id),
            notInArray(verificationTable.state, ["succeeded", "cancelled"]),
            or(isNull(verificationTable.diagnosis), query`${succeeded}`),
          ),
        )
        .returning({ diagnosis: verificationTable.diagnosis });
      if (!succeeded) {
        // A competing reconciler may have saved another observed attempt.
        // The correction must use the saved packet, never this process's later read.
        const persisted =
          recorded ??
          (verification.diagnosis
            ? verification
            : (
                await db
                  .select({ diagnosis: verificationTable.diagnosis })
                  .from(verificationTable)
                  .where(eq(verificationTable.id, verification.id))
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
        const sessions = await db
          .select({ state: changeAgentSession.state })
          .from(changeAgentSession)
          .where(eq(changeAgentSession.changeId, change.id));
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
        await db
          .update(verificationTable)
          .set({ repairPromptedAt: query`now()`, updatedAt: query`now()` })
          .where(
            and(
              eq(verificationTable.id, verification.id),
              isNull(verificationTable.repairPromptedAt),
            ),
          );
      }
      return;
    }
    // Keep observing the exact Forgejo run: a later native success may be
    // authoritative even after infrastructure failure. Observation alone must
    // never register another runner or replace its failed environment.
    if (heldFailure) {
      await stopVerification(repository, verification);
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
    if (
      verification.runtimeAttemptID &&
      ["failed", "stopped", "cleanup-failed"].includes(verification.runtimeState ?? "")
    ) {
      const diagnosis = verificationDiagnosisInput.parse({
        kind: "execution-failed",
        summary: bounded(
          `Verification environment is unavailable. ${
            verification.runtimeFailure ??
            "The recorded runtime ended before the queued checks were accepted."
          }`,
          1_000,
        ),
        // Only a still-queued workflow proves that checks have not executed.
        // An interrupted running job keeps an unknown execution outcome.
        ...(actionRun.status === "waiting"
          ? { runtimeAttemptId: verification.runtimeAttemptID }
          : {}),
        jobs: [],
      });
      await db
        .update(verificationTable)
        .set({
          state: "failed",
          diagnosis,
          summary: diagnosis.summary,
          completedAt: query`now()`,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(verificationTable.id, verification.id),
            eq(verificationTable.runtimeAttemptId, verification.runtimeAttemptID),
            inArray(verificationTable.state, ["pending", "runner-starting", "running"]),
          ),
        );
      await stopVerification(repository, verification);
      return;
    }
    if (!verification.runnerID || !verification.runnerUUID || !verification.runnerToken) {
      if (verification.runnerID) {
        await forge.deleteRunner(repository, Number(verification.runnerID));
      }
      if (!(await stillActive())) return;
      const names = await db
        .select({ name: verificationTable.runnerName })
        .from(verificationTable)
        .where(eq(verificationTable.id, verification.id));
      const registration = await forge.registerEphemeralRunner(
        repository,
        names[0]?.name ?? `factory-${verification.id.replaceAll("-", "").slice(0, 16)}`,
      );
      const saved = await db
        .update(verificationTable)
        .set({
          runnerId: registration.id,
          runnerUuid: registration.uuid,
          runnerToken: registration.token,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(verificationTable.id, verification.id),
            query`${verificationTable.runnerId} IS NOT DISTINCT FROM ${verification.runnerID}::bigint`,
            inArray(verificationTable.state, ["pending", "runner-starting", "running"]),
            query`EXISTS(SELECT 1 FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
            WHERE change.id = ${change.id} AND change.state = 'active' AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id = change.id AND (session.state = 'stopped' OR session.stop_pending)))`,
          ),
        );
      if (saved.count !== 1) {
        // Retain a late external outcome so cancellation can retry revocation.
        await db
          .update(verificationTable)
          .set({
            runnerId: registration.id,
            runnerUuid: registration.uuid,
            runnerToken: registration.token,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(verificationTable.id, verification.id),
              eq(verificationTable.state, "cancelled"),
              or(
                isNull(verificationTable.runnerId),
                eq(verificationTable.runnerId, query`${verification.runnerID}::bigint`),
              ),
            ),
          );
        await forge.deleteRunner(repository, registration.id);
        await db
          .update(verificationTable)
          .set({ runnerId: null })
          .where(
            and(
              eq(verificationTable.id, verification.id),
              eq(verificationTable.state, "cancelled"),
              eq(verificationTable.runnerId, registration.id),
            ),
          );
        return;
      }
      verification.runnerID = String(registration.id);
      verification.runnerUUID = registration.uuid;
      verification.runnerToken = registration.token;
    }
    if (!(await stillActive())) return;
    // Continue the commissioned bootstrap against its exact retained Attempt.
    // This also settles its completed Coding predecessor after process restart;
    // startVerification cannot implicitly replace a stopped/failed Attempt.
    await runtime.startVerification(verification.id, change.userID);
    await db
      .update(verificationTable)
      .set({
        state: actionRun.status === "running" ? "running" : "runner-starting",
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(verificationTable.id, verification.id),
          inArray(verificationTable.state, ["pending", "runner-starting", "running"]),
        ),
      );
  }

  async function cancelVerifications(
    changeID: string,
    repository: ForgeRepository,
    keepCommitSHA: string | null = null,
  ) {
    const verifications = await db
      .update(verificationTable)
      .set({
        state: "cancelled",
        completedAt: query`COALESCE(${verificationTable.completedAt}, now())`,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(verificationTable.changeId, changeID),
          query`(${keepCommitSHA}::text IS NULL OR (
          ${verificationTable.commitSha} <> ${keepCommitSHA}
          AND ${keepCommitSHA} = (
            SELECT commit.commit_sha FROM factory.change_commit_operation commit
            WHERE commit.change_id = ${verificationTable.changeId} AND commit.state = 'succeeded'
            ORDER BY commit.sequence DESC LIMIT 1
          )
        ))`,
          query`(${verificationTable.state} IN ('pending', 'runner-starting', 'running') OR (
          ${verificationTable.state} = 'cancelled' AND (${verificationTable.runnerId} IS NOT NULL OR EXISTS (
            SELECT 1 FROM factory.runtime_attempt attempt
            WHERE attempt.id = ${verificationTable.runtimeAttemptId}
              AND attempt.state NOT IN ('stopped', 'failed')
          ))
        ))`,
        ),
      )
      .returning({
        id: verificationTable.id,
        runtimeAttemptID: verificationTable.runtimeAttemptId,
        runnerID: query<string | null>`${verificationTable.runnerId}::text`,
      });
    for (const verification of verifications) await stopVerification(repository, verification);
  }

  async function ensureReview(change: NonNullable<Awaited<ReturnType<typeof changeRow>>>) {
    const [verification] = await db
      .select({ id: verificationTable.id })
      .from(verificationTable)
      .where(
        and(
          eq(verificationTable.changeId, change.id),
          eq(verificationTable.commitSha, query`${change.commitSHA}`),
          eq(verificationTable.state, "succeeded"),
        ),
      );
    if (!verification || !(await verificationCleanupConfirmed(verification.id))) return;
    const focusReview = db
      .select({ id: candidateReview.id })
      .from(candidateReview)
      .innerJoin(agentTurn, eq(agentTurn.id, candidateReview.turnId))
      .where(
        and(
          eq(candidateReview.changeId, change.id),
          ne(candidateReview.commitSha, query`${change.commitSHA}`),
          inArray(candidateReview.state, ["passed", "changes-requested"]),
          eq(agentTurn.state, "completed"),
          or(eq(candidateReview.state, "passed"), isNotNull(candidateReview.repairPromptedAt)),
        ),
      )
      .orderBy(desc(candidateReview.createdAt), desc(candidateReview.ordinal))
      .limit(1);
    await db
      .insert(candidateReview)
      .values({
        id: crypto.randomUUID(),
        verificationId: verification.id,
        changeId: change.id,
        commitSha: query`${change.commitSHA}`,
        baseSha: change.baseSHA,
        createdBy: change.userID,
        focusReviewId: query<string | null>`(${focusReview})`,
      })
      .onConflictDoNothing({ target: [candidateReview.verificationId, candidateReview.ordinal] });
    const [review] = await db
      .select({
        id: candidateReview.id,
        turnID: candidateReview.turnId,
        state: candidateReview.state,
        result: candidateReview.result,
        repairCommandID: candidateReview.repairCommandId,
        repaired: query<boolean>`${candidateReview.repairPromptedAt} IS NOT NULL`,
        userID: candidateReview.createdBy,
        findingSourceID: candidateReview.findingSourceId,
      })
      .from(candidateReview)
      .where(
        and(
          eq(candidateReview.verificationId, verification.id),
          eq(candidateReview.commitSha, query`${change.commitSHA}`),
        ),
      )
      .orderBy(desc(candidateReview.ordinal))
      .limit(1);
    if (!review) return;
    const [session] = await db
      .select({ state: changeAgentSession.state, stopping: changeAgentSession.stopPending })
      .from(changeAgentSession)
      .where(eq(changeAgentSession.changeId, change.id));
    if (session?.stopping || (session && session.state !== "committed")) return;
    const [work] = await db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.changeId, change.id),
          inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
        ),
      );
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
      const [created] = await db
        .insert(candidateReview)
        .select(
          db
            .select({
              ...pendingReviewColumns(),
              id: query<string>`${crypto.randomUUID()}::uuid`.as("id"),
              ordinal: query<number>`${candidateReview.ordinal}+1`.as("ordinal"),
              findingSourceId: candidateReview.id,
            })
            .from(candidateReview)
            .where(
              and(
                eq(candidateReview.id, review.id),
                exists(
                  db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(
                      and(
                        eq(agentTurn.id, candidateReview.turnId),
                        eq(agentTurn.state, "completed"),
                      ),
                    ),
                ),
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({ id: candidateReview.id });
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
    await db
      .update(candidateReview)
      .set({ repairPromptedAt: query`now()` })
      .where(and(eq(candidateReview.id, review.id), isNull(candidateReview.repairPromptedAt)));
  }

  async function reconcileMerge(
    change: NonNullable<Awaited<ReturnType<typeof changeRow>>>,
    repository: ForgeRepository,
  ) {
    const rows = await db
      .select({
        id: mergeOperation.id,
        state: mergeOperation.state,
        commitSHA: mergeOperation.commitSha,
        baseSHA: mergeOperation.baseSha,
        pullRequestNumber: query<string>`${mergeOperation.pullRequestNumber}::text`,
        monitoringIncidentID: deliveryApproval.monitoringIncidentId,
        deliveryPolicyID: deliveryApproval.deliveryPolicyId,
      })
      .from(mergeOperation)
      .innerJoin(deliveryApproval, eq(deliveryApproval.id, mergeOperation.deliveryApprovalId))
      .where(eq(mergeOperation.changeId, change.id))
      .orderBy(
        desc(query<boolean>`${mergeOperation.state}<>'failed'`),
        desc(mergeOperation.requestedAt),
        desc(mergeOperation.id),
      )
      .limit(1);
    const operation = rows[0];
    if (!operation || operation.state === "failed") return;
    const ensurePromotion = async (transaction: DatabaseTransaction) => {
      // Imported Projects need not have opened Main Preview before their first
      // Delivery. Initialize only its empty selection, never replace an
      // existing Preview, and persist the Promotion before starting compute.
      const tx = drizzleTransaction(transaction);
      const confirmedMerge = and(
        eq(mergeOperation.id, operation.id),
        eq(mergeOperation.state, "succeeded"),
      );
      await tx
        .insert(stagingPreview)
        .select(
          tx
            .select({
              projectId: query<string>`${change.projectID}::uuid`.as("project_id"),
              revision: query<string>`${operation.commitSHA}::text`.as("revision"),
              runtimeAttemptId: query<null>`NULL::uuid`.as("runtime_attempt_id"),
              createdAt: query<Date>`now()`.as("created_at"),
              updatedAt: query<Date>`now()`.as("updated_at"),
            })
            .from(mergeOperation)
            .where(confirmedMerge),
        )
        .onConflictDoNothing({ target: stagingPreview.projectId });
      await tx
        .insert(promotionOperation)
        .select(
          tx
            .select({
              id: query<string>`${crypto.randomUUID()}::uuid`.as("id"),
              changeId: query<string>`${change.id}::uuid`.as("change_id"),
              projectId: query<string>`${change.projectID}::uuid`.as("project_id"),
              commitSha: query<string>`${operation.commitSHA}::text`.as("commit_sha"),
              previousRuntimeAttemptId: stagingPreview.runtimeAttemptId,
              replacementRuntimeAttemptId: query<null>`NULL::uuid`.as(
                "replacement_runtime_attempt_id",
              ),
              state: query<"pending">`'pending'::factory.promotion_operation_state`.as("state"),
              lastError: query<null>`NULL::text`.as("last_error"),
              requestedAt: query<Date>`now()`.as("requested_at"),
              updatedAt: query<Date>`now()`.as("updated_at"),
              completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
              ordinal: query<number>`1`.as("ordinal"),
              supersedesId: query<null>`NULL::uuid`.as("supersedes_id"),
              retryCommandId: query<null>`NULL::uuid`.as("retry_command_id"),
            })
            .from(stagingPreview)
            .where(
              and(
                eq(stagingPreview.projectId, change.projectID),
                exists(
                  tx.select({ id: mergeOperation.id }).from(mergeOperation).where(confirmedMerge),
                ),
              ),
            ),
        )
        .onConflictDoNothing({ target: [promotionOperation.changeId, promotionOperation.ordinal] });
    };
    if (operation.state === "succeeded") {
      // Continue the confirmed outcome without repeating its external merge.
      // The same insert also closes an interrupted first-Delivery admission.
      await database.client.begin(ensurePromotion);
      return;
    }
    const outcomeUnknown = operation.state === "ambiguous" || operation.state === "executing";
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
        await db
          .update(mergeOperation)
          .set({
            state: "ambiguous",
            lastError: "Default branch moved before the earlier merge outcome was confirmed",
            completedAt: null,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(mergeOperation.id, operation.id),
              inArray(mergeOperation.state, ["executing", "ambiguous"]),
            ),
          );
        return;
      }
      await db
        .update(mergeOperation)
        .set({
          state: "failed",
          lastError: "Delivery gate moved before merge",
          completedAt: query`now()`,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(mergeOperation.id, operation.id),
            notInArray(mergeOperation.state, ["succeeded", "failed"]),
          ),
        );
      await db
        .update(changeTable)
        .set({
          state: "active",
          failure: "Delivery basis changed before merge",
          version: query`${changeTable.version}+1`,
        })
        .where(and(eq(changeTable.id, change.id), eq(changeTable.state, "delivering")));
      return;
    }
    await db
      .update(mergeOperation)
      .set({ state: "executing", updatedAt: query`now()` })
      .where(
        and(
          eq(mergeOperation.id, operation.id),
          inArray(mergeOperation.state, ["pending", "ambiguous"]),
        ),
      );
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
        const tx = drizzleTransaction(transaction);
        await tx
          .update(mergeOperation)
          .set({
            state: "succeeded",
            observedDefaultSha: merged.headSha,
            completedAt: query`now()`,
            updatedAt: query`now()`,
            lastError: null,
          })
          .where(eq(mergeOperation.id, operation.id));
        await ensurePromotion(transaction);
        await tx
          .update(changeTable)
          .set({
            state: "delivering",
            failure: null,
            version: query`${changeTable.version}+1`,
          })
          .where(eq(changeTable.id, change.id));
      });
    } catch (cause) {
      const message = failureMessage(cause, "Merge failed");
      if (
        cause instanceof CommandError &&
        (operation.monitoringIncidentID || operation.deliveryPolicyID) &&
        !outcomeUnknown
      ) {
        await db
          .update(mergeOperation)
          .set({
            state: "failed",
            lastError: message,
            completedAt: query`now()`,
            updatedAt: query`now()`,
          })
          .where(and(eq(mergeOperation.id, operation.id), eq(mergeOperation.state, "executing")));
        await db
          .update(changeTable)
          .set({ state: "active", failure: message, version: query`${changeTable.version}+1` })
          .where(and(eq(changeTable.id, change.id), eq(changeTable.state, "delivering")));
        return;
      }
      await db
        .update(mergeOperation)
        .set({
          state: "ambiguous",
          lastError: message,
          completedAt: null,
          updatedAt: query`now()`,
        })
        .where(eq(mergeOperation.id, operation.id));
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
        await cancelVerifications(change.id, forgeRepositoryFromURL(change.repositoryURL));
        return;
      }
      if (!change.commitSHA || change.state === "failed") {
        if (integration) await coordination.release(change.id);
        return;
      }
      await publishWorkspaceCandidate(database, change.id);
      await cancelVerifications(
        change.id,
        forgeRepositoryFromURL(change.repositoryURL),
        change.commitSHA,
      );
      if (change.state === "delivered") {
        await reconcilePromotion(change, forgeRepositoryFromURL(change.repositoryURL));
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
          await db
            .update(changeTable)
            .set({ deliveryWaitingSha: null, deliveryWaitingPolicyId: null })
            .where(
              and(
                eq(changeTable.id, changeID),
                eq(changeTable.deliveryWaitingSha, change.commitSHA),
              ),
            );
        }
        const [blocked] =
          await database.client`SELECT session.change_id FROM factory.change_agent_session session
          JOIN factory.change_writer writer ON writer.change_id=session.change_id
          LEFT JOIN factory.agent_turn turn ON turn.id=session.active_turn_id
           WHERE session.change_id=${changeID} AND (session.stop_pending OR (session.state IN ('failed','stopped','waiting') AND NOT EXISTS(
             SELECT id FROM factory.change_commit_operation WHERE change_id=${changeID} AND source::text='workspace' AND state='succeeded'
               AND sequence=(SELECT max(sequence) FROM factory.change_commit_operation WHERE change_id=${changeID} AND state='succeeded')))
            OR (session.state IN ('starting','working') AND turn.authority->'review' IS NULL)
            OR writer.state IN ('human','handoff') OR EXISTS(
              SELECT 1 FROM factory.candidate_review review
              JOIN factory.verification verification ON verification.id=review.verification_id
              LEFT JOIN factory.agent_turn reviewer ON reviewer.id=review.turn_id
              WHERE review.change_id=${changeID} AND verification.commit_sha=${change.commitSHA}
                AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
                AND (review.state='incomplete' OR reviewer.state IN ('failed','stopped','uncertain'))))`;
        if (blocked && change.state !== "delivering") {
          await coordination.release(changeID);
          return;
        }
        const [feedback] = await db
          .select({
            open: exists(
              db
                .select({ id: reviewFeedback.id })
                .from(reviewFeedback)
                .where(
                  and(
                    eq(reviewFeedback.changeId, changeID),
                    eq(reviewFeedback.kind, "thread"),
                    ne(reviewFeedback.state, "resolved"),
                  ),
                ),
            ),
          })
          .from(changeTable)
          .where(eq(changeTable.id, changeID));
        if (feedback?.open && change.state !== "delivering") {
          // A human needs exact-candidate checks and QA to recheck a correction.
          // Do not integrate or hold the Project Delivery slot while they decide.
          await coordination.release(changeID);
          const pull = await ensurePullRequest(change);
          if (pull) {
            await ensureVerification(change, pull.repository, pull.pullRequest);
            if (pull.pullRequest.headSha === change.commitSHA && !pull.pullRequest.merged)
              await ensureReview(change);
          }
          return;
        }
        if (!(await coordination.claim(change.projectID, change.id))) return;
        if (change.state === "active") {
          const currentBase = await forge.getDefaultBranch(
            forgeRepositoryFromURL(change.repositoryURL),
          );
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
      const merge = await db
        .select({
          exists: exists(
            db
              .select({ id: mergeOperation.id })
              .from(mergeOperation)
              .where(
                and(eq(mergeOperation.changeId, change.id), ne(mergeOperation.state, "failed")),
              ),
          ),
        })
        .from(changeTable)
        .where(eq(changeTable.id, change.id));
      if (merge[0]?.exists) {
        await reconcileMerge(change, pull.repository);
        await reconcilePromotion(change, pull.repository);
        if (integration) {
          const [terminal] = await db
            .select({ id: mergeOperation.id })
            .from(mergeOperation)
            .where(and(eq(mergeOperation.changeId, changeID), eq(mergeOperation.state, "failed")));
          if (terminal) await coordination.release(changeID);
        }
        return;
      }
      await ensureVerification(change, pull.repository, pull.pullRequest);
      if (pull.pullRequest.headSha === change.commitSHA && !pull.pullRequest.merged)
        await ensureReview(change);
      if (integration) {
        const [review] = await db
          .select({ state: candidateReview.state })
          .from(candidateReview)
          .innerJoin(verificationTable, eq(verificationTable.id, candidateReview.verificationId))
          .where(
            and(
              eq(candidateReview.changeId, changeID),
              eq(candidateReview.commitSha, query`${change.commitSHA}`),
              eq(candidateReview.baseSha, change.baseSHA),
              eq(verificationTable.state, "succeeded"),
            ),
          )
          .orderBy(desc(candidateReview.createdAt), desc(candidateReview.ordinal))
          .limit(1);
        if (review?.state === "passed") {
          const policy = await coordination.activePolicy(change.projectID);
          if (policy) {
            try {
              await api.approve(changeID, policy.userID, undefined, policy.id);
              return;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              await db
                .update(changeTable)
                .set({ failure: cause.message.slice(0, 2000) })
                .where(
                  and(
                    eq(changeTable.id, changeID),
                    eq(changeTable.state, "active"),
                    query`${changeTable.failure} IS DISTINCT FROM ${cause.message.slice(0, 2000)}`,
                  ),
                );
            }
          }
          await db
            .update(changeTable)
            .set({
              deliveryWaitingSha: change.commitSHA,
              deliveryWaitingPolicyId: policy?.id ?? null,
            })
            .where(
              and(
                eq(changeTable.id, changeID),
                eq(changeTable.state, "active"),
                query`ROW(${changeTable.deliveryWaitingSha},${changeTable.deliveryWaitingPolicyId}) IS DISTINCT FROM ROW(${change.commitSHA}::text,${policy?.id ?? null}::uuid)`,
              ),
            );
          await coordination.release(changeID);
        } else if (review && !["pending", "running"].includes(review.state)) {
          await coordination.release(changeID);
        }
      }
    } catch (cause) {
      if (integration) await coordination.release(changeID);
      const message = failureMessage(cause, "Delivery failed");
      await db
        .update(changeTable)
        .set({ failure: message, version: query`${changeTable.version}+1` })
        .where(
          and(
            eq(changeTable.id, changeID),
            notInArray(changeTable.state, ["cancelled", "delivered"]),
            query`${changeTable.failure} IS DISTINCT FROM ${message}`,
          ),
        );
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
      // The native view remains the owner of current-promotion selection.
      const promotion = db
        .select({
          changeId: query<string>`promotion.change_id`.as("change_id"),
          lastError: query<string | null>`promotion.last_error`.as("last_error"),
        })
        .from(query`factory.current_promotion promotion`)
        .as("promotion");
      const changes = await db
        .selectDistinct({
          id: changeTable.id,
          projectID: changeTable.projectId,
          createdAt: query<string>`${changeTable.createdAt}`,
        })
        .from(changeTable)
        .innerJoin(changeCommitOperation, eq(changeCommitOperation.changeId, changeTable.id))
        .leftJoin(promotion, eq(query<string>`"promotion"."change_id"`, changeTable.id))
        .where(
          and(
            eq(changeCommitOperation.state, "succeeded"),
            or(
              ne(changeTable.state, "cancelled"),
              exists(
                db
                  .select({ id: verificationTable.id })
                  .from(verificationTable)
                  .leftJoin(
                    runtimeAttempt,
                    eq(runtimeAttempt.id, verificationTable.runtimeAttemptId),
                  )
                  .where(
                    and(
                      eq(verificationTable.changeId, changeTable.id),
                      or(
                        isNotNull(verificationTable.runnerId),
                        notInArray(runtimeAttempt.state, ["stopped", "failed"]),
                      ),
                    ),
                  ),
              ),
            ),
            or(
              ne(changeTable.state, "delivered"),
              isNotNull(query<string | null>`"promotion"."last_error"`),
            ),
          ),
        )
        .orderBy(asc(changeTable.createdAt), asc(changeTable.id));
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
      await db
        .update(pullRequestOperation)
        .set({ state: "ambiguous", updatedAt: query`now()` })
        .where(eq(pullRequestOperation.state, "executing"));
      await db
        .update(mergeOperation)
        .set({ state: "ambiguous", updatedAt: query`now()` })
        .where(eq(mergeOperation.state, "executing"));
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
      if (!change?.commitSHA)
        throw new CommandError("conflict", "Change has no delivered commit candidate");
      if (integration)
        await db
          .update(changeTable)
          .set({ deliveryWaitingSha: null, deliveryWaitingPolicyId: null })
          .where(
            and(
              eq(changeTable.id, changeID),
              eq(changeTable.state, "active"),
              eq(changeTable.deliveryWaitingSha, change.commitSHA),
            ),
          );
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
      const repository = forgeRepositoryFromURL(change.repositoryURL);
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
        const [eligible] = await db
          .select({ id: candidateReview.id })
          .from(candidateReview)
          .where(
            and(
              eq(candidateReview.id, verification.reviewID),
              query`${candidateReview.result}->>'delivery'='ordinary'`,
            ),
          );
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
          await db
            .update(changeTable)
            .set({ deliveryWaitingSha: null, deliveryWaitingPolicyId: null })
            .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "active")));
          void reconcile(changeID);
        }
        throw new CommandError("conflict", "Current commit is not eligible for delivery");
      }
      const approvalID = crypto.randomUUID();
      const mergeID = crypto.randomUUID();
      const candidateDigest =
        monitoringIncidentID || deliveryPolicyID
          ? await monitoringCandidate(forge, repository, change.baseSHA, verification.commitSHA)
          : null;
      await database.client.begin(async (transaction) => {
        const tx = drizzleTransaction(transaction);
        await projectDevelopmentAuthorityIn(transaction, userID, change.projectID);
        if (integration) {
          // A waiting reconciler may release our first claim during Forge reads.
          // Reclaim only a vacant slot, then keep it locked through admission.
          // Queue-before-Change matches claim's foreign-key lock order.
          await tx
            .update(projectDeliveryQueue)
            .set({ changeId: changeID, updatedAt: query`now()` })
            .where(
              and(
                eq(projectDeliveryQueue.projectId, change.projectID),
                isNull(projectDeliveryQueue.changeId),
              ),
            );
          const [slot] = await transaction`SELECT project_id FROM factory.project_delivery_queue
            WHERE project_id=${change.projectID} AND change_id=${changeID} FOR SHARE`;
          if (!slot)
            throw new CommandError(
              "conflict",
              "This candidate no longer owns the Project Delivery slot.",
            );
        }
        // Read scope only after the lock wait. A joined statement's earlier
        // snapshot cannot authorize Requirements committed while it waited.
        await transaction`SELECT change.id FROM factory.change change
          JOIN factory.ticket ticket ON ticket.id=change.ticket_id
          WHERE change.id=${changeID} FOR UPDATE OF change,ticket`;
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
        const [thread] = await tx
          .select({ id: reviewFeedback.id })
          .from(reviewFeedback)
          .where(
            and(
              eq(reviewFeedback.changeId, changeID),
              eq(reviewFeedback.kind, "thread"),
              query`${reviewFeedback.state}<>'resolved'`,
            ),
          )
          .limit(1);
        if (thread)
          throw new CommandError("conflict", "Resolve the open review Threads before Delivery.");
        const [work] = await tx
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.changeId, changeID),
              inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
            ),
          );
        const [session] = await tx
          .select({ state: changeAgentSession.state })
          .from(changeAgentSession)
          .where(eq(changeAgentSession.changeId, changeID));
        const [commit] = await tx
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
        await tx
          .insert(deliveryApproval)
          .values({
            id: approvalID,
            changeId: changeID,
            verificationId: verification.id,
            commitSha: verification.commitSHA,
            approvedBy: userID,
            candidateReviewId: verification.reviewID,
            monitoringIncidentId: monitoringIncidentID ?? null,
            monitoringPolicyId: delegated?.policyId ?? null,
            deliveryPolicyId: deliveryPolicyID ?? null,
          })
          .onConflictDoNothing();
        if (delegated && candidateDigest)
          await tx.insert(monitoringEvidence).values({
            id: crypto.randomUUID(),
            incidentId: delegated.id,
            kind: "delivery-candidate",
            digest: candidateDigest,
            commitSha: verification.commitSHA,
          });
        await tx
          .insert(mergeOperation)
          .select(
            tx
              .select({
                id: query<string>`${mergeID}::uuid`.as("id"),
                changeId: query<string>`${changeID}::uuid`.as("change_id"),
                deliveryApprovalId: deliveryApproval.id,
                pullRequestNumber: query<number>`${pullRequest.number}::bigint`.as(
                  "pull_request_number",
                ),
                baseSha: query<string>`${change.baseSHA}::text`.as("base_sha"),
                commitSha: query<string>`${verification.commitSHA}::text`.as("commit_sha"),
                idempotencyKey:
                  query<string>`${`change:${changeID}:merge:`} || ${deliveryApproval.id}::text`.as(
                    "idempotency_key",
                  ),
                state: query<"pending">`'pending'::factory.merge_operation_state`.as("state"),
                observedDefaultSha: query<null>`NULL::text`.as("observed_default_sha"),
                lastError: query<null>`NULL::text`.as("last_error"),
                requestedAt: query<Date>`now()`.as("requested_at"),
                updatedAt: query<Date>`now()`.as("updated_at"),
                completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
              })
              .from(deliveryApproval)
              .where(
                and(
                  eq(deliveryApproval.verificationId, verification.id),
                  eq(deliveryApproval.candidateReviewId, verification.reviewID),
                  eq(deliveryApproval.approvedBy, userID),
                  query`${deliveryApproval.monitoringPolicyId} IS NOT DISTINCT FROM ${delegated?.policyId ?? null}::uuid`,
                  query`${deliveryApproval.deliveryPolicyId} IS NOT DISTINCT FROM ${deliveryPolicyID ?? null}::uuid`,
                ),
              ),
          )
          .onConflictDoNothing();
        await tx
          .update(changeTable)
          .set({
            state: "delivering",
            failure: null,
            version: query`${changeTable.version}+1`,
          })
          .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "active")));
      });
      void reconcile(changeID);
      return this.get(changeID);
    },
    async cancel(changeID: string) {
      const change = await changeRow(changeID);
      if (!change) return;
      const repository = forgeRepositoryFromURL(change.repositoryURL);
      await cancelVerifications(changeID, repository);
    },
    async retryPromotion(changeID: string, userID: string, commandID: string, promotionID: string) {
      const admitted = await retryPromotion(
        database,
        changeID,
        userID,
        commandID,
        promotionID,
        async (url) => (await forge.getDefaultBranch(forgeRepositoryFromURL(url))).headSha,
      );
      if (admitted) await reconcile(changeID);
      return this.get(changeID);
    },
    async retryBootstrap(
      changeID: string,
      userID: string,
      commandID: string,
      verificationID: string,
      runtimeAttemptID: string,
    ) {
      const admitted = await retryVerificationBootstrap(
        database,
        changeID,
        userID,
        commandID,
        verificationID,
        runtimeAttemptID,
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
        const tx = drizzleTransaction(sql);
        const [previous] = await tx
          .select({
            scope: executionPolicyCommand.scope,
            userID: executionPolicyCommand.actorId,
            input: query<typeof input>`${executionPolicyCommand.input}`,
          })
          .from(executionPolicyCommand)
          .where(eq(executionPolicyCommand.commandId, commandID));
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
            ${submittedCandidate(sql)} AS submitted
          FROM factory.verification verification
          JOIN factory.change change ON change.id=verification.change_id
          JOIN factory.change_agent_session session ON session.change_id=change.id
          JOIN factory.change_writer writer ON writer.change_id=change.id
          JOIN LATERAL (
            SELECT id,commit_sha FROM factory.change_commit_operation
            WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1
          ) commit ON commit.commit_sha=verification.commit_sha
          WHERE verification.id=${verificationID} AND change.id=${changeID}
            AND verification.state<>'cancelled' AND change.state='active'`;
        if (
          !writer.available ||
          !["agent", "unassigned"].includes(writer.state) ||
          !candidate?.submitted ||
          candidate.state !== "stopped" ||
          candidate.stopping ||
          candidate.stopID !== stopID
        )
          throw new CommandError(
            "conflict",
            "Resume checks only after Stop is confirmed and the current implementation is submitted",
          );
        // Restore only the submitted candidate's delivery eligibility. No turn,
        // prompt, source edit or Stop confirmation is created or replayed here.
        await tx
          .update(changeAgentSession)
          .set({ state: "committed", lastError: null, updatedAt: query`now()` })
          .where(eq(changeAgentSession.changeId, changeID));
        await tx
          .insert(executionPolicyCommand)
          .values({ commandId: commandID, scope, actorId: userID, input, result: {} });
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
        const tx = drizzleTransaction(sql);
        const commit = tx
          .select({
            sha: changeCommitOperation.commitSha,
            base: changeCommitOperation.integrationBaseSha,
          })
          .from(changeCommitOperation)
          .where(
            and(
              eq(changeCommitOperation.changeId, changeTable.id),
              eq(changeCommitOperation.state, "succeeded"),
            ),
          )
          .orderBy(desc(changeCommitOperation.sequence))
          .limit(1)
          .as("commit");
        const [change] = await tx
          .select({
            projectID: changeTable.projectId,
            base: query<string>`COALESCE(${commit.base},${changeTable.baseSha})`,
            state: changeTable.state,
            runtimeState: runtimeAttempt.state,
            sha: commit.sha,
          })
          .from(changeTable)
          .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
          .leftJoinLateral(commit, query`true`)
          .where(eq(changeTable.id, changeID));
        if (!change) throw new CommandError("not-found", "Change not found");
        await projectAuthorityIn(sql, userID, change.projectID);
        const [old] = await tx
          .select({
            changeID: candidateReview.changeId,
            userID: candidateReview.createdBy,
            previousID: candidateReview.supersedesId,
          })
          .from(candidateReview)
          .where(eq(candidateReview.id, commandID));
        if (old) {
          if (
            old.changeID !== changeID ||
            old.userID !== userID ||
            old.previousID !== previousReviewID
          )
            throw new CommandError("conflict", "Review retry changed target");
          return;
        }
        const [previous] = await tx
          .select({
            id: candidateReview.id,
            verificationID: candidateReview.verificationId,
            ordinal: candidateReview.ordinal,
            state: candidateReview.state,
            turnState: agentTurn.state,
          })
          .from(candidateReview)
          .leftJoin(agentTurn, eq(agentTurn.id, candidateReview.turnId))
          .innerJoin(verificationTable, eq(verificationTable.id, candidateReview.verificationId))
          .where(
            and(
              eq(candidateReview.changeId, changeID),
              eq(candidateReview.commitSha, query`${change.sha}`),
              eq(verificationTable.state, "succeeded"),
            ),
          )
          .orderBy(desc(candidateReview.ordinal))
          .limit(1);
        const [session] = await tx
          .select({ stopping: changeAgentSession.stopPending })
          .from(changeAgentSession)
          .where(eq(changeAgentSession.changeId, changeID));
        const [active] = await tx
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.changeId, changeID),
              inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
            ),
          );
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
        await tx.insert(candidateReview).select(
          tx
            .select({
              ...pendingReviewColumns(),
              id: query<string>`${commandID}::uuid`.as("id"),
              verificationId: query<string>`${previous.verificationID}::uuid`.as("verification_id"),
              ordinal: query<number>`${previous.ordinal + 1}::integer`.as("ordinal"),
              changeId: query<string>`${changeID}::uuid`.as("change_id"),
              commitSha: query<string>`${change.sha}::text`.as("commit_sha"),
              baseSha: query<string>`${change.base}::text`.as("base_sha"),
              createdBy: query<string>`${userID}::uuid`.as("created_by"),
              supersedesId: query<string>`${previousReviewID}::uuid`.as("supersedes_id"),
            })
            .from(candidateReview)
            .where(eq(candidateReview.id, previousReviewID)),
        );
      });
      await agent.review(changeID, commandID, userID);
      return this.get(changeID);
    },
    async stopForTrash(changeID: string) {
      const change = await changeRow(changeID);
      if (!change) return;
      const repository = forgeRepositoryFromURL(change.repositoryURL);
      await cancelVerifications(changeID, repository);
      const deadline = Date.now() + 60_000;
      while (running.has(changeID) && Date.now() < deadline) await Bun.sleep(50);
      if (running.has(changeID)) throw new Error("Verification stop is not confirmed");
      // Observe late runner registration before allowing Restore, then revoke it.
      await cancelVerifications(changeID, repository);
      const retained = await db
        .select({
          id: verificationTable.id,
          runtimeAttemptID: verificationTable.runtimeAttemptId,
          runnerID: query<string | null>`${verificationTable.runnerId}::text`,
        })
        .from(verificationTable)
        .where(
          and(
            eq(verificationTable.changeId, changeID),
            query`${verificationTable.runnerId} IS NOT NULL`,
          ),
        );
      for (const verification of retained) await stopVerification(repository, verification);
      const [remaining] = await db
        .select({ id: verificationTable.id })
        .from(verificationTable)
        .where(
          and(
            eq(verificationTable.changeId, changeID),
            query`${verificationTable.runnerId} IS NOT NULL`,
          ),
        )
        .limit(1);
      if (remaining) throw new Error("Verification runner revocation is not confirmed");
    },
    async get(changeID: string) {
      const rows = await database.client<Array<Record<string, unknown>>>`
        SELECT pr.pull_request_number AS "pullRequestNumber",
          verification.id AS "verificationId",
          CASE WHEN session.state='stopped' AND NOT session.stop_pending
            AND writer.state IN ('agent','unassigned') AND change.cancel_requested_at IS NULL
            AND ${submittedCandidate(database.client)}
            AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id AND trashed_at IS NULL)
            AND verification.state<>'cancelled' AND change.state='active'
            THEN session.stop_id END AS "checksStopId",
          CASE WHEN verification.state='failed' AND change.state='active'
            AND change.cancel_requested_at IS NULL
            AND (session.change_id IS NULL OR (session.state='committed' AND NOT session.stop_pending))
            AND writer.state IN ('agent','unassigned')
            AND verification.runner_id IS NULL AND verification.action_run_id IS NOT NULL
            AND verification.completed_at IS NOT NULL AND verification.repair_prompted_at IS NULL
            AND verification_runtime.state='stopped' AND verification_runtime.verification_id=verification.id
            AND verification.diagnosis->>'kind'='execution-failed'
            AND verification.diagnosis->>'runtimeAttemptId'=verification_runtime.id::text
            AND verification.diagnosis->'jobs'='[]'::jsonb
            AND ${submittedCandidate(database.client)}
            AND EXISTS(SELECT 1 FROM factory.substrate_binding binding
              WHERE binding.runtime_attempt_id=verification_runtime.id AND binding.deleted_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE change_id=change.id
              AND kind='thread' AND state<>'resolved')
            AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id AND trashed_at IS NULL)
            THEN verification_runtime.id END AS "checksRetryAttemptId",
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
          EXISTS(SELECT 1 FROM factory.runtime_compute_wait waiting
            WHERE waiting.attempt_id=verification_runtime.id AND waiting.reason='compute-capacity'
              AND verification_runtime.verification_id=verification.id
              AND verification_runtime.state='starting' AND nullif(verification_runtime.failure,'') IS NULL
              AND verification_runtime.ready_at IS NULL AND verification_runtime.stop_intended_at IS NULL
              AND verification.state IN ('pending','runner-starting')
              AND change.state='active' AND change.cancel_requested_at IS NULL
              AND session.state='committed' AND NOT session.stop_pending
              AND writer.state IN ('agent','unassigned')
              AND EXISTS(SELECT 1 FROM auth."user" principal
                JOIN factory.account_access access ON access.user_id=principal.id
                WHERE principal.id=verification.created_by
                  AND access.disabled_at IS NULL AND access.directory_disabled_at IS NULL
                  AND (EXISTS(SELECT 1 FROM factory.project_membership membership
                    WHERE membership.project_id=change.project_id AND membership.user_id=principal.id)
                    OR EXISTS(SELECT 1 FROM factory.administrator administrator
                      WHERE administrator.user_id=principal.id)))
              AND EXISTS(SELECT 1 FROM factory.ticket WHERE id=change.ticket_id
                AND state<>'cancelled' AND trashed_at IS NULL)) AS "verificationComputeWait",
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
