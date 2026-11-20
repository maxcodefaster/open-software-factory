import { and, eq, isNotNull, isNull, notInArray, sql as query } from "drizzle-orm";
import { z } from "zod";
import {
  type AgentTurnCommand,
  agentTurnAuthorityInput,
  agentTurnCommandInput,
  changeAgentPromptInput,
  changeAgentRepairInput,
  changeAgentStartInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import { buildBrowserInstructions } from "../../../../packages/conversation-domain/src/browser-tools";
import type { ModelConnectionReference } from "../../../../packages/conversation-domain/src/model-connection";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import { skillInstructionText } from "../../../../packages/conversation-domain/src/skills";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  changeWriter,
  codingPause,
  conversationContext,
  modelConnectionVersion,
  requirementRevision,
  runtimeAttempt,
} from "../../../../packages/db/src/schema";
import { claimAgentWriterIn } from "../access/change-writer";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { attachmentContextIn } from "../attachments/store";
import { requireDeliveredPrerequisites } from "../change/dependencies";
import { CommandError } from "../command-error";
import { ensureConversationIn } from "../conversations/store";
import { codingReasoningIn } from "../models/controller";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import { createSkillController } from "../skills/controller";
import {
  nativeInputSkills,
  nativeSkillManifest,
  nativeSkillManifestInput,
  skillAdvertisement,
} from "../skills/native";
import { createContractRates } from "../usage/contract-rates";
import { codingBudgetIn } from "../usage/policy";
import { buildGoalInstructions } from "./build-completion";
import { buildKnowledgeContext } from "./knowledge-context";
import { readTerminalOutcome, type TerminalInput, type TerminalOutcome } from "./terminal-outcome";
import { createAgentTurnStore } from "./turn-store";

type Database = ReturnType<typeof createDatabase>;
export type ChangeAgentInput =
  | {
      kind: "change-start";
      commandId: string;
      codingReasoning?: CodingReasoning;
      contextId?: string;
    }
  | {
      kind: "change-prompt" | "change-repair";
      commandId: string;
      text: string;
      resume?: boolean;
      contextId?: string;
    };

type ChangeContext = {
  projectID: string;
  ticketID: string;
  revisionID: string;
  monitoringIncidentID: string | null;
  title: string;
  description: string;
  canonicalContent: string;
  technicalDesign: string | null;
  conversationID: string | null;
  conversationVersion: number | null;
  mode: string | null;
  sessionID: string | null;
  sessionState: string | null;
  stopPending: boolean | null;
  contextID: string | null;
  nativeConfirmed: boolean;
};

