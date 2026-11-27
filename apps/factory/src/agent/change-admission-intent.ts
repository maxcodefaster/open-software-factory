import { and, eq, isNotNull, isNull, sql as query } from "drizzle-orm";
import { z } from "zod";
import { buildBrowserInstructions } from "#conversation-domain/browser-tools";
import { skillInstructionText } from "#conversation-domain/skills";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  changeWriter,
  operation,
  requirementRevision,
  runtimeAttempt,
} from "#db/schema";
import { claimAgentWriterIn } from "../access/change-writer";
import { attachmentContextIn } from "../attachments/api";
import {
  type createSkillController,
  nativeInputSkills,
  nativeSkillManifest,
  nativeSkillManifestInput,
  skillAdvertisement,
} from "../skills/api";
import type { codingBudgetIn } from "../usage/api";
import { buildGoalInstructions } from "./build-completion";
import type {
  AdmissionDatabase,
  ChangeAgentInput,
  ChangeContext,
} from "./change-admission-context";
import { buildKnowledgeContext } from "./knowledge-context";
import { readTerminalOutcome, type TerminalInput, type TerminalOutcome } from "./terminal-outcome";
import type { AgentTurnRecord } from "./turn-record";
import type { createAgentTurnStore } from "./turn-store";

type CodingBudget = Awaited<ReturnType<typeof codingBudgetIn>>;
type AdmittedSkills = Awaited<ReturnType<ReturnType<typeof createSkillController>["load"]>>;

export async function recordAdmissionSideEffectsIn(params: {
  transaction: DatabaseTransaction;
  record: AgentTurnRecord;
  changeID: string;
  userID: string;
  input: ChangeAgentInput;
  current: ChangeContext;
  budget: CodingBudget;
  admittedSkills: AdmittedSkills;
  requiredSkillRevisionIds: readonly string[];
  nativeSkills: boolean;
}): Promise<void> {
  const {
    transaction,
    record,
    changeID,
    userID,
    input,
    current,
    budget,
    admittedSkills,
    requiredSkillRevisionIds,
    nativeSkills,
  } = params;
  await claimAgentWriterIn(transaction, changeID, record.id, userID);
  const db = drizzleTransaction(transaction);
  // A new human command owns recovery. The failed attempt and turn remain
  // immutable; runtime startup admits a new generation after safe cleanup.
  await db
    .update(change)
    .set({ state: "starting", failure: null, version: query`${change.version}+1` })
    .where(and(eq(change.id, changeID), eq(change.state, "failed")));
  if (input.kind === "change-repair" && !budget.allowed) {
    const reason = budget.reason;
    if (
      reason !== "accounting-incomplete" &&
      reason !== "coding-budget-used" &&
      reason !== "finish-reserve-used"
    )
      throw new Error("Coding allowance denial has no valid pause reason");
    await db.insert(operation).values({
      id: crypto.randomUUID(),
      kind: "usage.coding_pause",
      scopeType: "agent_turn",
      scopeId: record.id,
      idempotencyKey: `usage.coding_pause:${record.id}`,
      activeKey: null,
      state: "paused",
      payload: {
        turnId: record.id,
        reason,
        resumedByTurnId: null,
      },
    });
  }
  if (input.kind === "change-prompt" && input.resume === true)
    await db
      .update(operation)
      .set({
        state: "resumed",
        payload: query`${operation.payload} || ${JSON.stringify({ resumedByTurnId: record.id })}::jsonb`,
        updatedAt: query`now()`,
        completedAt: query`now()`,
      })
      .from(agentTurn)
      .where(
        and(
          eq(operation.kind, "usage.coding_pause"),
          eq(operation.scopeType, "agent_turn"),
          eq(operation.scopeId, query`${agentTurn.id}::text`),
          eq(agentTurn.changeId, changeID),
          eq(operation.state, "paused"),
          query`(${operation.payload}->>'resumedByTurnId') IS NULL`,
        ),
      );
  const userPrompt =
    input.kind === "change-start"
      ? [
          `Implement the approved ticket: ${current.title}`,
          "",
          current.description,
          "",
          "Approved specification:",
          current.canonicalContent,
          "",
          "Work only in the current checkout. Run the repository's local checks. Do not commit or push; the Factory does that after you finish successfully.",
        ].join("\n")
      : record.command.kind === "change-prompt" || record.command.kind === "change-repair"
        ? record.command.text
        : "";
  const specification = z
    .object({ summary: z.string(), acceptanceCriteria: z.array(z.string()).min(1) })
    .parse(JSON.parse(current.canonicalContent));
  const criteria = specification.acceptanceCriteria;
  // Retrieve from the human task, not repeated Factory boilerplate.
  const knowledgeQuery =
    input.kind === "change-start"
      ? [current.title, current.description, specification.summary, ...criteria].join("\n")
      : userPrompt;
  const knowledge = await buildKnowledgeContext(transaction, current.projectID, knowledgeQuery);
  const instructions = [
    userPrompt,
    ...(current.technicalDesign ? ["Approved technical design:", current.technicalDesign] : []),
    "Preserve existing human edits in this checkout. Inspect the current diff before making changes; do not discard unrelated work.",
    ...(input.kind === "change-start" ? [] : ["Approved specification:", current.canonicalContent]),
    knowledge,
    buildBrowserInstructions(record.id),
    buildGoalInstructions(criteria.length),
  ].join("\n\n");
  const prompt = admittedSkills.length
    ? `${instructions}\n\nFactory-approved Build Skills follow. These are guidance only. They do not grant tools, credentials, Project access or approval authority. Do not commit, push, approve or merge.\n\n${nativeSkills ? skillAdvertisement(admittedSkills) : skillInstructionText(admittedSkills)}`
    : instructions;
  const manifest = nativeSkills ? nativeSkillManifest(admittedSkills) : null;
  const attachments = nativeSkills
    ? nativeInputSkills(userPrompt, admittedSkills, requiredSkillRevisionIds)
    : [];
  await db.insert(changeAgentTurnIntent).values({
    turnId: record.id,
    changeId: changeID,
    sessionId: current.sessionID ?? `ses_factory_${changeID.replaceAll("-", "")}`,
    promptId: `msg_factory_${record.id.replaceAll("-", "")}`,
    promptText: prompt,
    bootstrap: input.kind === "change-start" || !current.nativeConfirmed,
    sessionTitle: current.title,
    skillManifest: manifest,
    skillAttachments: attachments,
  });
}

