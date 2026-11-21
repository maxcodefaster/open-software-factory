import {
  and,
  asc,
  DrizzleQueryError,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { changeIdentity } from "../../../../packages/change-domain/src/change";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  administrator,
  agentTurn,
  branchCreateOperation,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  change as changeTable,
  changeWriter,
  deliveryApproval,
  developmentWorkspace,
  implementationOrder,
  mergeOperation,
  project,
  projectMembership,
  requirementApproval,
  requirementRevision,
  runtimeAttempt,
  technicalDesignRevision,
  ticketConversation,
  ticketDocumentRevision,
  ticket as ticketTable,
  verification,
  workspaceSubmission,
} from "../../../../packages/db/src/schema";
import {
  createForgejoClient,
  ForgeAmbiguousWriteError,
  ForgeConflictError,
} from "../../../../packages/forge/src/forge";
import { forgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import type { RuntimeAttemptView } from "../runtime/types";
import { technicalPlanningOutstandingIn } from "../technical-design/api";
import { codingBudgetIn } from "../usage/api";
import { requireDeliveredPrerequisites } from "./dependencies";
import type { ChangeView } from "./types";

type Database = ReturnType<typeof createDatabase>;
type RuntimeController = {
  stop(attemptID: string): Promise<RuntimeAttemptView | null>;
};
type ImplementationAdmission = {
  commandID: string;
  revisionID: string;
  technicalDesignRevisionID?: string;
  codingReasoning?: CodingReasoning;
  expectedBaseSHA?: string;
  admitBuild(sql: DatabaseTransaction, changeID: string): Promise<unknown>;
};

export function createChangeController(
  database: Database,
  runtime: RuntimeController,
  onReady?: (changeID: string) => Promise<void>,
  protectNewBranch?: (changeID: string) => Promise<void>,
  forgeOverride?: ReturnType<typeof createForgejoClient>,
) {
  const {
    FACTORY_FORGEJO_API_URL,
    FACTORY_FORGEJO_PUBLIC_URL,
    FACTORY_FORGEJO_TOKEN,
    FACTORY_FORGEJO_OWNER,
  } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge =
    forgeOverride ??
    createForgejoClient({
      apiURL: FACTORY_FORGEJO_API_URL,
      token: FACTORY_FORGEJO_TOKEN,
    });
  const forgeOrigins = new Set([
    new URL(FACTORY_FORGEJO_API_URL).origin,
    ...(FACTORY_FORGEJO_PUBLIC_URL ? [new URL(FACTORY_FORGEJO_PUBLIC_URL).origin] : []),
  ]);
  const running = new Set<string>();
  const cancellationObservers = new Set<string>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();

  function currentBuildTurn() {
    // A confirmed human submission can supersede terminal Coding history, not
    // create a completed turn. Keep history and native/Stop identities untouched.
    // Select the latest turn first so newer work or review can never fall back
    // to an older, apparently successful input.
    // The retained Coding Session can own an earlier runtime of this Workspace.
    // A human Source submission does not rebind that native identity.
    const db = database.db;
    const turn = db
      .select({
        id: agentTurn.id,
        state: agentTurn.state,
        input: agentTurn.input,
        createdAt: agentTurn.createdAt,
        updatedAt: agentTurn.updatedAt,
      })
      .from(agentTurn)
      .where(eq(agentTurn.changeId, changeTable.id))
      .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
      .limit(1)
      .as("turn");
    const submitted = db
      .select({
        id: changeCommitOperation.id,
        source: changeCommitOperation.source,
        state: changeCommitOperation.state,
        commitSha: changeCommitOperation.commitSha,
        observedRemoteSha: changeCommitOperation.observedRemoteSha,
        completedAt: changeCommitOperation.completedAt,
        runtimeAttemptId: changeCommitOperation.runtimeAttemptId,
      })
      .from(changeCommitOperation)
      .where(eq(changeCommitOperation.changeId, changeTable.id))
      .orderBy(desc(changeCommitOperation.sequence))
      .limit(1)
      .as("submitted");
    const codingRuntime = alias(runtimeAttempt, "coding_runtime");
    return db
      .select({
        state: turn.state,
        purpose: query<string>`CASE WHEN ${turn.input}->>'kind'='change-review'
          THEN 'review' ELSE 'implementation' END`.as("purpose"),
      })
      .from(turn)
      .where(
        notExists(
          db
            .select({ id: submitted.id })
            .from(submitted)
            .innerJoin(workspaceSubmission, eq(workspaceSubmission.id, submitted.id))
            .innerJoin(
              developmentWorkspace,
              and(
                eq(developmentWorkspace.id, workspaceSubmission.workspaceId),
                eq(developmentWorkspace.changeId, changeTable.id),
              ),
            )
            .innerJoin(
              changeWriter,
              and(
                eq(changeWriter.changeId, changeTable.id),
                eq(changeWriter.epoch, workspaceSubmission.writerEpoch),
                eq(changeWriter.state, "unassigned"),
                eq(changeWriter.fenceRequired, false),
              ),
            )
            .where(
              and(
                eq(submitted.source, "workspace"),
                eq(submitted.state, "succeeded"),
                eq(submitted.commitSha, submitted.observedRemoteSha),
                isNotNull(submitted.completedAt),
                eq(submitted.runtimeAttemptId, changeTable.runtimeAttemptId),
                exists(
                  db
                    .select({ id: codingRuntime.id })
                    .from(codingRuntime)
                    .where(
                      and(
                        eq(codingRuntime.id, changeAgentSession.runtimeAttemptId),
                        eq(codingRuntime.workspaceId, developmentWorkspace.id),
                        eq(codingRuntime.changeId, changeTable.id),
                      ),
                    ),
                ),
                eq(changeAgentSession.state, "committed"),
                eq(changeAgentSession.stopPending, false),
                isNull(changeAgentSession.activeInboxId),
                isNull(changeAgentSession.lastError),
                or(
                  isNull(changeAgentSession.activeTurnId),
                  eq(changeAgentSession.activeTurnId, turn.id),
                ),
                or(
                  isNull(changeAgentSession.stopTurnId),
                  eq(changeAgentSession.stopTurnId, turn.id),
                ),
                gte(changeAgentSession.updatedAt, submitted.completedAt),
                ne(query<string>`${turn.input}->>'kind'`, "change-review"),
                inArray(turn.state, ["completed", "failed", "stopped"]),
                lt(turn.createdAt, workspaceSubmission.createdAt),
                lt(turn.updatedAt, workspaceSubmission.createdAt),
                isNull(changeTable.cancelRequestedAt),
                notExists(
                  db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(
                      and(
                        eq(agentTurn.changeId, changeTable.id),
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
                        eq(changeCommitOperation.changeId, changeTable.id),
                        notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                      ),
                    ),
                ),
              ),
            ),
        ),
      )
      .as("build");
  }

  function changeViewQuery() {
    const db = database.db;
    const build = currentBuildTurn();
    const committed = db
      .select({ commitSha: changeCommitOperation.commitSha })
      .from(changeCommitOperation)
      .where(
        and(
          eq(changeCommitOperation.changeId, changeTable.id),
          eq(changeCommitOperation.state, "succeeded"),
        ),
      )
      .orderBy(desc(changeCommitOperation.sequence))
      .limit(1);
    const verified = db
      .select({
        id: verification.id,
        state: verification.state,
        commitSha: verification.commitSha,
        runtimeAttemptId: verification.runtimeAttemptId,
      })
      .from(verification)
      .where(and(eq(verification.changeId, changeTable.id), eq(verification.commitSha, committed)))
      .orderBy(desc(verification.createdAt))
      .limit(1)
      .as("verification");
    const failedVerification = alias(runtimeAttempt, "failed_verification");
    const merge = db
      .select({
        state: mergeOperation.state,
        deliveryApprovalId: mergeOperation.deliveryApprovalId,
      })
      .from(mergeOperation)
      .where(
        and(
          eq(mergeOperation.changeId, changeTable.id),
          eq(mergeOperation.commitSha, verified.commitSha),
        ),
      )
      .orderBy(
        desc(ne(mergeOperation.state, "failed")),
        desc(mergeOperation.requestedAt),
        desc(mergeOperation.id),
      )
      .limit(1)
      .as("merge");
    const approval = db
      .select({
        approvedAt: query<string>`${deliveryApproval.approvedAt}::text`.as("approved_at"),
      })
      .from(deliveryApproval)
      .where(
        and(
          eq(deliveryApproval.verificationId, verified.id),
          or(isNull(merge.deliveryApprovalId), eq(deliveryApproval.id, merge.deliveryApprovalId)),
        ),
      )
      .orderBy(desc(deliveryApproval.approvedAt), desc(deliveryApproval.id))
      .limit(1)
      .as("approval");
    return (
      db
        .select({
          id: changeTable.id,
          projectId: changeTable.projectId,
          ticketId: changeTable.ticketId,
          requirementApprovalId: changeTable.requirementApprovalId,
          branchName: changeTable.branchName,
          baseSha: changeTable.baseSha,
          state: changeTable.state,
          // Retain the existing Postgres.js bigint representation in this DTO.
          version: query<number>`${changeTable.version}`,
          runtimeAttemptId: changeTable.runtimeAttemptId,
          failure: changeTable.failure,
          branchState: branchCreateOperation.state,
          branchHeadSha: branchCreateOperation.observedHeadSha,
          runtimeState: runtimeAttempt.state,
          verificationState: query<string | null>`CASE WHEN ${isNotNull(failedVerification.id)}
          THEN 'failed' ELSE ${verified.state}::text END`,
          buildTurnState: build.state,
          buildTurnPurpose: build.purpose,
          implementationState: changeAgentSession.state,
          deliveryApprovedAt: approval.approvedAt,
          mergeState: merge.state,
          promotionState: query<string | null>`promotion.state`,
        })
        .from(changeTable)
        .innerJoin(branchCreateOperation, eq(branchCreateOperation.changeId, changeTable.id))
        .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
        .leftJoin(changeAgentSession, eq(changeAgentSession.changeId, changeTable.id))
        .leftJoinLateral(build, query`true`)
        .leftJoinLateral(verified, query`true`)
        .leftJoin(
          failedVerification,
          and(
            eq(failedVerification.id, verified.runtimeAttemptId),
            inArray(verified.state, ["pending", "runner-starting", "running"]),
            or(
              inArray(failedVerification.state, ["failed", "cleanup-failed"]),
              and(eq(failedVerification.state, "stopped"), isNotNull(failedVerification.failure)),
            ),
          ),
        )
        .leftJoinLateral(merge, query`true`)
        .leftJoinLateral(approval, query`true`)
        // This native projection has no Drizzle model. Keep its database-owned policy.
        .leftJoin(
          query`factory.current_promotion promotion`,
          query`promotion.change_id=${changeTable.id}`,
        )
    );
  }

  function retry(changeID: string, delay: number) {
    clearTimeout(retries.get(changeID));
    const timer = setTimeout(() => {
      retries.delete(changeID);
      void reconcile(changeID);
    }, delay);
    timer.unref();
    retries.set(changeID, timer);
  }

  function observeCancellation(changeID: string) {
    if (cancellationObservers.has(changeID)) return;
    cancellationObservers.add(changeID);
    void (async () => {
      try {
        for (let observation = 0; observation < 360; observation += 1) {
          const rows = await database.db
            .select({
              state: changeTable.state,
              runtimeState: runtimeAttempt.state,
              failure: runtimeAttempt.failure,
            })
            .from(changeTable)
            .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
            .where(eq(changeTable.id, changeID));
          const current = rows[0];
          if (current?.state !== "cancelling") return;
          if (current.runtimeState === null || current.runtimeState === "stopped") {
            await database.db
              .update(changeTable)
              .set({
                state: "cancelled",
                cancelledAt: query`now()`,
                version: query`${changeTable.version} + 1`,
              })
              .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "cancelling")));
            return;
          }
          if (current.runtimeState === "failed") {
            await database.db
              .update(changeTable)
              .set({
                state: "failed",
                failure: current.failure ?? "Runtime cleanup failed",
                version: query`${changeTable.version} + 1`,
              })
              .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "cancelling")));
            return;
          }
          await Bun.sleep(1_000);
        }
        await database.db
          .update(changeTable)
          .set({
            state: "failed",
            failure: "Change cancellation did not settle",
            version: query`${changeTable.version} + 1`,
          })
          .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "cancelling")));
      } finally {
        cancellationObservers.delete(changeID);
      }
    })();
  }

  async function reconcile(changeID: string) {
    if (running.has(changeID)) return;
    // Explicit recovery supersedes a previously scheduled retry. A successful
    // reconciliation must not leave that callback using an obsolete lifetime.
    clearTimeout(retries.get(changeID));
    retries.delete(changeID);
    running.add(changeID);
    try {
      for (;;) {
        const claimed = await database.db
          .update(branchCreateOperation)
          .set({
            state: "executing",
            attemptCount: query`${branchCreateOperation.attemptCount} + 1`,
            leaseOwner: "factory-server",
            leaseGeneration: query`${branchCreateOperation.leaseGeneration} + 1`,
            leaseExpiresAt: query`now() + interval '30 seconds'`,
            updatedAt: query`now()`,
          })
          .from(changeTable)
          .where(
            and(
              eq(branchCreateOperation.changeId, changeID),
              eq(changeTable.id, branchCreateOperation.changeId),
              eq(changeTable.state, "branch-pending"),
              inArray(branchCreateOperation.state, ["pending", "ambiguous"]),
              lte(branchCreateOperation.reconcileAfter, query`now()`),
              or(
                isNull(branchCreateOperation.leaseExpiresAt),
                lt(branchCreateOperation.leaseExpiresAt, query`now()`),
              ),
            ),
          )
          .returning({
            operationID: branchCreateOperation.id,
            owner: branchCreateOperation.repositoryOwner,
            repository: branchCreateOperation.repositoryName,
            branch: branchCreateOperation.branchName,
            startSHA: branchCreateOperation.startSha,
            attempts: branchCreateOperation.attemptCount,
            userID: changeTable.createdBy,
          });
        const operation = claimed[0];
        if (!operation) return;
        const repository = { owner: operation.owner, name: operation.repository };
        const lock = await database.client.reserve();
        const db = drizzleTransaction(lock);
        await lock`SELECT pg_advisory_lock(hashtext(${`forge:${operation.owner}/${operation.repository}`}))`;
        try {
          let branch: Awaited<ReturnType<typeof forge.ensureBranch>>;
          try {
            // Forgejo accepts protection for a branch that does not exist yet.
            // Never create a temporarily writable Change branch.
            try {
              await protectNewBranch?.(changeID);
            } catch {
              throw new ForgeAmbiguousWriteError("Change branch protection is not confirmed");
            }
            const existingBranch = await forge.getBranch(repository, operation.branch);
            if (!existingBranch) {
              const currentDefault = await forge.getDefaultBranch(repository);
              if (currentDefault.headSha !== operation.startSHA) {
                throw new ForgeConflictError(
                  "Project default branch moved before Change branch creation",
                );
              }
            }
            branch = await forge.ensureBranch(repository, operation.branch, operation.startSHA);
          } catch (cause) {
            if (cause instanceof ForgeAmbiguousWriteError && operation.attempts < 12) {
              const delay = Math.min(2 ** operation.attempts, 30);
              await db
                .update(branchCreateOperation)
                .set({
                  state: "ambiguous",
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  reconcileAfter: query`now() + (${delay} * interval '1 second')`,
                  lastError: cause.message,
                  updatedAt: query`now()`,
                })
                .where(
                  and(
                    eq(branchCreateOperation.id, operation.operationID),
                    eq(branchCreateOperation.state, "executing"),
                  ),
                );
              retry(changeID, delay * 1_000);
              return;
            }
            const message = cause instanceof Error ? cause.message : "branch creation failed";
            await lock`BEGIN`;
            try {
              await db
                .update(branchCreateOperation)
                .set({
                  state: "failed",
                  completedAt: query`now()`,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  lastError: message,
                  updatedAt: query`now()`,
                })
                .where(
                  and(
                    eq(branchCreateOperation.id, operation.operationID),
                    eq(branchCreateOperation.state, "executing"),
                  ),
                );
              await db
                .update(changeTable)
                .set({
                  state: "failed",
                  failure: message,
                  version: query`${changeTable.version} + 1`,
                })
                .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "branch-pending")));
              await lock`COMMIT`;
            } catch (persistenceCause) {
              await lock`ROLLBACK`;
              throw persistenceCause;
            }
            return;
          }
          await lock`BEGIN`;
          try {
            await db
              .update(branchCreateOperation)
              .set({
                state: "succeeded",
                observedHeadSha: branch.headSha,
                completedAt: query`now()`,
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: query`now()`,
                lastError: null,
              })
              .where(
                and(
                  eq(branchCreateOperation.id, operation.operationID),
                  eq(branchCreateOperation.state, "executing"),
                ),
              );
            await db
              .update(changeTable)
              .set({ state: "active", version: query`${changeTable.version} + 1` })
              .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "branch-pending")));
            await lock`COMMIT`;
          } catch (cause) {
            await lock`ROLLBACK`;
            const failure = cause instanceof DrizzleQueryError ? cause.cause : cause;
            await db
              .update(branchCreateOperation)
              .set({
                state: "ambiguous",
                leaseOwner: null,
                leaseExpiresAt: null,
                reconcileAfter: query`now()`,
                lastError:
                  failure instanceof Error ? failure.message : "branch result persistence failed",
                updatedAt: query`now()`,
              })
              .where(
                and(
                  eq(branchCreateOperation.id, operation.operationID),
                  eq(branchCreateOperation.state, "executing"),
                ),
              );
            retry(changeID, 1_000);
            return;
          }
        } finally {
          await lock`SELECT pg_advisory_unlock(hashtext(${`forge:${operation.owner}/${operation.repository}`}))`;
          lock.release();
        }
        await onReady?.(changeID);
        return;
      }
    } finally {
      running.delete(changeID);
    }
  }

  return {
    async recover() {
      await database.db
        .update(branchCreateOperation)
        .set({
          state: "ambiguous",
          leaseOwner: null,
          leaseExpiresAt: null,
          reconcileAfter: query`now()`,
          updatedAt: query`now()`,
        })
        .where(inArray(branchCreateOperation.state, ["executing", "ambiguous"]));
      const changes = await database.db
        .select({
          id: changeTable.id,
          state: changeTable.state,
          runtimeAttemptID: changeTable.runtimeAttemptId,
        })
        .from(changeTable)
        .where(inArray(changeTable.state, ["branch-pending", "starting", "cancelling"]));
      for (const change of changes) {
        if (change.state === "branch-pending") void reconcile(change.id);
        // Runtime recovery observes the recorded attempt itself. Reopening a
        // Change cannot commission a replacement generation after Stop/failure.
        if (change.state === "starting" && !change.runtimeAttemptID) {
          await database.db
            .update(changeTable)
            .set({ state: "active", version: query`${changeTable.version} + 1` })
            .where(
              and(
                eq(changeTable.id, change.id),
                eq(changeTable.state, "starting"),
                isNull(changeTable.runtimeAttemptId),
              ),
            );
        }
        if (change.state === "cancelling") {
          if (change.runtimeAttemptID) {
            void runtime
              .stop(change.runtimeAttemptID)
              .catch(reportFailure("Cancelled change runtime stop"));
          }
          observeCancellation(change.id);
        }
      }
    },
    async start(ticketID: string, userID: string, implementation: ImplementationAdmission) {
      if (!implementation)
        throw new CommandError(
          "invalid",
          "Use Implement with an exact saved Requirement Revision and command identity.",
        );
      const changeID = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${implementation.commandID}`}))`;
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${ticketID}`}))`;
        const db = drizzleTransaction(sql);
        const [ticket] = await db
          .select({
            projectID: ticketTable.projectId,
            state: ticketTable.state,
            trashed: query<boolean>`${isNotNull(ticketTable.trashedAt)}
              OR ${isNotNull(ticketTable.convertedToEpicId)}`,
          })
          .from(ticketTable)
          .where(eq(ticketTable.id, ticketID))
          .for("update");
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        if (ticket.trashed || ticket.state === "cancelled" || ticket.state === "done")
          throw new CommandError(
            "conflict",
            "Completed or trashed Tickets cannot start implementation",
          );
        {
          const [command] = await db
            .select({
              ticketID: agentTurn.ticketId,
              userID: agentTurn.createdBy,
              revisionID: query<string>`${agentTurn.authority}->>'requirementRevisionId'`,
              kind: query<string>`${agentTurn.input}->>'kind'`,
            })
            .from(agentTurn)
            .where(eq(agentTurn.commandId, implementation.commandID));
          if (
            command &&
            (command.ticketID !== ticketID ||
              command.userID !== userID ||
              command.revisionID !== implementation.revisionID ||
              command.kind !== "change-start")
          )
            throw new CommandError(
              "conflict",
              "The implementation command identity was reused with different input",
            );
          const [latest] = await db
            .select({ id: requirementRevision.id })
            .from(requirementRevision)
            .where(eq(requirementRevision.ticketId, ticketID))
            .orderBy(desc(requirementRevision.ordinal))
            .limit(1);
          if (latest?.id !== implementation.revisionID)
            throw new CommandError(
              "conflict",
              "The Ticket changed. Review the current requirements before implementing.",
            );
          const [document] = await db
            .select({ revisionID: ticketDocumentRevision.requirementRevisionId })
            .from(ticketDocumentRevision)
            .where(eq(ticketDocumentRevision.ticketId, ticketID))
            .orderBy(desc(ticketDocumentRevision.ordinal))
            .limit(1);
          if (document && document.revisionID !== implementation.revisionID)
            throw new CommandError(
              "conflict",
              "Finish the current specification before implementing.",
            );
          if (await technicalPlanningOutstandingIn(sql, ticketID, implementation.revisionID))
            throw new CommandError(
              "conflict",
              "Finish Technical Planning before implementing this Ticket.",
            );
          const [technical] = await db
            .select({
              id: technicalDesignRevision.id,
              requirementRevisionID: technicalDesignRevision.requirementRevisionId,
            })
            .from(technicalDesignRevision)
            .where(eq(technicalDesignRevision.ticketId, ticketID))
            .orderBy(desc(technicalDesignRevision.ordinal))
            .limit(1);
          if (technical || implementation.technicalDesignRevisionID) {
            await projectDevelopmentAuthorityIn(sql, userID, ticket.projectID);
            if (
              technical?.id !== implementation.technicalDesignRevisionID ||
              technical?.requirementRevisionID !== implementation.revisionID
            )
              throw new CommandError(
                "conflict",
                "Review the current technical design for these exact requirements before implementing.",
              );
          }
          const [approval] = await db
            .select({
              revisionID: requirementApproval.requirementRevisionId,
              technicalID: requirementApproval.technicalDesignRevisionId,
            })
            .from(requirementApproval)
            .where(eq(requirementApproval.ticketId, ticketID));
          if (approval && approval.revisionID !== implementation.revisionID)
            throw new CommandError(
              "conflict",
              "This Ticket already implements different requirements.",
            );
          if (
            approval &&
            approval.technicalID !== (implementation.technicalDesignRevisionID ?? null)
          )
            throw new CommandError("conflict", "This Ticket keeps its approved technical design.");
          if (!approval)
            await db.insert(requirementApproval).values({
              id: crypto.randomUUID(),
              ticketId: ticketID,
              requirementRevisionId: implementation.revisionID,
              technicalDesignRevisionId: implementation.technicalDesignRevisionID ?? null,
              approvedBy: userID,
            });
          const [busy] = await db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.ticketId, ticketID),
                isNull(agentTurn.changeId),
                inArray(agentTurn.state, ["pending", "dispatching", "running"]),
              ),
            );
          if (busy)
            throw new CommandError(
              "conflict",
              "Wait for the Requirements response before implementing.",
            );
          await db
            .update(ticketConversation)
            .set({
              mode: "build",
              version: query`${ticketConversation.version} + 1`,
              updatedAt: query`now()`,
            })
            .where(
              and(eq(ticketConversation.ticketId, ticketID), ne(ticketConversation.mode, "build")),
            );
        }
        async function admitBuild(change: string) {
          const [bootstrap] = await db
            .select({
              commandID: agentTurn.commandId,
              reasoning: query<string | null>`${agentTurn.authority}->>'codingReasoning'`,
            })
            .from(agentTurn)
            .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
            .where(and(eq(agentTurn.changeId, change), eq(changeAgentTurnIntent.bootstrap, true)))
            .orderBy(asc(agentTurn.createdAt))
            .limit(1);
          // A second viewer commissioning already-admitted work does not start a
          // second inference. The original command can still replay its exact input.
          if (!bootstrap || bootstrap.commandID === implementation.commandID)
            await implementation.admitBuild(sql, change);
          else if (
            implementation.codingReasoning &&
            implementation.codingReasoning !== bootstrap.reasoning
          )
            throw new CommandError(
              "conflict",
              "This Change keeps its original reasoning. Start a new Change to choose different reasoning.",
            );
        }
        const existing = await db
          .select({ id: changeTable.id })
          .from(changeTable)
          .where(
            and(
              eq(changeTable.ticketId, ticketID),
              inArray(changeTable.state, ["branch-pending", "starting", "active", "cancelling"]),
            ),
          );
        if (existing[0]) {
          await admitBuild(existing[0].id);
          await db
            .update(implementationOrder)
            .set({
              state: "started",
              changeId: existing[0].id,
              lastError: null,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(implementationOrder.commandId, implementation.commandID),
                eq(implementationOrder.state, "waiting"),
              ),
            );
          return existing[0].id;
        }
        const budget = await codingBudgetIn(sql, ticket.projectID, false);
        if (!budget.allowed)
          throw new CommandError(
            "conflict",
            budget.reason === "accounting-incomplete"
              ? "Coding accounting is incomplete. Check Usage & limits before commissioning work."
              : "The monthly Coding allowance is used. New work waits for a reset or allowance increase.",
          );
        const latestRevision = db
          .select({ id: requirementRevision.id })
          .from(requirementRevision)
          .where(eq(requirementRevision.ticketId, ticketTable.id))
          .orderBy(desc(requirementRevision.ordinal))
          .limit(1);
        const [input] = await db
          .select({
            repositoryURL: project.repositoryUrl,
            defaultBranch: project.defaultBranch,
            approvalID: requirementApproval.id,
          })
          .from(project)
          .innerJoin(ticketTable, eq(ticketTable.projectId, project.id))
          .innerJoin(
            requirementApproval,
            and(
              eq(requirementApproval.ticketId, ticketTable.id),
              eq(requirementApproval.requirementRevisionId, latestRevision),
            ),
          )
          .where(eq(ticketTable.id, ticketID));
        if (!input)
          throw new CommandError("conflict", "Ticket requires an approved Requirement Revision");
        const url = new URL(input.repositoryURL);
        const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
        if (
          !forgeOrigins.has(url.origin) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          parts.length !== 2 ||
          parts.some((part) => !part || part === "." || part === ".." || /[/\\\0]/.test(part))
        )
          throw new Error("Project repository is not on the configured Forge");
        const repository = forgeRepositoryFromURL(input.repositoryURL);
        if (repository.owner !== FACTORY_FORGEJO_OWNER)
          throw new Error("Project Forge owner is not allowed");
        // Resolve the current default only after waiting for the Ticket and checking delivered prerequisites.
        const base = await forge.getDefaultBranch(repository);
        if (base.name !== input.defaultBranch)
          throw new Error("Project default branch does not match Forge");
        const [technicalScope] = await db
          .select({ sourceCommit: technicalDesignRevision.sourceCommit })
          .from(requirementApproval)
          .innerJoin(
            technicalDesignRevision,
            eq(technicalDesignRevision.id, requirementApproval.technicalDesignRevisionId),
          )
          .where(eq(requirementApproval.id, input.approvalID));
        const [order] = await db
          .select({
            commandID: implementationOrder.commandId,
            ticketID: implementationOrder.ticketId,
            userID: implementationOrder.createdBy,
            revisionID: implementationOrder.requirementRevisionId,
            technicalID: implementationOrder.technicalDesignRevisionId,
            reasoning: implementationOrder.codingReasoning,
            sourceSHA: implementationOrder.sourceSha,
            state: implementationOrder.state,
          })
          .from(implementationOrder)
          .where(
            or(
              eq(implementationOrder.commandId, implementation.commandID),
              and(
                eq(implementationOrder.ticketId, ticketID),
                eq(implementationOrder.state, "waiting"),
              ),
            ),
          )
          .for("update");
        if (
          order &&
          (order.commandID !== implementation.commandID ||
            order.ticketID !== ticketID ||
            order.userID !== userID ||
            order.revisionID !== implementation.revisionID ||
            order.technicalID !== (implementation.technicalDesignRevisionID ?? null) ||
            order.reasoning !== (implementation.codingReasoning ?? null))
        )
          throw new CommandError(
            "conflict",
            "This Ticket already has a different implementation order.",
          );
        if (order && order.state !== "waiting")
          throw new CommandError(
            "conflict",
            "This implementation order is no longer waiting. Commission it explicitly again.",
          );
        if (
          technicalScope &&
          technicalScope.sourceCommit !== base.headSha &&
          technicalScope.sourceCommit !== order?.sourceSHA
        )
          throw new CommandError(
            "conflict",
            "The source changed since Technical Planning. Review a new design before implementing.",
          );
        if (implementation.expectedBaseSHA && base.headSha !== implementation.expectedBaseSHA)
          throw new CommandError(
            "conflict",
            "The default branch changed after monitoring diagnosis. Review the incident against the current source.",
          );
        {
          const [blocked] =
            await sql`SELECT prerequisite_id FROM factory.ticket_prerequisites(${ticket.projectID}::uuid,${ticketID}::uuid)
            WHERE NOT delivered LIMIT 1`;
          if (blocked) {
            await db
              .insert(implementationOrder)
              .values({
                commandId: implementation.commandID,
                projectId: ticket.projectID,
                ticketId: ticketID,
                createdBy: userID,
                requirementRevisionId: implementation.revisionID,
                technicalDesignRevisionId: implementation.technicalDesignRevisionID ?? null,
                codingReasoning: implementation.codingReasoning ?? null,
                sourceSha: base.headSha,
              })
              .onConflictDoNothing({ target: implementationOrder.commandId });
            return null;
          }
        }
        await requireDeliveredPrerequisites(sql, ticket.projectID, ticketID);
        const identity = changeIdentity(ticketID, input.approvalID);
        await db.insert(changeTable).values({
          id: identity.changeID,
          projectId: ticket.projectID,
          ticketId: ticketID,
          requirementApprovalId: input.approvalID,
          branchName: identity.branchName,
          baseSha: base.headSha,
          state: "branch-pending",
          createdBy: userID,
        });
        await db.insert(branchCreateOperation).values({
          id: identity.branchOperationID,
          changeId: identity.changeID,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          branchName: identity.branchName,
          startSha: base.headSha,
          idempotencyKey: `change:${identity.changeID}:create-branch`,
        });
        await db
          .update(ticketTable)
          .set({
            state: "in-progress",
            version: query`${ticketTable.version} + 1`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(ticketTable.id, ticketID),
              inArray(ticketTable.state, ["inbox", "backlog", "ready"]),
            ),
          );
        await admitBuild(identity.changeID);
        await db
          .update(implementationOrder)
          .set({
            state: "started",
            changeId: identity.changeID,
            lastError: null,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(implementationOrder.commandId, implementation.commandID),
              eq(implementationOrder.state, "waiting"),
            ),
          );
        return identity.changeID;
      });
      if (!changeID) return null;
      void reconcile(changeID);
      const change = await this.get(changeID);
      if (change?.state === "active") await onReady?.(changeID);
      return change;
    },
    async cancel(changeID: string) {
      const projects = await database.db
        .select({ projectID: changeTable.projectId })
        .from(changeTable)
        .where(eq(changeTable.id, changeID));
      const projectID = projects[0]?.projectID;
      if (!projectID) return this.get(changeID);
      const change = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`runtime:${projectID}`}))`;
        const [row] = await drizzleTransaction(sql)
          .update(changeTable)
          .set({
            state: "cancelling",
            cancelRequestedAt: query`now()`,
            version: query`${changeTable.version} + 1`,
          })
          .where(
            and(
              eq(changeTable.id, changeID),
              inArray(changeTable.state, ["branch-pending", "starting", "active", "failed"]),
            ),
          )
          .returning({ attemptID: changeTable.runtimeAttemptId });
        return row;
      });
      if (!change) return this.get(changeID);
      await database.db
        .update(branchCreateOperation)
        .set({
          state: "cancelled",
          completedAt: query`now()`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(branchCreateOperation.changeId, changeID),
            inArray(branchCreateOperation.state, ["pending", "ambiguous"]),
          ),
        );
      if (change.attemptID) await runtime.stop(change.attemptID);
      observeCancellation(changeID);
      return this.get(changeID);
    },
    async get(changeID: string) {
      const rows: ChangeView[] = await changeViewQuery().where(eq(changeTable.id, changeID));
      return rows[0] ?? null;
    },
    async list(projectID: string | undefined, userID: string) {
      const rows: ChangeView[] = await changeViewQuery()
        .where(
          and(
            projectID === undefined || projectID === null
              ? undefined
              : eq(changeTable.projectId, projectID),
            or(
              exists(
                database.db
                  .select({ userId: administrator.userId })
                  .from(administrator)
                  .where(eq(administrator.userId, userID)),
              ),
              exists(
                database.db
                  .select({ userId: projectMembership.userId })
                  .from(projectMembership)
                  .where(
                    and(
                      eq(projectMembership.projectId, changeTable.projectId),
                      eq(projectMembership.userId, userID),
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(desc(changeTable.createdAt));
      return rows;
    },
    reconcile,
  };
}
