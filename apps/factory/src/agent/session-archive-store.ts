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
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  conversationContext,
  operation,
  requirementApproval,
  runtimeAttempt,
  substrateProvision,
  substrateSource,
  ticketConversation,
} from "#db/schema";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { projectMessages } from "./message-projection";
import type { createOpenCodeClient } from "./opencode-adapter";
import { readNativeSessionArchive, saveNativeSessionArchive } from "./session-archive";

const SESSION_ARCHIVE_KIND = "coding.session_archive";
const sessionArchiveKey = (turnID: string) => `${SESSION_ARCHIVE_KIND}:${turnID}`;

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
    const archive = alias(operation, "archive");
    const environmentIntent = alias(operation, "environment_intent");
    await database.db
      .insert(operation)
      .select(
        database.db
          .select({
            id: sql<string>`gen_random_uuid()`.as("id"),
            kind: sql<string>`'coding.session_archive'::text`.as("kind"),
            scopeType: sql<string>`'agent_turn'::text`.as("scope_type"),
            scopeId: sql<string>`${agentTurn.id}::text`.as("scope_id"),
            idempotencyKey: sql<string>`'coding.session_archive:' || ${agentTurn.id}::text`.as(
              "idempotency_key",
            ),
            activeKey: sql<null>`NULL::text`.as("active_key"),
            state: sql<string>`'pending'::text`.as("state"),
            payload: sql<Record<string, unknown>>`
        jsonb_build_object(
          'turnId', ${agentTurn.id}::text,
          'runtimeAttemptId', ${changeAgentTurnIntent.runtimeAttemptId}::text,
          'sessionId', ${changeAgentTurnIntent.sessionId},
          'promptId', ${changeAgentTurnIntent.promptId},
          'sourceRefs',
            jsonb_build_object('projectID',${agentTurn.projectId},'workspaceID',${runtimeAttempt.workspaceId},
              'revision',${runtimeAttempt.revision},'requirementApprovalID',${change.requirementApprovalId},
              'branch',${change.branchName},
              'runtimeArtifacts',${substrateProvision.intent}#>>'{configuration,workloadImage}',
              'environment',${environmentIntent.payload}->>'environment','environmentVersion',${environmentIntent.payload}->'version',
              'requirementRevisionID',${requirementApproval.requirementRevisionId})
            || jsonb_build_object(
              'nativeRuntime',jsonb_build_object('engine','substrate','profile',${runtimeAttempt.bindingIntent}->'profile',
                'runtime',${runtimeAttempt.bindingIntent}->'runtime','actorUID',${runtimeAttempt.actorUid},
                'templateUID',${runtimeAttempt.bindingIntent}->'templateUID','templateSHA256',${runtimeAttempt.bindingIntent}->'templateSHA256'),
              'lastConfirmedSource',CASE WHEN ${substrateSource.checkpoint} IS NOT NULL THEN jsonb_build_object(
                'id',${substrateSource.checkpoint}->'id','generation',${substrateSource.checkpoint}->'generation',
                'writerEpoch',${substrateSource.checkpoint}->'writerEpoch','bundleSHA256',${substrateSource.checkpoint}#>'{bundle,sha256}',
                'manifestKey','workspace-source/v1/'||${runtimeAttempt.workspaceId}::text||'/'||(${substrateSource.checkpoint}->>'id')||'/manifest.json',
                'relationship','last-confirmed-generation-not-turn-atomic') ELSE NULL END),
          'attempts', 0,
          'manifestKey', NULL::text,
          'manifestSha256', NULL::text,
          'throughMessageId', NULL::text,
          'producerVersion', NULL::text,
          'summary', NULL::jsonb,
          'retryAfter', now()
        )
      `.as("payload"),
            result: sql<null>`NULL::jsonb`.as("result"),
            error: sql<null>`NULL::text`.as("error"),
            createdBy: sql<null>`NULL::uuid`.as("created_by"),
            leaseOwner: sql<null>`NULL::text`.as("lease_owner"),
            leaseExpiresAt: sql<null>`NULL::timestamptz`.as("lease_expires_at"),
            createdAt: sql<Date>`now()`.as("created_at"),
            updatedAt: sql<Date>`now()`.as("updated_at"),
            completedAt: sql<null>`NULL::timestamptz`.as("completed_at"),
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
            environmentIntent,
            and(
              eq(environmentIntent.kind, "runtime.environment_intent"),
              eq(environmentIntent.scopeType, "runtime_attempt"),
              eq(
                environmentIntent.idempotencyKey,
                sql`'runtime.environment_intent:' || ${runtimeAttempt.id}::text`,
              ),
            ),
          )
          .leftJoin(
            substrateProvision,
            and(
              eq(substrateProvision.ownerId, runtimeAttempt.workspaceId),
              eq(substrateProvision.kind, "workspace"),
              eq(substrateProvision.generation, runtimeAttempt.generation),
            ),
          )
          .leftJoin(substrateSource, eq(substrateSource.workspaceId, runtimeAttempt.workspaceId))
          .where(
            and(
              eq(agentTurn.state, "completed"),
              isNotNull(runtimeAttempt.atespace),
              notExists(
                database.db
                  .select({ id: archive.id })
                  .from(archive)
                  .where(
                    eq(
                      archive.idempotencyKey,
                      sql`'coding.session_archive:' || ${agentTurn.id}::text`,
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(agentTurn.createdAt), asc(agentTurn.id))
          .limit(16),
      )
      .onConflictDoNothing({ target: operation.idempotencyKey });
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
          turnID: operation.scopeId,
          runtimeAttemptID: sql<string>`${operation.payload}->>'runtimeAttemptId'`,
          sessionID: sql<string>`${operation.payload}->>'sessionId'`,
          promptID: sql<string>`${operation.payload}->>'promptId'`,
          source: sql<Record<string, unknown>>`${operation.payload}->'sourceRefs'`,
        })
        .from(operation)
        .innerJoin(
          runtimeAttempt,
          eq(runtimeAttempt.id, sql`(${operation.payload}->>'runtimeAttemptId')::uuid`),
        )
        .where(
          and(
            eq(operation.kind, SESSION_ARCHIVE_KIND),
            eq(operation.scopeType, "agent_turn"),
            ne(operation.state, "saved"),
            lte(sql`(${operation.payload}->>'retryAfter')::timestamptz`, sql`now()`),
            eq(runtimeAttempt.state, "ready"),
          ),
        )
        .orderBy(asc(operation.createdAt), asc(operation.scopeId))
        .limit(4);
      for (const checkpoint of pending) {
        const key = sessionArchiveKey(checkpoint.turnID);
        await db
          .update(operation)
          .set({
            payload: sql`${operation.payload} || jsonb_build_object(
              'attempts', COALESCE((${operation.payload}->>'attempts')::integer, 0) + 1,
              'retryAfter', now() + interval '1 minute'
            )`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(operation.idempotencyKey, key), ne(operation.state, "saved")));
        try {
          const saved = await saveNativeSessionArchive(
            client(checkpoint.runtimeAttemptID),
            objects,
            checkpoint,
            checkpoint.source,
          );
          await db
            .update(operation)
            .set({
              state: "saved",
              error: null,
              completedAt: sql`now()`,
              updatedAt: sql`now()`,
              payload: sql`${operation.payload} || ${JSON.stringify({
                manifestKey: saved.key,
                manifestSha256: saved.manifestSHA256,
                throughMessageId: saved.manifest.checkpoint.throughMessageID,
                producerVersion: saved.manifest.producer.version,
                summary: saved.summary,
              })}::jsonb`,
            })
            .where(and(eq(operation.idempotencyKey, key), ne(operation.state, "saved")));
        } catch {
          // Neither native errors nor object-store errors may leak transcript
          // bytes, credentials or signed URLs into product diagnostics.
          await db
            .update(operation)
            .set({
              state: "failed",
              error:
                "Transcript archive save could not be confirmed; retry pending. Recovery uses the last successfully saved checkpoint.",
              updatedAt: sql`now()`,
              payload: sql`${operation.payload} || jsonb_build_object('retryAfter', now() + interval '1 minute')`,
            })
            .where(and(eq(operation.idempotencyKey, key), ne(operation.state, "saved")));
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
            turnID: operation.scopeId,
            runtimeAttemptID: sql<string>`${operation.payload}->>'runtimeAttemptId'`,
            sessionID: sql<string>`${operation.payload}->>'sessionId'`,
            promptID: sql<string>`${operation.payload}->>'promptId'`,
            source: sql<Record<string, unknown>>`${operation.payload}->'sourceRefs'`,
            // Saved archive/context invariants require these checkpoint fields.
            key: sql<string>`${operation.payload}->>'manifestKey'`,
            sha256: sql<string>`${operation.payload}->>'manifestSha256'`,
            throughMessageID: sql<string>`${operation.payload}->>'throughMessageId'`,
            changeID: sql<string>`${agentTurn.changeId}`,
            contextID: sql<string | null>`${agentTurn.input}->>'contextId'`,
          })
          .from(operation)
          .innerJoin(
            agentTurn,
            and(
              eq(operation.kind, SESSION_ARCHIVE_KIND),
              eq(operation.scopeType, "agent_turn"),
              sql`${agentTurn.id}::text = ${operation.scopeId}`,
              eq(agentTurn.state, "completed"),
            ),
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
                  sql`${operation.payload}->>'sessionId' = ${conversationContext.nativeSessionId}`,
                  sql`${operation.payload}->>'sessionId' = ${conversationContext.archivedSession}->>'opencode_session_id'`,
                  sql`(${operation.payload}->>'runtimeAttemptId')::uuid = (${conversationContext.archivedSession}->>'runtime_attempt_id')::uuid`,
                ),
              )
              .where(
                and(
                  eq(operation.kind, SESSION_ARCHIVE_KIND),
                  eq(operation.scopeType, "agent_turn"),
                  eq(operation.state, "saved"),
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
                eq(operation.kind, SESSION_ARCHIVE_KIND),
                eq(operation.scopeType, "agent_turn"),
                eq(operation.idempotencyKey, sessionArchiveKey(target.turnID)),
                eq(operation.state, "saved"),
                sql`(${operation.payload}->>'runtimeAttemptId')::uuid = ${target.runtimeAttemptID}::uuid`,
                sql`(${operation.payload}->>'runtimeAttemptId')::uuid = ${changeAgentSession.runtimeAttemptId}`,
                sql`${operation.payload}->>'sessionId' = ${target.sessionID}`,
                sql`${operation.payload}->>'sessionId' = ${changeAgentSession.opencodeSessionId}`,
                sql`${operation.payload}->>'sessionId' = COALESCE(${changeAgentSession.implementationSessionId},${changeAgentSession.opencodeSessionId})`,
                sql`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM ${ticketConversation.activeCodingContextId}::text`,
                or(
                  isNull(ticketConversation.activeCodingContextId),
                  and(
                    eq(conversationContext.kind, "coding"),
                    eq(conversationContext.changeId, change.id),
                    eq(conversationContext.conversationId, ticketConversation.id),
                    sql`${conversationContext.nativeSessionId} = ${operation.payload}->>'sessionId'`,
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
          turnID: operation.scopeId,
          state: sql<"pending" | "failed" | "saved">`${operation.state}`,
          attempts: sql<number>`(${operation.payload}->>'attempts')::integer`,
          lastError: operation.error,
        })
        .from(operation)
        .innerJoin(agentTurn, sql`${agentTurn.id}::text = ${operation.scopeId}`)
        .where(
          and(
            eq(operation.kind, SESSION_ARCHIVE_KIND),
            eq(operation.scopeType, "agent_turn"),
            eq(agentTurn.changeId, changeID),
          ),
        )
        .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
        .limit(1);
      const [checkpoint] = await database.db
        .select({
          turnID: operation.scopeId,
          sessionID: sql<string>`${operation.payload}->>'sessionId'`,
          runtimeAttemptID: sql<string>`${operation.payload}->>'runtimeAttemptId'`,
          savedAt: sql<string>`${operation.completedAt}::text`,
          throughMessageID: sql<string>`${operation.payload}->>'throughMessageId'`,
        })
        .from(operation)
        .innerJoin(agentTurn, sql`${agentTurn.id}::text = ${operation.scopeId}`)
        .where(
          and(
            eq(operation.kind, SESSION_ARCHIVE_KIND),
            eq(operation.scopeType, "agent_turn"),
            eq(agentTurn.changeId, changeID),
            eq(operation.state, "saved"),
          ),
        )
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
