import { and, eq, sql as expression, gt, inArray, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { candidateReviewPermissions } from "#conversation-domain/candidate-review";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  candidateReview,
  changeAgentSession,
  changeAgentTurnIntent,
  change as changeTable,
} from "#db/schema";
import { CommandError } from "../command-error";
import type { AgentActivity, AgentTurnStore, Database } from "./controller-types";
import { bounded, readableError } from "./native-errors";
import {
  type AgentIntent,
  assertOpenCodeSessionMatches,
  type OpenCodeClient,
  type OpenCodeLocation,
  recordLegacySkillOperationsIn,
} from "./turn-lifecycle";
import type { AgentTurnRecord } from "./turn-record";

export async function prepareTurnSession(
  database: Database,
  params: {
    turnID: string;
    ownerToken: string;
    changeID: string;
    attemptID: string;
    userID: string;
    intent: AgentIntent;
    isReview: boolean;
  },
): Promise<boolean> {
  const { turnID, ownerToken, changeID, attemptID, userID, intent, isReview } = params;
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const active = await db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.id, turnID),
          eq(agentTurn.state, "pending"),
          eq(agentTurn.ownerToken, ownerToken),
          gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
        ),
      )
      .for("update");
    if (!active[0]) return false;
    await db
      .update(changeAgentTurnIntent)
      .set({ runtimeAttemptId: attemptID })
      .where(
        and(
          eq(changeAgentTurnIntent.turnId, turnID),
          isNull(changeAgentTurnIntent.runtimeAttemptId),
        ),
      );
    const implementationSessionID = isReview ? null : intent.sessionID;
    await db
      .insert(changeAgentSession)
      .values({
        changeId: changeID,
        runtimeAttemptId: attemptID,
        opencodeSessionId: intent.sessionID,
        state: "starting",
        createdBy: userID,
        activeTurnId: turnID,
        implementationSessionId: implementationSessionID,
      })
      .onConflictDoUpdate({
        target: changeAgentSession.changeId,
        set: {
          runtimeAttemptId: attemptID,
          implementationSessionId: expression`COALESCE(${implementationSessionID}::text,${changeAgentSession.implementationSessionId},${changeAgentSession.opencodeSessionId})`,
          implementationSessionConfirmedAt: expression`COALESCE(${changeAgentSession.implementationSessionConfirmedAt},
            CASE WHEN ${changeAgentSession.implementationSessionId} IS NULL THEN ${changeAgentSession.nativeSessionConfirmedAt} END)`,
          nativeSessionConfirmedAt: expression`CASE WHEN ${changeAgentSession.opencodeSessionId} IS NOT DISTINCT FROM ${intent.sessionID}::text
            THEN ${changeAgentSession.nativeSessionConfirmedAt} END`,
          opencodeSessionId: intent.sessionID,
          state: "starting",
          activeTurnId: turnID,
          activeInboxId: null,
          lastError: null,
          updatedAt: expression`now()`,
        },
      });
    return true;
  });
}

export async function openOrCreateTurnSession(params: {
  client: OpenCodeClient;
  intent: AgentIntent;
  location: OpenCodeLocation;
  modelID: string;
  isReview: boolean;
  skillRevisionIDs: readonly string[];
}): Promise<void> {
  const { client, intent, location, modelID, isReview, skillRevisionIDs } = params;
  const session = intent.bootstrap
    ? await client.session.create({
        id: intent.sessionID,
        title: intent.title,
        location,
        model: { providerID: "factory", id: modelID },
        permissions: isReview
          ? candidateReviewPermissions
          : [
              { action: "*", resource: "*", effect: "allow" },
              ...(intent.skillManifest !== null
                ? [
                    { action: "skill", resource: "*", effect: "deny" as const },
                    ...skillRevisionIDs.map((id) => ({
                      action: "skill",
                      resource: `factory-${id}`,
                      effect: "allow" as const,
                    })),
                  ]
                : []),
            ],
      })
    : await client.session.get({ sessionID: intent.sessionID });
  assertOpenCodeSessionMatches(
    session,
    { sessionID: intent.sessionID, directory: location.directory, modelID },
    "The retained OpenCode session does not match its recorded configuration",
  );
}

