import { changeIdentity } from "../../../../packages/change-domain/src/change";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createForgejoClient,
  ForgeAmbiguousWriteError,
  ForgeConflictError,
  type ForgeRepository,
} from "../../../../packages/forge/src/forge";
import {
  createRequirementRevision,
  type RequirementContent,
} from "../../../../packages/requirement-domain/src/requirement";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import type { RuntimeAttemptView } from "../runtime/types";
import { technicalPlanningOutstandingIn } from "../technical-design/store";
import { codingBudgetIn } from "../usage/policy";
import { requireDeliveredPrerequisites } from "./dependencies";
import type { ChangeView, RequirementApprovalView, RequirementRevisionView } from "./types";

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
  admitBuild(sql: AgentTurnTransaction, changeID: string): Promise<unknown>;
};

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

export function createChangeController(
  database: Database,
  runtime: RuntimeController,
  onReady?: (changeID: string) => Promise<void>,
  protectNewBranch?: (changeID: string) => Promise<void>,
  forgeOverride?: ReturnType<typeof createForgejoClient>,
) {
  const { FACTORY_FORGEJO_API_URL, FACTORY_FORGEJO_TOKEN, FACTORY_FORGEJO_OWNER } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge =
    forgeOverride ??
    createForgejoClient({
      apiURL: FACTORY_FORGEJO_API_URL,
      token: FACTORY_FORGEJO_TOKEN,
    });
  const running = new Set<string>();
  const cancellationObservers = new Set<string>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();

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
          const rows = await database.client<
            Array<{ state: string; runtimeState: string | null; failure: string | null }>
          >`
            SELECT change.state, attempt.state AS "runtimeState", attempt.failure
            FROM factory.change change
            LEFT JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id
            WHERE change.id = ${changeID}
          `;
          const current = rows[0];
          if (current?.state !== "cancelling") return;
          if (current.runtimeState === null || current.runtimeState === "stopped") {
            await database.client`
              UPDATE factory.change SET state = 'cancelled', cancelled_at = now(), version = version + 1
              WHERE id = ${changeID} AND state = 'cancelling'
            `;
            return;
          }
          if (current.runtimeState === "failed") {
            await database.client`
              UPDATE factory.change SET state = 'failed', failure = ${current.failure ?? "Runtime cleanup failed"},
                version = version + 1 WHERE id = ${changeID} AND state = 'cancelling'
            `;
            return;
          }
          await Bun.sleep(1_000);
        }
        await database.client`
          UPDATE factory.change SET state = 'failed', failure = 'Change cancellation did not settle',
            version = version + 1 WHERE id = ${changeID} AND state = 'cancelling'
        `;
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
        const claimed = await database.client<
          Array<{
            operationID: string;
            owner: string;
            repository: string;
            branch: string;
            startSHA: string;
            attempts: number;
            userID: string;
          }>
        >`
          UPDATE factory.branch_create_operation operation
          SET state = 'executing', attempt_count = attempt_count + 1,
            lease_owner = 'factory-server', lease_generation = lease_generation + 1,
            lease_expires_at = now() + interval '30 seconds', updated_at = now()
          FROM factory.change change
          WHERE operation.change_id = ${changeID}
            AND change.id = operation.change_id
            AND change.state = 'branch-pending'
            AND operation.state IN ('pending', 'ambiguous')
            AND operation.reconcile_after <= now()
            AND (operation.lease_expires_at IS NULL OR operation.lease_expires_at < now())
          RETURNING operation.id AS "operationID", operation.repository_owner AS owner,
            operation.repository_name AS repository, operation.branch_name AS branch,
            operation.start_sha AS "startSHA", operation.attempt_count AS attempts,
            change.created_by AS "userID"
        `;
        const operation = claimed[0];
        if (!operation) return;
        const repository = { owner: operation.owner, name: operation.repository };
        const lock = await database.client.reserve();
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
              await lock`
                UPDATE factory.branch_create_operation SET state = 'ambiguous',
                  lease_owner = NULL, lease_expires_at = NULL,
                  reconcile_after = now() + (${delay} * interval '1 second'),
                  last_error = ${cause.message}, updated_at = now()
                WHERE id = ${operation.operationID} AND state = 'executing'
              `;
              retry(changeID, delay * 1_000);
              return;
            }
            const message = cause instanceof Error ? cause.message : "branch creation failed";
            await lock`BEGIN`;
            try {
              await lock`
                UPDATE factory.branch_create_operation SET state = 'failed', completed_at = now(),
                  lease_owner = NULL, lease_expires_at = NULL, last_error = ${message}, updated_at = now()
                WHERE id = ${operation.operationID} AND state = 'executing'
              `;
              await lock`
                UPDATE factory.change SET state = 'failed', failure = ${message}, version = version + 1
                WHERE id = ${changeID} AND state = 'branch-pending'
              `;
              await lock`COMMIT`;
            } catch (persistenceCause) {
              await lock`ROLLBACK`;
              throw persistenceCause;
            }
            return;
          }
          await lock`BEGIN`;
          try {
            await lock`
              UPDATE factory.branch_create_operation
              SET state = 'succeeded', observed_head_sha = ${branch.headSha}, completed_at = now(),
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now(), last_error = NULL
              WHERE id = ${operation.operationID} AND state = 'executing'
            `;
            await lock`
              UPDATE factory.change SET state = 'active', version = version + 1
              WHERE id = ${changeID} AND state = 'branch-pending'
            `;
            await lock`COMMIT`;
          } catch (cause) {
            await lock`ROLLBACK`;
            await lock`
              UPDATE factory.branch_create_operation SET state = 'ambiguous',
                lease_owner = NULL, lease_expires_at = NULL,
                reconcile_after = now(),
                last_error = ${cause instanceof Error ? cause.message : "branch result persistence failed"},
                updated_at = now()
              WHERE id = ${operation.operationID} AND state = 'executing'
            `;
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
      await database.client`
        UPDATE factory.branch_create_operation SET state = 'ambiguous', lease_owner = NULL,
          lease_expires_at = NULL, reconcile_after = now(), updated_at = now()
        WHERE state IN ('executing', 'ambiguous')
      `;
      const changes = await database.client<
        Array<{ id: string; state: string; runtimeAttemptID: string | null }>
      >`
        SELECT id, state, runtime_attempt_id AS "runtimeAttemptID"
        FROM factory.change
        WHERE state IN ('branch-pending', 'starting', 'cancelling')
      `;
      for (const change of changes) {
        if (change.state === "branch-pending") void reconcile(change.id);
        // Runtime recovery observes the recorded attempt itself. Reopening a
        // Change cannot commission a replacement generation after Stop/failure.
        if (change.state === "starting" && !change.runtimeAttemptID) {
          await database.client`
            UPDATE factory.change SET state = 'active', version = version + 1
            WHERE id = ${change.id} AND state = 'starting' AND runtime_attempt_id IS NULL
          `;
        }
        if (change.state === "cancelling") {
          if (change.runtimeAttemptID) {
            void runtime.stop(change.runtimeAttemptID).catch(() => undefined);
          }
          observeCancellation(change.id);
        }
      }
    },
    async createRevision(ticketID: string, content: RequirementContent, userID: string) {
      const lock = await database.client.reserve();
      await lock`SELECT pg_advisory_lock(hashtext(${`ticket:${ticketID}`}))`;
      try {
        const tickets = await lock<Array<{ id: string; locked: boolean }>>`
          SELECT ticket.id,
            (ticket.trashed_at IS NOT NULL OR ticket.state IN ('cancelled', 'done') OR EXISTS(
              SELECT 1 FROM factory.requirement_approval WHERE ticket_id = ticket.id
            ) OR EXISTS(SELECT 1 FROM factory.change WHERE ticket_id = ticket.id)) AS locked
          FROM factory.ticket ticket WHERE ticket.id = ${ticketID}
        `;
        if (!tickets[0]) throw new CommandError("not-found", "Ticket not found");
        if (tickets[0].locked)
          throw new CommandError(
            "conflict",
            "The approved or completed Ticket specification is immutable",
          );
        const ordinalRows = await lock<Array<{ ordinal: number }>>`
          SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
          FROM factory.requirement_revision WHERE ticket_id = ${ticketID}
        `;
        const revision = createRequirementRevision({
          id: crypto.randomUUID(),
          ticketId: ticketID,
          ordinal: Number(ordinalRows[0]?.ordinal ?? 1),
          content,
        });
        const rows = await lock<RequirementRevisionView[]>`
          INSERT INTO factory.requirement_revision(
            id, ticket_id, ordinal, canonical_content, content_digest, created_by
          ) VALUES (
            ${revision.id}, ${revision.ticketId}, ${revision.ordinal}, ${revision.canonicalContent},
            ${revision.contentDigest}, ${userID}
          ) RETURNING id, ticket_id AS "ticketId", ordinal,
            canonical_content AS "canonicalContent", content_digest AS "contentDigest",
            created_at AS "createdAt"
        `;
        return rows[0];
      } finally {
        await lock`SELECT pg_advisory_unlock(hashtext(${`ticket:${ticketID}`}))`;
        lock.release();
      }
    },
    async approve(ticketID: string, revisionID: string, userID: string) {
      const lock = await database.client.reserve();
      await lock`SELECT pg_advisory_lock(hashtext(${`ticket:${ticketID}`}))`;
      try {
        const [technical] = await lock`
          SELECT id FROM factory.technical_design_revision WHERE ticket_id=${ticketID}
          UNION ALL SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}
            AND input->>'intent'='technical-planning' LIMIT 1`;
        if (technical)
          throw new CommandError(
            "conflict",
            "Use Implement to approve the exact product and technical design together.",
          );
        const latest = await lock<Array<{ id: string }>>`
          SELECT id FROM factory.requirement_revision
          WHERE ticket_id = ${ticketID}
          ORDER BY ordinal DESC LIMIT 1
        `;
        if (latest[0]?.id !== revisionID) {
          throw new Error("Only the latest Requirement Revision can be approved");
        }
        const existing = await lock<RequirementApprovalView[]>`
          SELECT id, ticket_id AS "ticketId", requirement_revision_id AS "requirementRevisionId",
            approved_by AS "approvedBy", approved_at AS "approvedAt"
          FROM factory.requirement_approval WHERE ticket_id = ${ticketID}
        `;
        if (existing[0]) {
          if (existing[0].requirementRevisionId !== revisionID) {
            throw new Error("Ticket already has a different Requirement Approval");
          }
          return existing[0];
        }
        const rows = await lock<RequirementApprovalView[]>`
          INSERT INTO factory.requirement_approval(
            id, ticket_id, requirement_revision_id, approved_by
          ) VALUES (${crypto.randomUUID()}, ${ticketID}, ${revisionID}, ${userID})
          RETURNING id, ticket_id AS "ticketId", requirement_revision_id AS "requirementRevisionId",
            approved_by AS "approvedBy", approved_at AS "approvedAt"
        `;
        return rows[0];
      } finally {
        await lock`SELECT pg_advisory_unlock(hashtext(${`ticket:${ticketID}`}))`;
        lock.release();
      }
    },
    async start(ticketID: string, userID: string, implementation?: ImplementationAdmission) {
      const changeID = await database.client.begin(async (sql) => {
        if (implementation)
          await sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${implementation.commandID}`}))`;
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${ticketID}`}))`;
        const [ticket] = await sql<Array<{ projectID: string; state: string; trashed: boolean }>>`
          SELECT project_id AS "projectID", state, (trashed_at IS NOT NULL OR converted_to_epic_id IS NOT NULL) AS trashed FROM factory.ticket WHERE id = ${ticketID} FOR UPDATE
        `;
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        if (ticket.trashed || ticket.state === "cancelled" || ticket.state === "done")
          throw new CommandError(
            "conflict",
            "Completed or trashed Tickets cannot start implementation",
          );
        if (implementation) {
          const [command] = await sql<
            Array<{ ticketID: string; userID: string; revisionID: string; kind: string }>
          >`
            SELECT ticket_id AS "ticketID", created_by AS "userID", authority->>'requirementRevisionId' AS "revisionID", input->>'kind' AS kind
            FROM factory.agent_turn WHERE command_id = ${implementation.commandID}`;
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
          const [latest] = await sql<
            Array<{ id: string }>
          >`SELECT id FROM factory.requirement_revision
            WHERE ticket_id = ${ticketID} ORDER BY ordinal DESC LIMIT 1`;
          if (latest?.id !== implementation.revisionID)
            throw new CommandError(
              "conflict",
              "The Ticket changed. Review the current requirements before implementing.",
            );
          const [document] = await sql<
            Array<{ revisionID: string | null }>
          >`SELECT requirement_revision_id AS "revisionID"
            FROM factory.ticket_document_revision WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
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
          const [technical] = await sql<{ id: string; requirementRevisionID: string }[]>`
            SELECT id,requirement_revision_id AS "requirementRevisionID" FROM factory.technical_design_revision
            WHERE ticket_id=${ticketID} ORDER BY ordinal DESC LIMIT 1`;
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
          const [approval] = await sql<
            Array<{ revisionID: string; technicalID: string | null }>
          >`SELECT requirement_revision_id AS "revisionID",technical_design_revision_id AS "technicalID"
            FROM factory.requirement_approval WHERE ticket_id = ${ticketID}`;
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
            await sql`INSERT INTO factory.requirement_approval(id, ticket_id, requirement_revision_id, technical_design_revision_id, approved_by)
            VALUES (${crypto.randomUUID()}, ${ticketID}, ${implementation.revisionID}, ${implementation.technicalDesignRevisionID ?? null}, ${userID})`;
          const [busy] = await sql`SELECT id FROM factory.agent_turn WHERE ticket_id = ${ticketID}
            AND change_id IS NULL AND state IN ('pending', 'dispatching', 'running')`;
          if (busy)
            throw new CommandError(
              "conflict",
              "Wait for the Requirements response before implementing.",
            );
          await sql`UPDATE factory.ticket_conversation SET mode = 'build', version = version + 1, updated_at = now()
            WHERE ticket_id = ${ticketID} AND mode <> 'build'`;
        }
        async function admitBuild(change: string) {
          if (!implementation) return;
          const [bootstrap] = await sql<
            Array<{ commandID: string; reasoning: string | null }>
          >`SELECT turn.command_id AS "commandID", turn.authority->>'codingReasoning' AS reasoning
            FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
            WHERE turn.change_id = ${change} AND intent.bootstrap ORDER BY turn.created_at LIMIT 1`;
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
        const existing = await sql<Array<{ id: string }>>`
          SELECT id, state FROM factory.change WHERE ticket_id = ${ticketID}
            AND state IN ('branch-pending', 'starting', 'active', 'cancelling')
        `;
        if (existing[0]) {
          await admitBuild(existing[0].id);
          if (implementation)
            await sql`UPDATE factory.implementation_order SET state='started',change_id=${existing[0].id},last_error=NULL,updated_at=now()
              WHERE command_id=${implementation.commandID} AND state='waiting'`;
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
        if (ticket.state === "cancelled" || ticket.state === "done")
          throw new CommandError(
            "conflict",
            "Completed or cancelled Tickets cannot start implementation",
          );
        if (!implementation) await requireDeliveredPrerequisites(sql, ticket.projectID, ticketID);
        const [input] = await sql<
          Array<{
            repositoryURL: string;
            defaultBranch: string;
            approvalID: string;
          }>
        >`
          SELECT project.repository_url AS "repositoryURL", project.default_branch AS "defaultBranch",
            approval.id AS "approvalID" FROM factory.project project
          JOIN factory.ticket ticket ON ticket.project_id = project.id
          JOIN LATERAL (SELECT id FROM factory.requirement_revision WHERE ticket_id = ticket.id ORDER BY ordinal DESC LIMIT 1) latest ON true
          JOIN factory.requirement_approval approval ON approval.ticket_id = ticket.id AND approval.requirement_revision_id = latest.id
          WHERE ticket.id = ${ticketID}
        `;
        if (!input)
          throw new CommandError("conflict", "Ticket requires an approved Requirement Revision");
        const repository = repositoryFromURL(input.repositoryURL);
        if (new URL(input.repositoryURL).origin !== new URL(FACTORY_FORGEJO_API_URL).origin)
          throw new Error("Project repository is not on the configured Forge");
        if (repository.owner !== FACTORY_FORGEJO_OWNER)
          throw new Error("Project Forge owner is not allowed");
        // Resolve the current default only after waiting for the Ticket and checking delivered prerequisites.
        const base = await forge.getDefaultBranch(repository);
        if (base.name !== input.defaultBranch)
          throw new Error("Project default branch does not match Forge");
        const [technicalScope] = await sql<{ sourceCommit: string }[]>`
          SELECT design.source_commit AS "sourceCommit" FROM factory.requirement_approval approval
          JOIN factory.technical_design_revision design ON design.id=approval.technical_design_revision_id
          WHERE approval.id=${input.approvalID}`;
        const [order] = implementation
          ? await sql<
              {
                commandID: string;
                ticketID: string;
                userID: string;
                revisionID: string;
                technicalID: string | null;
                reasoning: string | null;
                sourceSHA: string;
                state: string;
              }[]
            >`SELECT command_id AS "commandID",ticket_id AS "ticketID",created_by AS "userID",requirement_revision_id AS "revisionID",
              technical_design_revision_id AS "technicalID",coding_reasoning AS reasoning,source_sha AS "sourceSHA",state
              FROM factory.implementation_order WHERE command_id=${implementation.commandID}
                OR (ticket_id=${ticketID} AND state='waiting') FOR UPDATE`
          : [];
        if (
          order &&
          implementation &&
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
        if (implementation?.expectedBaseSHA && base.headSha !== implementation.expectedBaseSHA)
          throw new CommandError(
            "conflict",
            "The default branch changed after monitoring diagnosis. Review the incident against the current source.",
          );
        if (implementation) {
          const [blocked] =
            await sql`SELECT prerequisite_id FROM factory.ticket_prerequisites(${ticket.projectID}::uuid,${ticketID}::uuid)
            WHERE NOT delivered LIMIT 1`;
          if (blocked) {
            await sql`INSERT INTO factory.implementation_order(command_id,project_id,ticket_id,created_by,
              requirement_revision_id,technical_design_revision_id,coding_reasoning,source_sha)
              VALUES(${implementation.commandID},${ticket.projectID},${ticketID},${userID},
                ${implementation.revisionID},${implementation.technicalDesignRevisionID ?? null},
                ${implementation.codingReasoning ?? null},${base.headSha}) ON CONFLICT(command_id) DO NOTHING`;
            return null;
          }
        }
        await requireDeliveredPrerequisites(sql, ticket.projectID, ticketID);
        const identity = changeIdentity(ticketID, input.approvalID);
        await sql`
            INSERT INTO factory.change(
              id, project_id, ticket_id, requirement_approval_id, branch_name, base_sha,
              state, created_by
            ) VALUES (
              ${identity.changeID}, ${ticket.projectID}, ${ticketID}, ${input.approvalID},
              ${identity.branchName}, ${base.headSha}, 'branch-pending', ${userID}
            )
          `;
        await sql`
            INSERT INTO factory.branch_create_operation(
              id, change_id, repository_owner, repository_name, branch_name, start_sha,
              idempotency_key
            ) VALUES (
              ${identity.branchOperationID}, ${identity.changeID}, ${repository.owner},
              ${repository.name}, ${identity.branchName}, ${base.headSha},
              ${`change:${identity.changeID}:create-branch`}
            )
          `;
        await sql`
            UPDATE factory.ticket SET state = 'in-progress', version = version + 1, updated_at = now()
            WHERE id = ${ticketID} AND state IN ('inbox', 'backlog', 'ready')
          `;
        await admitBuild(identity.changeID);
        if (implementation)
          await sql`UPDATE factory.implementation_order SET state='started',change_id=${identity.changeID},last_error=NULL,updated_at=now()
            WHERE command_id=${implementation.commandID} AND state='waiting'`;
        return identity.changeID;
      });
      if (!changeID) return null;
      void reconcile(changeID);
      const change = await this.get(changeID);
      if (change?.state === "active") await onReady?.(changeID);
      return change;
    },
    async cancel(changeID: string) {
      const projects = await database.client<Array<{ projectID: string }>>`
        SELECT project_id AS "projectID" FROM factory.change WHERE id = ${changeID}
      `;
      const projectID = projects[0]?.projectID;
      if (!projectID) return this.get(changeID);
      const lock = await database.client.reserve();
      await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${projectID}`}))`;
      let change: { attemptID: string | null } | undefined;
      try {
        const rows = await lock<Array<{ attemptID: string | null }>>`
          UPDATE factory.change SET state = 'cancelling', cancel_requested_at = now(),
            version = version + 1
          WHERE id = ${changeID} AND state IN ('branch-pending', 'starting', 'active', 'failed')
          RETURNING runtime_attempt_id AS "attemptID"
        `;
        change = rows[0];
      } finally {
        await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${projectID}`}))`;
        lock.release();
      }
      if (!change) return this.get(changeID);
      await database.client`
        UPDATE factory.branch_create_operation SET state = 'cancelled', completed_at = now(),
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE change_id = ${changeID} AND state IN ('pending', 'ambiguous')
      `;
      if (change.attemptID) await runtime.stop(change.attemptID);
      observeCancellation(changeID);
      return this.get(changeID);
    },
    async get(changeID: string) {
      const rows = await database.client<ChangeView[]>`
        SELECT change.id, change.project_id AS "projectId", change.ticket_id AS "ticketId",
          change.requirement_approval_id AS "requirementApprovalId",
          change.branch_name AS "branchName", change.base_sha AS "baseSha", change.state,
          change.version, change.runtime_attempt_id AS "runtimeAttemptId", change.failure,
          operation.state AS "branchState", operation.observed_head_sha AS "branchHeadSha",
          attempt.state AS "runtimeState",
          CASE WHEN failed_verification.id IS NOT NULL THEN 'failed'
            ELSE verification.state::text END AS "verificationState",
          build.state AS "buildTurnState",build.purpose AS "buildTurnPurpose", session.state AS "implementationState",
          approval.approved_at AS "deliveryApprovedAt", merge.state AS "mergeState",
          promotion.state AS "promotionState"
        FROM factory.change change
        JOIN factory.branch_create_operation operation ON operation.change_id = change.id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id
        LEFT JOIN factory.change_agent_session session ON session.change_id = change.id
        LEFT JOIN LATERAL (
          SELECT state,CASE WHEN input->>'kind'='change-review' THEN 'review' ELSE 'implementation' END AS purpose
          FROM factory.agent_turn WHERE change_id = change.id
          ORDER BY created_at DESC, id DESC LIMIT 1
        ) build ON true
        LEFT JOIN LATERAL (
          SELECT * FROM factory.verification WHERE change_id = change.id
            AND commit_sha = (SELECT commit_sha FROM factory.change_commit_operation
              WHERE change_id = change.id AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1)
          ORDER BY created_at DESC LIMIT 1
        ) verification ON true
        LEFT JOIN factory.runtime_attempt failed_verification ON failed_verification.id=verification.runtime_attempt_id
          AND verification.state IN ('pending','runner-starting','running')
          AND (failed_verification.state IN ('failed','cleanup-failed')
            OR (failed_verification.state='stopped' AND failed_verification.failure IS NOT NULL))
        LEFT JOIN LATERAL (
          SELECT * FROM factory.merge_operation WHERE change_id=change.id AND commit_sha=verification.commit_sha
          ORDER BY (state<>'failed') DESC,requested_at DESC,id DESC LIMIT 1
        ) merge ON true
        LEFT JOIN LATERAL (
          SELECT * FROM factory.delivery_approval WHERE verification_id=verification.id
            AND (merge.delivery_approval_id IS NULL OR id=merge.delivery_approval_id)
          ORDER BY approved_at DESC,id DESC LIMIT 1
        ) approval ON true
        LEFT JOIN factory.promotion_operation promotion ON promotion.change_id = change.id
        WHERE change.id = ${changeID}
      `;
      return rows[0] ?? null;
    },
    async list(projectID: string | undefined, userID: string) {
      return database.client<ChangeView[]>`
        SELECT change.id, change.project_id AS "projectId", change.ticket_id AS "ticketId",
          change.requirement_approval_id AS "requirementApprovalId",
          change.branch_name AS "branchName", change.base_sha AS "baseSha", change.state,
          change.version, change.runtime_attempt_id AS "runtimeAttemptId", change.failure,
          operation.state AS "branchState", operation.observed_head_sha AS "branchHeadSha",
          attempt.state AS "runtimeState",
          CASE WHEN failed_verification.id IS NOT NULL THEN 'failed'
            ELSE verification.state::text END AS "verificationState",
          build.state AS "buildTurnState",build.purpose AS "buildTurnPurpose", session.state AS "implementationState",
          approval.approved_at AS "deliveryApprovedAt", merge.state AS "mergeState",
          promotion.state AS "promotionState"
        FROM factory.change change
        JOIN factory.branch_create_operation operation ON operation.change_id = change.id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id = change.runtime_attempt_id
        LEFT JOIN factory.change_agent_session session ON session.change_id = change.id
        LEFT JOIN LATERAL (
          SELECT state,CASE WHEN input->>'kind'='change-review' THEN 'review' ELSE 'implementation' END AS purpose
          FROM factory.agent_turn WHERE change_id = change.id
          ORDER BY created_at DESC, id DESC LIMIT 1
        ) build ON true
        LEFT JOIN LATERAL (
          SELECT * FROM factory.verification WHERE change_id = change.id
            AND commit_sha = (SELECT commit_sha FROM factory.change_commit_operation
              WHERE change_id = change.id AND state = 'succeeded' ORDER BY sequence DESC LIMIT 1)
          ORDER BY created_at DESC LIMIT 1
        ) verification ON true
        LEFT JOIN factory.runtime_attempt failed_verification ON failed_verification.id=verification.runtime_attempt_id
          AND verification.state IN ('pending','runner-starting','running')
          AND (failed_verification.state IN ('failed','cleanup-failed')
            OR (failed_verification.state='stopped' AND failed_verification.failure IS NOT NULL))
        LEFT JOIN LATERAL (
          SELECT * FROM factory.merge_operation WHERE change_id=change.id AND commit_sha=verification.commit_sha
          ORDER BY (state<>'failed') DESC,requested_at DESC,id DESC LIMIT 1
        ) merge ON true
        LEFT JOIN LATERAL (
          SELECT * FROM factory.delivery_approval WHERE verification_id=verification.id
            AND (merge.delivery_approval_id IS NULL OR id=merge.delivery_approval_id)
          ORDER BY approved_at DESC,id DESC LIMIT 1
        ) approval ON true
        LEFT JOIN factory.promotion_operation promotion ON promotion.change_id = change.id
        WHERE (${projectID ?? null}::uuid IS NULL OR change.project_id = ${projectID ?? null})
          AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = ${userID})
            OR EXISTS(SELECT 1 FROM factory.project_membership
              WHERE project_id = change.project_id AND user_id = ${userID}))
        ORDER BY change.created_at DESC
      `;
    },
    reconcile,
  };
}
