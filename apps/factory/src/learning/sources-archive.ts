import { and, eq, sql as typedSQL } from "drizzle-orm";
import type { LearningCase } from "#conversation-domain/learning";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  changeAgentTurnIntent,
  operation as operationRecord,
  runtimeAttempt,
  learningCase as savedCase,
} from "#db/schema";
import { CommandError } from "../command-error";
import type { PrivateObjects } from "../storage/objects";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { readNativeToolEvidence } from "./native-tool-evidence";
import type { LearningDatabase } from "./sources-types";

const nativeArchiveGraceMS = 5 * 60_000;

export async function authorizedForCaseIn(
  sql: DatabaseTransaction,
  reviewerId: string,
  snapshot: LearningCase,
) {
  if (!(await learningEnabledIn(sql, snapshot.projectId, snapshot.ownerId))) return false;
  try {
    await learningAuthorityIn(sql, reviewerId, {
      ...snapshot,
      managerOnly: snapshot.activity === "setup",
    });
  } catch (cause) {
    if (cause instanceof CommandError) return false;
    throw cause;
  }
  return true;
}

export type NativeToolEvidenceResolution =
  | { status: "skip" }
  | { status: "ready"; evidence: LearningCase["evidence"][number] };

export async function resolveNativeToolEvidence(
  database: LearningDatabase,
  snapshot: LearningCase,
  nativeTurnID: string,
  reviewerId: string,
  objects: PrivateObjects,
): Promise<NativeToolEvidenceResolution> {
  const admitted = await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    if (!(await authorizedForCaseIn(sql, reviewerId, snapshot))) return null;
    const [existing] = await db
      .select({ id: savedCase.id })
      .from(savedCase)
      .where(eq(savedCase.id, snapshot.id));
    if (existing) return null;
    const [saved] = await db
      .select({
        turnID: typedSQL<string>`(${operationRecord.scopeId})::uuid`,
        runtimeAttemptID: typedSQL<string>`(${operationRecord.payload}->>'runtimeAttemptId')::uuid`,
        sessionID: typedSQL<string>`${operationRecord.payload}->>'sessionId'`,
        promptID: typedSQL<string>`${operationRecord.payload}->>'promptId'`,
        throughMessageID: typedSQL<string | null>`${operationRecord.payload}->>'throughMessageId'`,
        source: typedSQL<Record<string, unknown>>`${operationRecord.payload}->'sourceRefs'`,
        key: typedSQL<string | null>`${operationRecord.payload}->>'manifestKey'`,
        sha256: typedSQL<string | null>`${operationRecord.payload}->>'manifestSha256'`,
        producerVersion: typedSQL<string | null>`${operationRecord.payload}->>'producerVersion'`,
      })
      .from(operationRecord)
      .innerJoin(
        agentTurn,
        and(
          eq(typedSQL<string>`${agentTurn.id}::text`, operationRecord.scopeId),
          eq(agentTurn.state, "completed"),
          typedSQL`${agentTurn.authority}->>'mode'='build'`,
        ),
      )
      .innerJoin(
        changeAgentTurnIntent,
        and(
          eq(changeAgentTurnIntent.turnId, agentTurn.id),
          eq(
            typedSQL<string>`${changeAgentTurnIntent.runtimeAttemptId}::text`,
            typedSQL<string>`${operationRecord.payload}->>'runtimeAttemptId'`,
          ),
          eq(
            changeAgentTurnIntent.sessionId,
            typedSQL<string>`${operationRecord.payload}->>'sessionId'`,
          ),
          eq(
            changeAgentTurnIntent.promptId,
            typedSQL<string>`${operationRecord.payload}->>'promptId'`,
          ),
          eq(changeAgentTurnIntent.changeId, agentTurn.changeId),
        ),
      )
      .innerJoin(
        runtimeAttempt,
        and(
          eq(
            typedSQL<string>`${runtimeAttempt.id}::text`,
            typedSQL<string>`${operationRecord.payload}->>'runtimeAttemptId'`,
          ),
          eq(runtimeAttempt.changeId, agentTurn.changeId),
          eq(runtimeAttempt.projectId, agentTurn.projectId),
        ),
      )
      .where(
        and(
          eq(operationRecord.kind, "coding.session_archive"),
          eq(operationRecord.scopeType, "agent_turn"),
          eq(agentTurn.id, nativeTurnID),
          eq(agentTurn.projectId, snapshot.projectId),
          eq(operationRecord.state, "saved"),
        ),
      );
    // Usage settles before the asynchronous archive and even before Git
    // submission. The existing Verification wait helps once a SHA exists,
    // but cannot cover that earlier race. Do not freeze an empty trace at
    // first sight or wait forever for a save that may never succeed.
    const age = Date.now() - Date.parse(snapshot.settledAt);
    if (!saved && age >= 0 && age < nativeArchiveGraceMS) return null;
    return { saved };
  });
  if (!admitted) return { status: "skip" };
  // Private object I/O must not hold policy/account locks or a SQL connection.
  const saved = admitted.saved;
  // The saved-state schema check requires these nullable columns to be present.
  const evidence = await readNativeToolEvidence(
    nativeTurnID,
    saved &&
      saved.throughMessageID !== null &&
      saved.key !== null &&
      saved.sha256 !== null &&
      saved.producerVersion !== null
      ? {
          ...saved,
          throughMessageID: saved.throughMessageID,
          key: saved.key,
          sha256: saved.sha256,
          producerVersion: saved.producerVersion,
        }
      : undefined,
    objects,
  );
  return { status: "ready", evidence };
}