export async function markTurnSessionRunning(
  turns: AgentTurnStore,
  params: {
    turnID: string;
    ownerToken: string;
    changeID: string;
    intent: AgentIntent;
    skillRevisionIDs: readonly string[];
    reviewID: string | undefined;
  },
): Promise<boolean> {
  const { turnID, ownerToken, changeID, intent, skillRevisionIDs, reviewID } = params;
  return turns.markRunning(turnID, ownerToken, async (sql) => {
    await recordLegacySkillOperationsIn(sql, turnID, intent, skillRevisionIDs);
    const db = drizzleTransaction(sql);
    const rows = await db
      .update(changeAgentSession)
      .set({
        state: "working",
        activeInboxId: intent.promptID,
        lastError: null,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(changeAgentSession.changeId, changeID),
          eq(changeAgentSession.state, "starting"),
          eq(changeAgentSession.activeTurnId, turnID),
        ),
      )
      .returning({ id: changeAgentSession.changeId });
    if (!rows[0])
      throw new CommandError("conflict", "Build ownership changed before recording dispatch");
    if (reviewID)
      await db
        .update(candidateReview)
        .set({ state: "running" })
        .where(
          and(
            eq(candidateReview.id, reviewID),
            eq(candidateReview.turnId, turnID),
            eq(candidateReview.state, "pending"),
          ),
        );
  });
}

export async function settleDispatchFailure(
  database: Database,
  turns: AgentTurnStore,
  activity: Pick<AgentActivity, "isClosed">,
  params: {
    turnID: string;
    owned: AgentTurnRecord | null;
    dispatched: boolean;
    startupRejected: boolean;
    cause: unknown;
  },
): Promise<void> {
  const { turnID, owned, dispatched, startupRejected, cause } = params;
  if (activity.isClosed()) return;
  if (!owned?.ownerToken || !("changeId" in owned.command)) return;
  const summary = bounded(readableError(cause), 2_000);
  let changed = dispatched
    ? await turns.settle(turnID, owned.ownerToken, "uncertain", summary)
    : await turns.failPending(turnID, owned.ownerToken, summary);
  if (!changed && startupRejected)
    changed = await turns.failUnboundStartup(turnID, owned.ownerToken, summary);
  if (!changed) return;
  // A pre-dispatch failure never reaches the review tools or native
  // finish path. Settle only this still-current, unreported review.
  if (!dispatched && owned.authority.mode === "build" && owned.authority.review) {
    const superseding = alias(candidateReview, "superseding_review");
    await database.db
      .update(candidateReview)
      .set({ state: "incomplete", completedAt: expression`now()` })
      .from(changeTable)
      .where(
        and(
          eq(candidateReview.id, owned.authority.review.reviewId),
          eq(candidateReview.turnId, turnID),
          eq(candidateReview.changeId, changeTable.id),
          eq(changeTable.id, owned.command.changeId),
          inArray(candidateReview.state, ["pending", "running"]),
          isNull(candidateReview.result),
          isNull(candidateReview.completedAt),
          isNull(changeTable.cancelRequestedAt),
          inArray(changeTable.state, ["starting", "active", "failed"]),
          notExists(
            database.db
              .select({ id: superseding.id })
              .from(superseding)
              .where(eq(superseding.supersedesId, candidateReview.id)),
          ),
        ),
      );
  }
  await database.db
    .update(changeAgentSession)
    .set({
      state: "failed",
      lastError: dispatched
        ? `Execution outcome uncertain. Stop or resolve this turn before new Build work. ${summary}`
        : summary,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(changeAgentSession.activeTurnId, turnID),
        inArray(changeAgentSession.state, ["starting", "working"]),
      ),
    );
}
