import { eq, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agentTurnCommandInput,
  changeAgentPromptInput,
  changeAgentRepairInput,
  changeAgentStartInput,
} from "#conversation-domain/agent-turn";
import type { CodingReasoning } from "#conversation-domain/model-settings";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { change, ticket, ticketConversation } from "#db/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { ensureConversationIn } from "../conversations/api";
import type { createAgentTurnStore } from "./turn-store";

export type AdmissionDatabase = ReturnType<typeof createDatabase>;

export type DefaultModelResolver =
  | string
  | ((
      sql: DatabaseTransaction,
      context: { projectID: string; userID: string; personal?: boolean },
    ) => Promise<string>);

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

export type ChangeContext = {
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

export type AdmissionPhase =
  | "validating"
  | "replayed"
  | "context-locked"
  | "policy-checked"
  | "admitted";

export const ADMISSION_PHASE_TRANSITIONS: Record<AdmissionPhase, readonly AdmissionPhase[]> = {
  validating: ["replayed", "context-locked"],
  replayed: [],
  "context-locked": ["policy-checked"],
  "policy-checked": ["admitted"],
  admitted: [],
};

export function canTransitionAdmissionPhase(from: AdmissionPhase, to: AdmissionPhase): boolean {
  return ADMISSION_PHASE_TRANSITIONS[from].includes(to);
}

export function transitionAdmissionPhase(from: AdmissionPhase, to: AdmissionPhase): AdmissionPhase {
  if (!canTransitionAdmissionPhase(from, to))
    throw new Error(`Invalid admission transition from ${from} to ${to}`);
  return to;
}

export function parseChangeAgentInput(input: ChangeAgentInput): void {
  if (input.kind === "change-start")
    changeAgentStartInput.parse({
      commandId: input.commandId,
      codingReasoning: input.codingReasoning,
    });
  else if (input.kind === "change-repair")
    changeAgentRepairInput.parse({ commandId: input.commandId, text: input.text });
  else changeAgentPromptInput.parse({ commandId: input.commandId, text: input.text });
}

export async function replayExistingCommandIn(
  sql: DatabaseTransaction,
  turns: ReturnType<typeof createAgentTurnStore>,
  changeID: string,
  userID: string,
  input: ChangeAgentInput,
) {
  const previous = await turns.getByCommand(input.commandId, sql);
  if (!previous) return null;
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

export async function loadLockedChangeContextIn(
  sql: DatabaseTransaction,
  changeID: string,
  userID: string,
): Promise<ChangeContext> {
  // Acquire locks before reading the approved revision. A joined statement
  // retains its pre-wait snapshot even after a concurrent writer commits.
  const db = drizzleTransaction(sql);
  const lockedChange = alias(change, "change");
  const lockedTicket = alias(ticket, "ticket");
  const locked = await db
    .select({ id: lockedChange.id })
    .from(lockedChange)
    .innerJoin(lockedTicket, eq(lockedTicket.id, lockedChange.ticketId))
    .where(eq(lockedChange.id, changeID))
    .for("update", { of: [lockedChange, lockedTicket] });
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
        AND EXISTS(SELECT 1 FROM factory.operation WHERE kind='delivery.branch_create' AND scope_type='change' AND scope_id=change.id::text AND state='succeeded')
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
  const conversations = await db
    .select({
      id: ticketConversation.id,
      mode: ticketConversation.mode,
      version: query<number>`${ticketConversation.version}::float8`,
      contextID: ticketConversation.activeCodingContextId,
    })
    .from(ticketConversation)
    .where(eq(ticketConversation.ticketId, rows[0].ticketID))
    .for("update");
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
