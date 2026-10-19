import {
  type AgentTurnCommand,
  agentTurnAuthorityInput,
  agentTurnCommandInput,
  changeAgentPromptInput,
  changeAgentStartInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import { buildBrowserInstructions } from "../../../../packages/conversation-domain/src/browser-tools";
import { buildGoalInstructions } from "./build-completion";
import type { ModelConnectionReference } from "../../../../packages/conversation-domain/src/model-connection";
import { skillInstructionText } from "../../../../packages/conversation-domain/src/skills";
import type { createDatabase } from "../../../../packages/db/src/client";
import { claimAgentWriterIn } from "../access/change-writer";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { requireDeliveredPrerequisites } from "../change/dependencies";
import { CommandError } from "../command-error";
import { createSkillController } from "../skills/controller";
import {
  invokedSkills,
  nativeSkillId,
  nativeSkillManifest,
  nativeSkillManifestInput,
  skillAdvertisement,
} from "../skills/native";
import { z } from "zod";
import { createContractRates } from "../usage/contract-rates";
import { codingBudgetIn } from "../usage/policy";
import { buildKnowledgeContext } from "./knowledge-context";
import { type AgentTurnTransaction, createAgentTurnStore } from "./turn-store";
import { codingReasoningIn } from "../models/controller";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";

type Database = ReturnType<typeof createDatabase>;
export type ChangeAgentInput =
  | { kind: "change-start"; commandId: string; codingReasoning?: CodingReasoning }
  | { kind: "change-prompt" | "change-repair"; commandId: string; text: string; resume?: boolean };

type ChangeContext = {
  projectID: string;
  ticketID: string;
  revisionID: string;
  title: string;
  description: string;
  canonicalContent: string;
  conversationID: string | null;
  conversationVersion: number | null;
  mode: string | null;
  sessionID: string | null;
  sessionState: string | null;
  stopPending: boolean | null;
};

export function createChangeAdmission(
  database: Database,
  defaultModel:
    | string
    | ((
        sql: AgentTurnTransaction,
        context: { projectID: string; userID: string },
      ) => Promise<string>),
  resolveConnection?: (sql: AgentTurnTransaction) => Promise<ModelConnectionReference | undefined>,
) {
  const turns = createAgentTurnStore(database);
  const skills = createSkillController(database);
  async function context(sql: AgentTurnTransaction, changeID: string) {
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
        revision.id AS "revisionID", ticket.title, ticket.description,
        revision.canonical_content AS "canonicalContent", conversation.id AS "conversationID",
        conversation.mode, conversation.version::float8 AS "conversationVersion",
        CASE WHEN session.native_session_confirmed_at IS NOT NULL
          THEN session.opencode_session_id END AS "sessionID", session.state AS "sessionState",
        session.stop_pending AS "stopPending"
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
    // Read again after acquiring the Ticket lock. A writer may have committed
    // a new Conversation or version while the original joined query waited.
    const conversations = await sql<Array<{ id: string; mode: string; version: number }>>`
      SELECT id, mode, version::float8 AS version FROM factory.ticket_conversation
        WHERE ticket_id = ${rows[0].ticketID} FOR UPDATE`;
    const conversation = conversations[0];
    if (conversation && conversation.mode !== "build")
      throw new CommandError("conflict", "Build mode is required");
    return {
      ...rows[0],
      conversationID: conversation?.id ?? null,
      conversationVersion: conversation?.version ?? null,
      mode: conversation?.mode ?? null,
    };
  }
  async function admitIn(
    sql: AgentTurnTransaction,
    changeID: string,
    userID: string,
    input: ChangeAgentInput,
  ) {
    if (input.kind === "change-start")
      changeAgentStartInput.parse({
        commandId: input.commandId,
        codingReasoning: input.codingReasoning,
      });
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
    const current = await context(sql, changeID);
    if (input.kind === "change-start" && input.codingReasoning)
      await projectDevelopmentAuthorityIn(sql, userID, current.projectID);
    else await projectAuthorityIn(sql, userID, current.projectID);
    const paused = await sql`SELECT pause.turn_id FROM factory.coding_pause pause
      JOIN factory.agent_turn turn ON turn.id=pause.turn_id
      WHERE turn.change_id=${changeID} AND pause.resumed_by_turn_id IS NULL`;
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
    const [firstTurn] = await sql<
      Array<{
        modelId: string;
        skillRevisionIds: unknown;
        authority: unknown;
        skillLoading: string | null;
      }>
    >`
          SELECT turn.authority->>'modelId' AS "modelId", turn.authority->'skillRevisionIds' AS "skillRevisionIds", turn.authority, intent.skill_loading AS "skillLoading" FROM factory.agent_turn turn
          LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
          WHERE turn.change_id = ${changeID} ORDER BY turn.created_at, turn.id LIMIT 1
        `;
    const firstAuthority = firstTurn
      ? agentTurnAuthorityInput.parse(firstTurn.authority)
      : undefined;
    const modelID =
      firstTurn?.modelId ??
      (typeof defaultModel === "string"
        ? defaultModel
        : await defaultModel(sql, { projectID: current.projectID, userID }));
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
        ? await sql<Array<{ provider: string }>>`
        SELECT provider FROM factory.model_connection_version
        WHERE connection_id=${modelConnection.connectionID} AND version=${modelConnection.version}`
        : [];
      if ((connection?.provider ?? process.env["FACTORY_MODEL_PROVIDER"] ?? "openai") !== "openai")
        throw new CommandError(
          "conflict",
          "Reasoning selection is available for OpenAI Coding models only.",
        );
    }
    if (budget.allowed && budget.effective.codingUSD !== null) {
      const [connection] = modelConnection
        ? await sql<Array<{ provider: string }>>`
        SELECT provider FROM factory.model_connection_version WHERE connection_id=${modelConnection.connectionID} AND version=${modelConnection.version}`
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
    const skillRevisionIDs = firstTurn
      ? agentTurnAuthorityInput.parse({
          mode: "build",
          modelId: firstTurn.modelId,
          skillRevisionIds: firstTurn.skillRevisionIds ?? [],
          conversationVersion: current.conversationVersion,
          requirementRevisionId: current.revisionID,
        }).skillRevisionIds
      : await skills.resolve("build", sql, { projectID: current.projectID, userID });
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
    const commits = await sql<Array<{ id: string }>>`SELECT id FROM factory.change_commit_operation
          WHERE change_id = ${changeID} AND state NOT IN ('succeeded', 'failed')`;
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
    } satisfies AgentTurnCommand;
    return turns.admitIn(
      sql,
      command,
      {
        mode: "build",
        submissionPolicy: "native",
        modelId: modelID,
        ...(modelConnection ? { modelConnection } : {}),
        ...(codingReasoning ? { codingReasoning } : {}),
        skillRevisionIds: skillRevisionIDs,
        requirementRevisionId: current.revisionID,
        conversationVersion: current.conversationVersion,
      },
      async (transaction, record) => {
        await claimAgentWriterIn(transaction, changeID, record.id);
        // A new human command owns recovery. The failed attempt and turn remain
        // immutable; runtime startup admits a new generation after safe cleanup.
        await transaction`UPDATE factory.change SET state='starting',failure=NULL,version=version+1
          WHERE id=${changeID} AND state='failed'`;
        if (input.kind === "change-repair" && !budget.allowed)
          await transaction`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${record.id},${budget.reason})`;
        if (input.kind === "change-prompt" && input.resume === true)
          await transaction`
          UPDATE factory.coding_pause pause SET resumed_by_turn_id=${record.id}
          FROM factory.agent_turn turn WHERE pause.turn_id=turn.id AND turn.change_id=${changeID}
            AND pause.resumed_by_turn_id IS NULL`;
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
        const knowledge = await buildKnowledgeContext(transaction, current.projectID, userPrompt);
        const criteria = z
          .object({ acceptanceCriteria: z.array(z.string()).min(1) })
          .parse(JSON.parse(current.canonicalContent)).acceptanceCriteria;
        const instructions = [
          userPrompt,
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
            ? invokedSkills(userPrompt, admittedSkills).map((revision) => ({
                id: nativeSkillId(revision),
              }))
            : [];
        await transaction`INSERT INTO factory.change_agent_turn_intent(
            turn_id, change_id, session_id, prompt_id, prompt_text, bootstrap, session_title, skill_loading, skill_manifest, skill_attachments
          ) VALUES (${record.id}, ${changeID}, ${current.sessionID ?? `ses_factory_${changeID.replaceAll("-", "")}`},
            ${`msg_factory_${record.id.replaceAll("-", "")}`}, ${prompt}, ${input.kind === "change-start"}, ${current.title}, ${skillLoading}, ${manifest === null ? null : JSON.stringify(manifest)}::jsonb, ${JSON.stringify(attachments)}::jsonb)`;
      },
    );
  }
  return {
    admitIn,
    async admit(changeID: string, userID: string, input: ChangeAgentInput) {
      return database.client.begin((sql) => admitIn(sql, changeID, userID, input));
    },
    async intent(turnID: string) {
      const rows = await database.client<
        Array<{
          turnID: string;
          changeID: string;
          sessionID: string;
          promptID: string;
          text: string;
          bootstrap: boolean;
          title: string;
          attemptID: string | null;
          skillLoading: "eager" | "native";
          skillManifest: unknown;
          skills: unknown;
          criteria: number;
          submissionPolicy: "native" | null;
        }>
      >`SELECT intent.turn_id AS "turnID", intent.change_id AS "changeID", intent.session_id AS "sessionID",
        intent.prompt_id AS "promptID", intent.prompt_text AS text, intent.bootstrap, intent.session_title AS title,
        intent.runtime_attempt_id AS "attemptID", intent.skill_loading AS "skillLoading",
        intent.skill_manifest AS "skillManifest", intent.skill_attachments AS skills,
        turn.authority->>'submissionPolicy' AS "submissionPolicy",
        jsonb_array_length(revision.canonical_content::jsonb->'acceptanceCriteria') AS criteria
        FROM factory.change_agent_turn_intent intent
        JOIN factory.agent_turn turn ON turn.id=intent.turn_id
        JOIN factory.requirement_revision revision ON revision.id=(turn.authority->>'requirementRevisionId')::uuid
        WHERE intent.turn_id = ${turnID}`;
      if (!rows[0]) throw new Error("Change Agent dispatch intent not found");
      return {
        ...rows[0],
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