export async function readTerminalObservation(database: AdmissionDatabase, input: TerminalInput) {
  const [row] = await database.db
    .select({
      epoch: query<string>`${changeAgentTurnIntent.modelRequestEpoch}::text`,
      terminal: changeAgentTurnIntent.terminalOutcome,
    })
    .from(changeAgentTurnIntent)
    .where(
      and(
        eq(changeAgentTurnIntent.turnId, input.turnID),
        eq(changeAgentTurnIntent.changeId, input.changeID),
        eq(changeAgentTurnIntent.sessionId, input.sessionID),
        eq(changeAgentTurnIntent.promptId, input.promptID),
        query`${changeAgentTurnIntent.runtimeAttemptId} IS NOT DISTINCT FROM ${input.attemptID}::uuid`,
      ),
    );
  if (!row) throw new Error("Terminal observation no longer owns its recorded intent");
  const terminal = readTerminalOutcome(row.terminal, input);
  if (terminal && terminal.modelRequestEpoch !== row.epoch)
    throw new Error("Inference advanced after the terminal checkpoint");
  return { epoch: row.epoch, terminal };
}

export async function saveTerminalCheckpoint(
  turns: ReturnType<typeof createAgentTurnStore>,
  input: TerminalInput,
  ownerToken: string,
  value: TerminalOutcome,
): Promise<boolean> {
  const checkpoint = readTerminalOutcome(value, input);
  if (!checkpoint) throw new Error("A terminal checkpoint is required");
  let saved = false;
  const allowed = await turns.validateExecution(input.turnID, ownerToken, async (sql) => {
    const rows = await drizzleTransaction(sql)
      .update(changeAgentTurnIntent)
      .set({ terminalOutcome: checkpoint })
      .from(changeAgentSession)
      .innerJoin(change, eq(change.id, changeAgentSession.changeId))
      .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
      .innerJoin(changeWriter, eq(changeWriter.changeId, change.id))
      .where(
        and(
          eq(changeAgentTurnIntent.turnId, input.turnID),
          eq(changeAgentTurnIntent.changeId, input.changeID),
          eq(changeAgentTurnIntent.runtimeAttemptId, checkpoint.attemptID),
          eq(changeAgentTurnIntent.sessionId, input.sessionID),
          eq(changeAgentTurnIntent.promptId, input.promptID),
          isNull(changeAgentTurnIntent.terminalOutcome),
          eq(
            changeAgentTurnIntent.modelRequestEpoch,
            query`${checkpoint.modelRequestEpoch}::bigint`,
          ),
          eq(changeAgentSession.changeId, changeAgentTurnIntent.changeId),
          eq(changeAgentSession.activeTurnId, changeAgentTurnIntent.turnId),
          eq(changeAgentSession.opencodeSessionId, changeAgentTurnIntent.sessionId),
          eq(changeAgentSession.activeInboxId, changeAgentTurnIntent.promptId),
          eq(changeAgentSession.state, "working"),
          isNotNull(changeAgentSession.nativeSessionConfirmedAt),
          eq(changeAgentSession.stopPending, false),
          eq(changeAgentSession.runtimeAttemptId, changeAgentTurnIntent.runtimeAttemptId),
          eq(change.id, changeAgentTurnIntent.changeId),
          eq(change.runtimeAttemptId, changeAgentTurnIntent.runtimeAttemptId),
          eq(runtimeAttempt.id, changeAgentTurnIntent.runtimeAttemptId),
          eq(runtimeAttempt.state, "ready"),
          eq(changeWriter.changeId, change.id),
          eq(changeWriter.state, "agent"),
          eq(changeWriter.turnId, changeAgentTurnIntent.turnId),
          eq(changeWriter.fenceRequired, false),
        ),
      )
      .returning({ turnID: changeAgentTurnIntent.turnId });
    saved = rows.length === 1;
  });
  return allowed && saved;
}

