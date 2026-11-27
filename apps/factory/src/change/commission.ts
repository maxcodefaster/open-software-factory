import { and, desc, eq, inArray, isNotNull, or, sql as query } from "drizzle-orm";
import { changeIdentity } from "#change-domain/change";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  change as changeTable,
  operation as operationTable,
  project,
  requirementApproval,
  requirementRevision,
  technicalDesignRevision,
  ticket as ticketTable,
} from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import { forgeRepositoryFromURL } from "#forge/repository";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { codingBudgetIn } from "../usage/api";
import { requireDeliveredPrerequisites } from "./dependencies";
import {
  admitChangeBuildIn,
  ensureImplementationApprovalIn,
  type ImplementationAdmission,
} from "./requirement-approval";

type Database = ReturnType<typeof createDatabase>;
type TransactionDB = ReturnType<typeof drizzleTransaction>;

export type ForgeCommissionConfig = {
  forge: ReturnType<typeof createForgejoClient>;
  forgeOrigins: ReadonlySet<string>;
  forgeOwner: string;
};

function validateForgeRepository(
  repositoryURL: string,
  forgeOrigins: ReadonlySet<string>,
  forgeOwner: string,
) {
  const url = new URL(repositoryURL);
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
  const repository = forgeRepositoryFromURL(repositoryURL);
  if (repository.owner !== forgeOwner) throw new Error("Project Forge owner is not allowed");
  return repository;
}

async function markImplementationOrderStartedIn(
  db: TransactionDB,
  commandID: string,
  changeID: string,
) {
  await db
    .update(operationTable)
    .set({
      state: "started",
      activeKey: null,
      completedAt: query`now()`,
      error: null,
      payload: query`${operationTable.payload} || ${JSON.stringify({ changeId: changeID, lastError: null })}::jsonb`,
      updatedAt: query`now()`,
    })
    .where(
      and(
        eq(operationTable.id, commandID),
        eq(operationTable.kind, "tickets.implementation_order"),
        eq(operationTable.state, "waiting"),
      ),
    );
}

export async function commissionChangeIn(
  database: Database,
  ticketID: string,
  userID: string,
  implementation: ImplementationAdmission,
  forgeConfig: ForgeCommissionConfig,
): Promise<string | null> {
  if (!implementation)
    throw new CommandError(
      "invalid",
      "Use Implement with an exact saved Requirement Revision and command identity.",
    );
  return database.client.begin(async (sql) => {
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
    await ensureImplementationApprovalIn(sql, ticketID, ticket.projectID, userID, implementation);
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
      await admitChangeBuildIn(sql, existing[0].id, implementation);
      await markImplementationOrderStartedIn(db, implementation.commandID, existing[0].id);
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
    const repository = validateForgeRepository(
      input.repositoryURL,
      forgeConfig.forgeOrigins,
      forgeConfig.forgeOwner,
    );
    // Resolve the current default only after waiting for the Ticket and checking delivered prerequisites.
    const base = await forgeConfig.forge.getDefaultBranch(repository);
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
        commandID: operationTable.id,
        ticketID: query<string>`(${operationTable.scopeId})::uuid`,
        userID: operationTable.createdBy,
        revisionID: query<string>`(${operationTable.payload}->>'requirementRevisionId')::uuid`,
        technicalID: query<
          string | null
        >`(${operationTable.payload}->>'technicalDesignRevisionId')::uuid`,
        reasoning: query<string | null>`${operationTable.payload}->>'codingReasoning'`,
        sourceSHA: query<string>`${operationTable.payload}->>'sourceSha'`,
        state: operationTable.state,
      })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, "tickets.implementation_order"),
          or(
            eq(operationTable.id, implementation.commandID),
            and(
              eq(operationTable.scopeType, "ticket"),
              eq(operationTable.scopeId, ticketID),
              eq(operationTable.state, "waiting"),
            ),
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
    const [blocked] =
      await sql`SELECT prerequisite_id FROM factory.ticket_prerequisites(${ticket.projectID}::uuid,${ticketID}::uuid)
      WHERE NOT delivered LIMIT 1`;
    if (blocked) {
      if (!order) {
        await db
          .insert(operationTable)
          .values({
            id: implementation.commandID,
            kind: "tickets.implementation_order",
            scopeType: "ticket",
            scopeId: ticketID,
            idempotencyKey: `tickets.implementation_order:${implementation.commandID}`,
            activeKey: `tickets.implementation_order:${ticketID}`,
            state: "waiting",
            error: null,
            createdBy: userID,
            payload: {
              commandId: implementation.commandID,
              projectId: ticket.projectID,
              ticketId: ticketID,
              createdBy: userID,
              requirementRevisionId: implementation.revisionID,
              technicalDesignRevisionId: implementation.technicalDesignRevisionID ?? null,
              codingReasoning: implementation.codingReasoning ?? null,
              sourceSha: base.headSha,
              changeId: null,
              cancelledBy: null,
              cancelledAt: null,
              lastError: null,
            },
          })
          .onConflictDoNothing({ target: operationTable.idempotencyKey });
      }
      return null;
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
    await db.insert(operationTable).values({
      id: identity.branchOperationID,
      kind: "delivery.branch_create",
      scopeType: "change",
      scopeId: identity.changeID,
      idempotencyKey: `delivery.branch_create:change:${identity.changeID}:create-branch`,
      activeKey: `delivery.branch_create:${identity.changeID}`,
      state: "pending",
      payload: {
        changeId: identity.changeID,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        branchName: identity.branchName,
        startSha: base.headSha,
        attemptCount: 0,
        leaseGeneration: 0,
        reconcileAfter: null,
      },
      createdBy: userID,
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
    await admitChangeBuildIn(sql, identity.changeID, implementation);
    await markImplementationOrderStartedIn(db, implementation.commandID, identity.changeID);
    return identity.changeID;
  });
}
