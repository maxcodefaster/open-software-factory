import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  conversationContext,
  requirementApproval,
  runtimeAttempt,
  runtimeEnvironmentIntent,
  sessionArchive,
  substrateBinding,
  substrateSource,
  substrateWorkspace,
  ticketConversation,
} from "../../../../packages/db/src/schema";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { projectMessages } from "./message-projection";
import type { createOpenCodeClient } from "./opencode-adapter";
import { readNativeSessionArchive, saveNativeSessionArchive } from "./session-archive";

type Database = ReturnType<typeof createDatabase>;
type Pending = {
  turnID: string;
  runtimeAttemptID: string;
  sessionID: string;
  promptID: string;
  source: Record<string, unknown>;
};
type CurrentTranscript = {
  changeID: string;
  turnID: string;
  runtimeAttemptID: string;
  sessionID: string;
};

export function createSessionArchives(
  database: Database,
  client: (attemptID: string) => ReturnType<typeof createOpenCodeClient>,
  objects: PrivateObjects = createPrivateObjects(),
) {
  let saving: Promise<void> | undefined;
  async function enqueue() {
    // Derive identity and approved Source references from authoritative storage,
    // not caller supplied values. This is read-only with respect to execution.
    const archive = alias(sessionArchive, "archive");
    await database.db
      .insert(sessionArchive)
      .select(
        database.db
          .select({
            turnId: agentTurn.id,
            runtimeAttemptId: sql<string>`${changeAgentTurnIntent.runtimeAttemptId}`.as(
              "runtime_attempt_id",
            ),
            sessionId: changeAgentTurnIntent.sessionId,
            promptId: changeAgentTurnIntent.promptId,
            sourceRefs: sql<Record<string, unknown>>`
        jsonb_build_object('projectID',${agentTurn.projectId},'workspaceID',${runtimeAttempt.workspaceId},
          'revision',${runtimeAttempt.revision},'requirementApprovalID',${change.requirementApprovalId},
          'branch',${change.branchName},
          'runtimeArtifacts',${substrateWorkspace.intent}#>>'{configuration,workloadImage}',
          'environment',${runtimeEnvironmentIntent.environment},'environmentVersion',${runtimeEnvironmentIntent.version},
          'requirementRevisionID',${requirementApproval.requirementRevisionId})
        || jsonb_build_object(
          'nativeRuntime',jsonb_build_object('engine','substrate','profile',${substrateBinding.intent}->'profile',
            'runtime',${substrateBinding.intent}->'runtime','actorUID',${substrateBinding.actorUid},
            'templateUID',${substrateBinding.intent}->'templateUID','templateSHA256',${substrateBinding.intent}->'templateSHA256'),
          'lastConfirmedSource',CASE WHEN ${substrateSource.checkpoint} IS NOT NULL THEN jsonb_build_object(
            'id',${substrateSource.checkpoint}->'id','generation',${substrateSource.checkpoint}->'generation',
            'writerEpoch',${substrateSource.checkpoint}->'writerEpoch','bundleSHA256',${substrateSource.checkpoint}#>'{bundle,sha256}',
            'manifestKey','workspace-source/v1/'||${runtimeAttempt.workspaceId}::text||'/'||(${substrateSource.checkpoint}->>'id')||'/manifest.json',
            'relationship','last-confirmed-generation-not-turn-atomic') ELSE NULL END)
      `.as("source_refs"),
            state: sql<string>`'pending'::text`.as("state"),
            attempts: sql<number>`0::integer`.as("attempts"),
            manifestKey: sql<null>`NULL::text`.as("manifest_key"),
            manifestSha256: sql<null>`NULL::text`.as("manifest_sha256"),
            throughMessageId: sql<null>`NULL::text`.as("through_message_id"),
            producerVersion: sql<null>`NULL::text`.as("producer_version"),
            summary: sql<null>`NULL::jsonb`.as("summary"),
            lastError: sql<null>`NULL::text`.as("last_error"),
            retryAfter: sql<Date>`now()`.as("retry_after"),
            savedAt: sql<null>`NULL::timestamptz`.as("saved_at"),
            createdAt: sql<Date>`now()`.as("created_at"),
          })
          .from(agentTurn)
          .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
          .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentTurnIntent.runtimeAttemptId))
          .innerJoin(
            change,
            and(eq(change.id, agentTurn.changeId), eq(change.id, runtimeAttempt.changeId)),
          )
          .innerJoin(requirementApproval, eq(requirementApproval.id, change.requirementApprovalId))
          .leftJoin(
            runtimeEnvironmentIntent,
            eq(runtimeEnvironmentIntent.runtimeAttemptId, runtimeAttempt.id),
          )
          .innerJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id))
          .leftJoin(
            substrateWorkspace,
            and(
              eq(substrateWorkspace.workspaceId, runtimeAttempt.workspaceId),
              eq(substrateWorkspace.generation, runtimeAttempt.generation),
            ),
          )
          .leftJoin(substrateSource, eq(substrateSource.workspaceId, runtimeAttempt.workspaceId))
          .where(
            and(
              eq(agentTurn.state, "completed"),
              notExists(
                database.db
                  .select({ turnId: archive.turnId })
                  .from(archive)
                  .where(eq(archive.turnId, agentTurn.id)),
              ),
            ),
          )
          .orderBy(asc(agentTurn.createdAt), asc(agentTurn.id))
          .limit(16),
      )
      .onConflictDoNothing();
  }
  async function save() {
    const connection = database.coordination();
    try {
      const [lock] = await connection<
        { granted: boolean }[]
      >`SELECT pg_try_advisory_lock(hashtext('factory-session-archive-save')) AS granted`;
      if (!lock?.granted) return;
      await enqueue();
      const db = drizzleTransaction(connection);
      const pending: Pending[] = await db
        .select({
          turnID: sessionArchive.turnId,
          runtimeAttemptID: sessionArchive.runtimeAttemptId,
          sessionID: sessionArchive.sessionId,
          promptID: sessionArchive.promptId,
          source: sql<Record<string, unknown>>`${sessionArchive.sourceRefs}`,
        })
        .from(sessionArchive)
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, sessionArchive.runtimeAttemptId))
        .where(
          and(
            ne(sessionArchive.state, "saved"),
            lte(sessionArchive.retryAfter, sql`now()`),
            eq(runtimeAttempt.state, "ready"),
          ),
        )
        .orderBy(asc(sessionArchive.createdAt), asc(sessionArchive.turnId))
        .limit(4);
      for (const checkpoint of pending) {
        await db
          .update(sessionArchive)
          .set({
            attempts: sql`${sessionArchive.attempts}+1`,
            retryAfter: sql`now()+interval '1 minute'`,
          })
          .where(
            and(eq(sessionArchive.turnId, checkpoint.turnID), ne(sessionArchive.state, "saved")),
          );
        try {
          const saved = await saveNativeSessionArchive(
            client(checkpoint.runtimeAttemptID),
            objects,
            checkpoint,
            checkpoint.source,
          );
          await db
            .update(sessionArchive)
            .set({
              state: "saved",
              manifestKey: saved.key,
              manifestSha256: saved.manifestSHA256,
              throughMessageId: saved.manifest.checkpoint.throughMessageID,
              producerVersion: saved.manifest.producer.version,
              summary: saved.summary,
              lastError: null,
              savedAt: sql`now()`,
            })
            .where(
              and(eq(sessionArchive.turnId, checkpoint.turnID), ne(sessionArchive.state, "saved")),
            );
        } catch {
          // Neither native errors nor object-store errors may leak transcript
          // bytes, credentials or signed URLs into product diagnostics.
          await db
            .update(sessionArchive)
            .set({
              state: "failed",
              retryAfter: sql`now()+interval '1 minute'`,
              lastError:
                "Transcript archive save could not be confirmed; retry pending. Recovery uses the last successfully saved checkpoint.",
            })
            .where(
              and(eq(sessionArchive.turnId, checkpoint.turnID), ne(sessionArchive.state, "saved")),
            );
          console.warn("[factory] native transcript archive save failed", {
            turnID: checkpoint.turnID,
          });
        }
      }
    } finally {
      await connection.end({ timeout: 1 });
    }
  }
  return {
    // The caller authorizes the Change or selects an exact archived context.
    // Current reads require the terminal Turn still selected by that context
    // and its original confirmed Session/runtime. No wake, native request or import.
    // A previous checkpoint cannot stand in for the captured terminal turn, and
    // separate implementation/review Sessions still require their own history.
    async retainedMessages(target: string | CurrentTranscript) {
      const checkpoint = async () => {
        const query = database.db
          .select({
            turnID: sessionArchive.turnId,
            runtimeAttemptID: sessionArchive.runtimeAttemptId,
            sessionID: sessionArchive.sessionId,
            promptID: sessionArchive.promptId,
            source: sql<Record<string, unknown>>`${sessionArchive.sourceRefs}`,
            // Saved archive/context invariants require these checkpoint fields.
            key: sql<string>`${sessionArchive.manifestKey}`,
            sha256: sql<string>`${sessionArchive.manifestSha256}`,
            throughMessageID: sql<string>`${sessionArchive.throughMessageId}`,
            changeID: sql<string>`${agentTurn.changeId}`,
            contextID: sql<string | null>`${agentTurn.input}->>'contextId'`,
          })
          .from(sessionArchive)
          .innerJoin(
            agentTurn,
            and(eq(agentTurn.id, sessionArchive.turnId), eq(agentTurn.state, "completed")),
          );
        if (typeof target === "string")
          return (
            await query
              .innerJoin(
                conversationContext,
                and(
                  eq(agentTurn.changeId, conversationContext.changeId),
                  sql`${agentTurn.id}=(${conversationContext.archivedSession}->>'active_turn_id')::uuid`,
                  sql`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM CASE WHEN ${conversationContext.original}
              THEN NULL ELSE ${conversationContext.id}::text END`,
                  eq(sessionArchive.sessionId, conversationContext.nativeSessionId),
                  sql`${sessionArchive.sessionId}=${conversationContext.archivedSession}->>'opencode_session_id'`,
                  sql`${sessionArchive.runtimeAttemptId}=(${conversationContext.archivedSession}->>'runtime_attempt_id')::uuid`,
                ),
              )
              .where(
                and(
                  eq(sessionArchive.state, "saved"),
                  eq(conversationContext.id, target),
                  eq(conversationContext.kind, "coding"),
                  isNotNull(conversationContext.archivedSession),
                ),
              )
          )[0];
        const newer = alias(agentTurn, "newer");
        return (
          await query
            .innerJoin(change, eq(change.id, agentTurn.changeId))
            .innerJoin(changeAgentSession, eq(changeAgentSession.changeId, change.id))
            .innerJoin(
              ticketConversation,
              and(
                eq(ticketConversation.ticketId, change.ticketId),
                eq(ticketConversation.projectId, change.projectId),
              ),
            )
            .leftJoin(
              conversationContext,
              eq(conversationContext.id, ticketConversation.activeCodingContextId),
            )
            .where(
              and(
                eq(change.id, target.changeID),
                eq(agentTurn.projectId, change.projectId),
                eq(agentTurn.id, target.turnID),
                eq(changeAgentSession.activeTurnId, agentTurn.id),
                inArray(changeAgentSession.state, ["waiting", "committed", "stopped", "failed"]),
                isNotNull(changeAgentSession.nativeSessionConfirmedAt),
                eq(sessionArchive.state, "saved"),
                eq(sessionArchive.runtimeAttemptId, target.runtimeAttemptID),
                eq(sessionArchive.runtimeAttemptId, changeAgentSession.runtimeAttemptId),
                eq(sessionArchive.sessionId, target.sessionID),
                eq(sessionArchive.sessionId, changeAgentSession.opencodeSessionId),
                sql`${sessionArchive.sessionId}=COALESCE(${changeAgentSession.implementationSessionId},${changeAgentSession.opencodeSessionId})`,
                sql`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM ${ticketConversation.activeCodingContextId}::text`,
                or(
                  isNull(ticketConversation.activeCodingContextId),
                  and(
                    eq(conversationContext.kind, "coding"),
                    eq(conversationContext.changeId, change.id),
                    eq(conversationContext.conversationId, ticketConversation.id),
                    eq(conversationContext.nativeSessionId, sessionArchive.sessionId),
                    isNull(conversationContext.archivedSession),
                  ),
                ),
                notExists(
                  database.db
                    .select({ id: newer.id })
                    .from(newer)
                    .where(
                      and(
                        eq(newer.changeId, change.id),
                        sql`${newer.input}->>'contextId' IS NOT DISTINCT FROM ${agentTurn.input}->>'contextId'`,
                        or(
                          gt(newer.createdAt, agentTurn.createdAt),
                          and(eq(newer.createdAt, agentTurn.createdAt), gt(newer.id, agentTurn.id)),
                        ),
                      ),
                    ),
                ),
              ),
            )
        )[0];
      };
      const saved = await checkpoint();
      if (!saved) return;
      const { manifest, native } = await readNativeSessionArchive(objects, saved.key, saved.sha256);
      if (
        !isDeepStrictEqual(manifest.checkpoint, {
          turnID: saved.turnID,
          runtimeAttemptID: saved.runtimeAttemptID,
          sessionID: saved.sessionID,
          promptID: saved.promptID,
          throughMessageID: saved.throughMessageID,
        }) ||
        !isDeepStrictEqual(manifest.source, saved.source)
      )
        throw new Error("Native transcript checkpoint differs from its retained context");
      const inputs = await database.db
        .select({
          promptID: changeAgentTurnIntent.promptId,
          text: sql<string | null>`CASE WHEN ${agentTurn.input}->>'kind'='change-start'
          THEN NULL ELSE ${agentTurn.input}->>'text' END`,
        })
        .from(changeAgentTurnIntent)
        .innerJoin(agentTurn, eq(agentTurn.id, changeAgentTurnIntent.turnId))
        .where(
          and(
            eq(changeAgentTurnIntent.changeId, saved.changeID),
            eq(changeAgentTurnIntent.sessionId, saved.sessionID),
            sql`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM ${saved.contextID}`,
          ),
        );
      // Object reads release database connections. A context/Turn change during
      // that read must not display the old checkpoint as current activity.
      if (typeof target !== "string" && !(await checkpoint())) return;
      return {
        messages: projectMessages(
          { data: native.messages.toReversed() },
          new Map(inputs.map((input) => [input.promptID, input.text])),
        ),
        messagesAvailable: true,
      };
    },
    // All failures, including unavailable PostgreSQL, remain independent of
    // authoritative turn settlement and external product mutation persistence.
    savePending() {
      saving ??= save()
        .catch(() => {
          console.warn("[factory] transcript archive reconciliation unavailable");
        })
        .finally(() => {
          saving = undefined;
        });
      return saving;
    },
    async status(changeID: string) {
      const latest = await database.db
        .select({
          turnID: sessionArchive.turnId,
          state: sessionArchive.state,
          attempts: sessionArchive.attempts,
          lastError: sessionArchive.lastError,
        })
        .from(sessionArchive)
        .innerJoin(agentTurn, eq(agentTurn.id, sessionArchive.turnId))
        .where(eq(agentTurn.changeId, changeID))
        .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
        .limit(1);
      const [checkpoint] = await database.db
        .select({
          turnID: sessionArchive.turnId,
          sessionID: sessionArchive.sessionId,
          runtimeAttemptID: sessionArchive.runtimeAttemptId,
          savedAt: sql<string>`${sessionArchive.savedAt}::text`,
          throughMessageID: sql<string>`${sessionArchive.throughMessageId}`,
        })
        .from(sessionArchive)
        .innerJoin(agentTurn, eq(agentTurn.id, sessionArchive.turnId))
        .where(and(eq(agentTurn.changeId, changeID), eq(sessionArchive.state, "saved")))
        .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
        .limit(1);
      return {
        latest: latest[0] ?? null,
        lastSaved: checkpoint ?? null,
        recovery:
          "Last successfully saved completed-turn transcript only; unsaved work, external files and execution state may be unavailable.",
      };
    },
  };
}