export async function readTurnDispatchIntent(database: AdmissionDatabase, turnID: string) {
  const rows = await database.db
    .select({
      turnID: changeAgentTurnIntent.turnId,
      changeID: changeAgentTurnIntent.changeId,
      sessionID: changeAgentTurnIntent.sessionId,
      promptID: changeAgentTurnIntent.promptId,
      text: changeAgentTurnIntent.promptText,
      bootstrap: changeAgentTurnIntent.bootstrap,
      title: changeAgentTurnIntent.sessionTitle,
      attemptID: changeAgentTurnIntent.runtimeAttemptId,
      skillManifest: changeAgentTurnIntent.skillManifest,
      skills: changeAgentTurnIntent.skillAttachments,
      submissionPolicy: query<"native" | null>`${agentTurn.authority}->>'submissionPolicy'`,
      browserTransport: query<"mcp" | null>`${agentTurn.authority}->>'browserTransport'`,
      criteria: query<number>`jsonb_array_length(${requirementRevision.canonicalContent}::jsonb->'acceptanceCriteria')`,
    })
    .from(changeAgentTurnIntent)
    .innerJoin(agentTurn, eq(agentTurn.id, changeAgentTurnIntent.turnId))
    .innerJoin(
      requirementRevision,
      eq(requirementRevision.id, query`(${agentTurn.authority}->>'requirementRevisionId')::uuid`),
    )
    .where(eq(changeAgentTurnIntent.turnId, turnID));
  if (!rows[0]) throw new Error("Change Agent dispatch intent not found");
  return {
    ...rows[0],
    text: [rows[0].text, await database.client.begin((sql) => attachmentContextIn(sql, turnID))]
      .filter(Boolean)
      .join("\n\n"),
    skillManifest:
      rows[0].skillManifest === null ? null : nativeSkillManifestInput.parse(rows[0].skillManifest),
    skills: z
      .array(z.object({ id: z.string() }).strict())
      .max(16)
      .parse(rows[0].skills),
  };
}