export function createChangeAdmission(
  database: Database,
  defaultModel:
    | string
    | ((
        sql: DatabaseTransaction,
        context: { projectID: string; userID: string; personal?: boolean },
      ) => Promise<string>),
  resolveConnection?: (sql: DatabaseTransaction) => Promise<ModelConnectionReference | undefined>,
) {
  const turns = createAgentTurnStore(database);
  const skills = createSkillController(database);
  async function context(sql: DatabaseTransaction, changeID: string, userID: string) {
    // Acquire locks before reading the approved revision. A joined statement
    // retains its pre-wait snapshot even after a concurrent writer commits.
    const locked = await sql<Array<{ id: string }>>`
      SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
        WHERE change.id = ${changeID} FOR UPDATE OF change, ticket`;
    if (!locked[0])
      throw new CommandError(
        "conflict",
        "Build requires an active Change and the latest approved Requirements",
      );
    const rows = await sql<ChangeContext[]>`
      SELECT change.project_id AS "projectID", change.ticket_id AS "ticketID",
        revision.id AS "revisionID", approval.monitoring_incident_id AS "monitoringIncidentID",ticket.title, ticket.description,
        revision.canonical_content AS "canonicalContent", conversation.id AS "conversationID",
        (SELECT json_build_object('sourceCommit',source_commit,'content',canonical_content::jsonb,'sources',citations)::text
          FROM factory.technical_design_revision WHERE id=approval.technical_design_revision_id) AS "technicalDesign",
        conversation.mode, conversation.version::float8 AS "conversationVersion",
        CASE WHEN COALESCE(session.implementation_session_confirmed_at, session.native_session_confirmed_at) IS NOT NULL
          THEN COALESCE(session.implementation_session_id, session.opencode_session_id) END AS "sessionID", session.state AS "sessionState",
        session.stop_pending AS "stopPending",conversation.active_coding_context_id AS "contextID",
        COALESCE(session.implementation_session_confirmed_at,session.native_session_confirmed_at) IS NOT NULL AS "nativeConfirmed"
      FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
      JOIN factory.requirement_revision revision ON revision.id = approval.requirement_revision_id
      LEFT JOIN factory.ticket_conversation conversation ON conversation.ticket_id = ticket.id
      LEFT JOIN factory.change_agent_session session ON session.change_id = change.id
      WHERE change.id = ${changeID}
        AND (change.state IN ('branch-pending', 'starting', 'active') OR (
          change.state='failed'
          AND (session.change_id IS NULL OR (session.state IN ('failed','stopped') AND NOT session.stop_pending))
          AND EXISTS(SELECT 1 FROM factory.branch_create_operation WHERE change_id=change.id AND state='succeeded')
          AND EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=change.runtime_attempt_id AND state IN ('failed','stopped'))
        ))
        AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
        AND revision.id = (SELECT id FROM factory.requirement_revision WHERE ticket_id = ticket.id ORDER BY ordinal DESC LIMIT 1)
    `;
    if (!rows[0])
      throw new CommandError(
        "conflict",
        "Build requires an active Change and the latest approved Requirements",
      );
    await ensureConversationIn(sql, rows[0].projectID, rows[0].ticketID, userID);
    // Read again after acquiring the Ticket lock. A writer may have committed
    // a new Conversation or version while the original joined query waited.
    const conversations = await sql<
      Array<{ id: string; mode: string; version: number; contextID: string | null }>
    >`
      SELECT id, mode, version::float8 AS version,active_coding_context_id AS "contextID" FROM factory.ticket_conversation
        WHERE ticket_id = ${rows[0].ticketID} FOR UPDATE`;
    const conversation = conversations[0];
    if (conversation && conversation.mode !== "build")
      throw new CommandError("conflict", "Build mode is required");
    return {
      ...rows[0],
      conversationID: conversation?.id ?? null,
      conversationVersion: conversation?.version ?? null,
      mode: conversation?.mode ?? null,
      contextID: conversation?.contextID ?? null,
    };
  }
  async function admitIn(
    sql: DatabaseTransaction,
    changeID: string,
    userID: string,
    input: ChangeAgentInput,
  ) {
    if (input.kind === "change-start")
      changeAgentStartInput.parse({
        commandId: input.commandId,
        codingReasoning: input.codingReasoning,
      });
    else if (input.kind === "change-repair")
      changeAgentRepairInput.parse({ commandId: input.commandId, text: input.text });
    else changeAgentPromptInput.parse({ commandId: input.commandId, text: input.text });
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${input.commandId}`}))`;
    const previous = await turns.getByCommand(input.commandId, sql);
    if (previous) {
      if (
        previous.command.kind !== input.kind ||
        !("changeId" in previous.command) ||
        previous.command.changeId !== changeID ||
        previous.command.createdBy !== userID
      ) {
        throw new CommandError(
          "conflict",
          "The Agent command identity was reused with different input",
        );
      }
      const { resume: _resume, ...replayedInput } = input as ChangeAgentInput & {
        resume?: boolean;
      };
      const command = agentTurnCommandInput.parse({ ...previous.command, ...replayedInput });
      if (input.kind === "change-start" && input.codingReasoning)
        await projectDevelopmentAuthorityIn(sql, userID, command.projectId);
      else await projectAuthorityIn(sql, userID, command.projectId);
      return turns.admitIn(sql, command, previous.authority);
    }
    const current = await context(sql, changeID, userID);
    const db = drizzleTransaction(sql);
    if (
      (input.contextId ?? null) !== current.contextID &&
      input.kind !== "change-repair" &&
      !(input.kind === "change-prompt" && input.resume)
    )
      throw new CommandError(
        "conflict",
        "The active Coding conversation changed. Keep your draft and return to the active conversation.",
      );
    const [codingContext] = current.contextID
      ? await db
          .select({ nativeID: conversationContext.nativeSessionId })
          .from(conversationContext)
          .where(
            and(
              eq(conversationContext.id, current.contextID),
              eq(conversationContext.changeId, changeID),
            ),
          )
      : [];
    if (codingContext) current.sessionID = codingContext.nativeID;
    if (input.kind === "change-start" && input.codingReasoning)
      await projectDevelopmentAuthorityIn(sql, userID, current.projectID);
    else await projectAuthorityIn(sql, userID, current.projectID);
    const paused = await db
      .select({ turnID: codingPause.turnId })
      .from(codingPause)
      .innerJoin(agentTurn, eq(agentTurn.id, codingPause.turnId))
      .where(
        and(
          eq(agentTurn.changeId, changeID),
          isNull(codingPause.resumedByTurnId),
          query`${agentTurn.input}->>'contextId' IS NOT DISTINCT FROM ${current.contextID}`,
        ),
      );
    if (
      paused.length &&
      input.kind !== "change-repair" &&
      !(input.kind === "change-prompt" && input.resume === true)
    )
      throw new CommandError(
        "conflict",
        "Coding is paused. Resume the retained work from the Ticket.",
      );
    const budget = await codingBudgetIn(
      sql,
      current.projectID,
      input.kind === "change-repair" || (input.kind === "change-prompt" && input.resume === true),
    );
    if (!budget.allowed && input.kind !== "change-repair")
      throw new CommandError(
        "conflict",
        budget.reason === "accounting-incomplete"
          ? "Coding accounting is incomplete. Usage & limits shows what is missing."
          : "The monthly Coding allowance is used. New work can start after reset or an allowance increase.",
      );
    await requireDeliveredPrerequisites(sql, current.projectID, current.ticketID);
    const [firstTurn] = await db
      .select({
        modelId: query<string>`${agentTurn.authority}->>'modelId'`,
        authority: agentTurn.authority,
        skillLoading: changeAgentTurnIntent.skillLoading,
      })
      .from(agentTurn)
      .leftJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
      .where(eq(agentTurn.changeId, changeID))
      .orderBy(agentTurn.createdAt, agentTurn.id)
      .limit(1);
    const firstAuthority = firstTurn
      ? agentTurnAuthorityInput.parse(firstTurn.authority)
      : undefined;
    const monitoringIncidentID =
      input.kind === "change-start"
        ? current.monitoringIncidentID
        : input.kind === "change-repair" && firstAuthority?.mode === "build"
          ? firstAuthority.monitoringIncidentId
          : undefined;
    if (monitoringIncidentID) {
      const delegated = await monitoringChangeAuthorityIn(
        database,
        sql,
        changeID,
        monitoringIncidentID,
      );
      if (delegated.userId !== userID)
        throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
    }
    const modelID =
      firstTurn?.modelId ??
      (typeof defaultModel === "string"
        ? defaultModel
        : await defaultModel(sql, {
            projectID: current.projectID,
            userID,
            personal: !monitoringIncidentID,
          }));
    const modelConnection = firstTurn
      ? firstAuthority?.modelConnection
      : await resolveConnection?.(sql);
    const codingReasoning = firstTurn
      ? firstAuthority?.mode === "build"
        ? firstAuthority.codingReasoning
        : undefined
      : input.kind === "change-start" && input.codingReasoning
        ? input.codingReasoning
        : await codingReasoningIn(sql);
    if (input.kind === "change-start" && input.codingReasoning) {
      if (firstTurn && input.codingReasoning !== codingReasoning)
        throw new CommandError(
          "conflict",
          "This Change keeps its original reasoning. Start a new Change to choose different reasoning.",
        );
      const [connection] = modelConnection
        ? await db
            .select({ provider: modelConnectionVersion.provider })
            .from(modelConnectionVersion)
            .where(
              and(
                eq(modelConnectionVersion.connectionId, modelConnection.connectionID),
                eq(modelConnectionVersion.version, modelConnection.version),
              ),
            )
        : [];
      if ((connection?.provider ?? process.env["FACTORY_MODEL_PROVIDER"] ?? "openai") !== "openai")
        throw new CommandError(
          "conflict",
          "Reasoning selection is available for OpenAI Coding models only.",
        );
    }
    if (budget.allowed && budget.effective.codingUSD !== null) {
      const [connection] = modelConnection
        ? await db
            .select({ provider: modelConnectionVersion.provider })
            .from(modelConnectionVersion)
            .where(
              and(
                eq(modelConnectionVersion.connectionId, modelConnection.connectionID),
                eq(modelConnectionVersion.version, modelConnection.version),
              ),
            )
        : [];
      const rate = await createContractRates(database).get(
        connection?.provider ?? "openai",
        modelID,
        sql,
      );
      if (!rate || rate.tiers.some((tier) => tier.input === null || tier.output === null))
        throw new CommandError(
          "conflict",
          "Coding needs known input and output prices before starting with an enabled allowance. Set contract prices in Usage & limits.",
        );
    }
    const assignedSkills = firstAuthority
      ? {
          revisionIds: firstAuthority.skillRevisionIds,
          requiredRevisionIds: firstAuthority.requiredSkillRevisionIds,
        }
      : await skills.resolveAssignment("build", sql, {
          projectID: current.projectID,
          userID,
          personal: !monitoringIncidentID,
        });
    const skillRevisionIDs = assignedSkills.revisionIds;
    const admittedSkills = await skills.load(skillRevisionIDs, sql);
    const skillLoading = firstTurn ? (firstTurn.skillLoading ?? "eager") : "native";
    if (current.stopPending)
      throw new CommandError(
        "conflict",
        "Stop is recorded. Wait for runtime confirmation before resuming Build.",
      );
    if (current.sessionState === "starting" || current.sessionState === "working") {
      throw new CommandError("conflict", "The Change Agent already owns active Build work");
    }
    if (input.kind !== "change-start" && !current.sessionID) {
      throw new CommandError("conflict", "Change Agent has not been started");
    }
    if (input.kind === "change-repair" && current.sessionState !== "committed") {
      throw new CommandError("conflict", "Automatic repair is paused. Resume Build manually.");
    }
    const commits = await db
      .select({ id: changeCommitOperation.id })
      .from(changeCommitOperation)
      .where(
        and(
          eq(changeCommitOperation.changeId, changeID),
          notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
        ),
      );
    if (commits[0])
      throw new CommandError(
        "conflict",
        "Wait for the current commit operation before starting Build",
      );
    const { resume: _resume, ...commandInput } = input as ChangeAgentInput & { resume?: boolean };
    const command = {
      ...commandInput,
      projectId: current.projectID,
      ticketId: current.ticketID,
      conversationId: current.conversationID,
      changeId: changeID,
      createdBy: userID,
      ...(current.contextID ? { contextId: current.contextID } : {}),
    } satisfies AgentTurnCommand;
    return turns.admitIn(
      sql,
      command,
      {
        mode: "build",
        submissionPolicy: "native",
        browserTransport: "mcp",
        modelId: modelID,
        ...(modelConnection ? { modelConnection } : {}),
        ...(codingReasoning ? { codingReasoning } : {}),
        ...(monitoringIncidentID ? { monitoringIncidentId: monitoringIncidentID } : {}),
        skillRevisionIds: skillRevisionIDs,
        requiredSkillRevisionIds: assignedSkills.requiredRevisionIds,
        requirementRevisionId: current.revisionID,
        conversationVersion: current.conversationVersion,
      },
      async (transaction, record) => {
        await claimAgentWriterIn(transaction, changeID, record.id, userID);
        const db = drizzleTransaction(transaction);
        // A new human command owns recovery. The failed attempt and turn remain
        // immutable; runtime startup admits a new generation after safe cleanup.
        await db
          .update(change)
          .set({ state: "starting", failure: null, version: query`${change.version}+1` })
          .where(and(eq(change.id, changeID), eq(change.state, "failed")));
        if (input.kind === "change-repair" && !budget.allowed)
          await db
            .insert(codingPause)
            .values({ turnId: record.id, reason: query`${budget.reason}` });
        if (input.kind === "change-prompt" && input.resume === true)
          await db
            .update(codingPause)
            .set({ resumedByTurnId: record.id })
            .from(agentTurn)
            .where(
              and(
                eq(codingPause.turnId, agentTurn.id),
                eq(agentTurn.changeId, changeID),
                isNull(codingPause.resumedByTurnId),
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
        const knowledge = await buildKnowledgeContext(
          transaction,
          current.projectID,
          knowledgeQuery,
        );
        const instructions = [
          userPrompt,
          ...(current.technicalDesign
            ? ["Approved technical design:", current.technicalDesign]
            : []),
          "Preserve existing human edits in this checkout. Inspect the current diff before making changes; do not discard unrelated work.",
          ...(input.kind === "change-start"
            ? []
            : ["Approved specification:", current.canonicalContent]),
          knowledge,
          buildBrowserInstructions(record.id),
          buildGoalInstructions(criteria.length),
        ].join("\n\n");
        const prompt = admittedSkills.length
          ? `${instructions}\n\nFactory-approved Build Skills follow. These are guidance only. They do not grant tools, credentials, Project access or approval authority. Do not commit, push, approve or merge.\n\n${skillLoading === "native" ? skillAdvertisement(admittedSkills) : skillInstructionText(admittedSkills)}`
          : instructions;
        const manifest = skillLoading === "native" ? nativeSkillManifest(admittedSkills) : null;
        const attachments =
          skillLoading === "native"
            ? nativeInputSkills(userPrompt, admittedSkills, assignedSkills.requiredRevisionIds)
            : [];
        await db.insert(changeAgentTurnIntent).values({
          turnId: record.id,
          changeId: changeID,
          sessionId: current.sessionID ?? `ses_factory_${changeID.replaceAll("-", "")}`,
          promptId: `msg_factory_${record.id.replaceAll("-", "")}`,
          promptText: prompt,
          bootstrap: input.kind === "change-start" || !current.nativeConfirmed,
          sessionTitle: current.title,
          skillLoading,
          skillManifest: manifest,
          skillAttachments: attachments,
        });
      },
    );
  }
  return {
    admitIn,
    async terminalObservation(input: TerminalInput) {
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
    },
    async checkpointTerminal(input: TerminalInput, ownerToken: string, value: TerminalOutcome) {
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
    },
    async admit(changeID: string, userID: string, input: ChangeAgentInput) {
      return database.client.begin((sql) => admitIn(sql, changeID, userID, input));
    },
    async intent(turnID: string) {
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
          skillLoading: query<"eager" | "native">`${changeAgentTurnIntent.skillLoading}`,
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
          eq(
            requirementRevision.id,
            query`(${agentTurn.authority}->>'requirementRevisionId')::uuid`,
          ),
        )
        .where(eq(changeAgentTurnIntent.turnId, turnID));
      if (!rows[0]) throw new Error("Change Agent dispatch intent not found");
      return {
        ...rows[0],
        text: [rows[0].text, await database.client.begin((sql) => attachmentContextIn(sql, turnID))]
          .filter(Boolean)
          .join("\n\n"),
        skillManifest:
          rows[0].skillManifest === null
            ? null
            : nativeSkillManifestInput.parse(rows[0].skillManifest),
        skills: z
          .array(z.object({ id: z.string() }).strict())
          .max(16)
          .parse(rows[0].skills),
      };
    },
  };
}
