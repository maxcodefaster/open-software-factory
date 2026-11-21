import { and, eq, inArray, isNull, notInArray, or, sql as query } from "drizzle-orm";
import {
  verificationChangeScope,
  verificationDiagnosisInput,
  verificationRepairInstructions,
} from "../../../../packages/conversation-domain/src/verification";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  changeAgentSession,
  runtimeAttempt,
  verification as verificationTable,
} from "../../../../packages/db/src/schema";
import type { ForgeRepository } from "../../../../packages/forge/src/contracts";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { reportFailure } from "../failure-log";
import type { RuntimeAttemptView } from "../runtime/types";

export const verificationWorkflowPath = ".forgejo/workflows/factory-verification.yml";
const workflowID = "factory-verification.yml";

type VerificationCandidate = {
  id: string;
  commitSHA: string | null;
  baseSHA: string;
  defaultBranch: string;
  userID: string;
};

function bounded(value: string, limit = 2_000) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function createDeliveryVerification(
  database: ReturnType<typeof createDatabase>,
  runtime: {
    startVerification(id: string, userID: string): Promise<RuntimeAttemptView | null>;
    stop(id: string): Promise<RuntimeAttemptView | null>;
  },
  forge: Pick<
    ReturnType<typeof createForgejoClient>,
    | "getFile"
    | "listActionRuns"
    | "diagnoseVerification"
    | "observeVerification"
    | "listFiles"
    | "registerEphemeralRunner"
    | "deleteRunner"
  >,
  agent: {
    prompt(
      changeID: string,
      text: string,
      userID: string,
      commandID: string,
      repair?: boolean,
    ): Promise<unknown>;
  },
  failedCorrections: (changeID: string) => Promise<number>,
) {
  const db = drizzleTransaction(database.client);
  async function stopVerification(
    repository: ForgeRepository,
    verification: { id: string; runtimeAttemptID: string | null; runnerID: string | null },
  ): Promise<void> {
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

  async function verificationCleanupConfirmed(verificationID: string): Promise<boolean> {
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
    change: VerificationCandidate,
    repository: ForgeRepository,
    pullRequest: { number: number; headSha: string; merged: boolean },
  ): Promise<void> {
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
      const candidateWorkflow = await forge.getFile(
        repository,
        verificationWorkflowPath,
        change.commitSHA,
      );
      const protectedWorkflow = await forge.getFile(
        repository,
        verificationWorkflowPath,
        change.defaultBranch,
      );
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
  ): Promise<void> {
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

  async function revokeRetainedRunners(
    changeID: string,
    repository: ForgeRepository,
  ): Promise<void> {
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
  }

  return {
    ensure: ensureVerification,
    cancel: cancelVerifications,
    cleanupConfirmed: verificationCleanupConfirmed,
    revokeRetainedRunners,
  };
}
