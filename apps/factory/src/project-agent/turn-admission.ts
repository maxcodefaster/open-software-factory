import { and, desc, eq, exists, gt, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { type AgentTurnCommand, agentTurnCommandInput } from "#conversation-domain/agent-turn";
import {
  interviewQuestionInput,
  normalizeInterviewAnswer,
} from "#conversation-domain/conversation";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { conversationEntry, requirementApproval, technicalDesignRevision } from "#db/schema";
import { technicalPlanningBaseInput } from "#requirement-domain/technical-design";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import type { AgentTurnRecord } from "../agent/turn-record";
import { CommandError } from "../command-error";
import {
  appendConversationEntry,
  type ConversationRow,
  ensureConversationIn,
  lockConversation,
} from "../conversations/api";
import { admittedProjectContext, admittedTicketContext } from "./ticket-context";
import type { ProjectTurnAdmissionDeps, ProjectTurnRequest } from "./turn-types";

type AdmittedTicketContext = Awaited<ReturnType<typeof admittedTicketContext>>;
type AdmittedProjectContext = Awaited<ReturnType<typeof admittedProjectContext>>;
type ProjectMessageCommand = Extract<AgentTurnCommand, { kind: "project-message" }>;
type ProjectAnswerCommand = Extract<AgentTurnCommand, { kind: "project-answer" }>;

async function resolveTechnicalPlanningBase(
  transaction: DatabaseTransaction,
  ticketID: string | null,
  turnID: string,
  sourceCommit: string | undefined,
  ticketContext: AdmittedTicketContext,
): Promise<z.infer<typeof technicalPlanningBaseInput>> {
  if (!ticketID) throw new Error("Technical Planning Ticket required");
  const db = drizzleTransaction(transaction);
  const [latest] = await db
    .select({ id: technicalDesignRevision.id })
    .from(technicalDesignRevision)
    .where(eq(technicalDesignRevision.ticketId, ticketID))
    .orderBy(desc(technicalDesignRevision.ordinal))
    .limit(1);
  const [scope] = await db
    .select({ id: requirementApproval.id })
    .from(requirementApproval)
    .where(eq(requirementApproval.ticketId, ticketID));
  if (!ticketContext?.revisionId || ticketContext.implementationAdmitted || scope)
    throw new CommandError(
      "conflict",
      "Save complete product requirements before Technical Planning.",
    );
  return technicalPlanningBaseInput.parse({
    requestId: turnID,
    requirementRevisionId: ticketContext.revisionId,
    documentId: ticketContext.documentId,
    previousDesignId: latest?.id ?? null,
    sourceCommit,
  });
}

async function admitMessageEntry(
  transaction: DatabaseTransaction,
  current: ConversationRow,
  record: AgentTurnRecord,
  command: ProjectMessageCommand,
  projectContext: AdmittedProjectContext,
  ticketContext: AdmittedTicketContext,
) {
  const technicalBase =
    command.intent === "technical-planning"
      ? await resolveTechnicalPlanningBase(
          transaction,
          command.ticketId,
          record.id,
          command.sourceCommit,
          ticketContext,
        )
      : undefined;

  await appendConversationEntry(transaction, current.id, {
    kind: "user-message",
    actor: "user",
    mode: current.mode,
    body: command.text,
    payload: {
      commandId: command.commandId,
      turnId: record.id,
      projectContext,
      ...(command.intent ? { intent: command.intent } : {}),
      ...(command.sourceCommit
        ? { sourceCommit: command.sourceCommit, visibility: "developer" }
        : {}),
      ...(technicalBase ? { technicalBase } : {}),
      ...(ticketContext ? { ticketContext } : {}),
    },
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdBy: command.createdBy,
    ...(command.contextId ? { contextId: command.contextId } : {}),
  });
}

async function admitAnswerEntry(
  transaction: DatabaseTransaction,
  current: ConversationRow,
  record: AgentTurnRecord,
  command: ProjectAnswerCommand,
  projectContext: AdmittedProjectContext,
  ticketContext: AdmittedTicketContext,
) {
  const db = drizzleTransaction(transaction);
  const question = alias(conversationEntry, "question");
  const answer = alias(conversationEntry, "answer");
  const newer = alias(conversationEntry, "newer");
  const [found] = await db
    .select({
      payload: question.payload,
      answered: exists(
        db
          .select({ id: answer.id })
          .from(answer)
          .where(and(eq(answer.inReplyToEntryId, question.id), eq(answer.kind, "answer"))),
      ),
      superseded: exists(
        db
          .select({ id: newer.id })
          .from(newer)
          .where(
            and(
              eq(newer.conversationId, question.conversationId),
              gt(newer.ordinal, question.ordinal),
              sql<boolean>`${newer.payload}->>'contextId' IS NOT DISTINCT FROM ${question.payload}->>'contextId'`,
              or(
                inArray(newer.kind, ["question", "requirement"]),
                and(
                  eq(newer.kind, "user-message"),
                  sql<boolean>`coalesce(${newer.payload}->>'intent','')!='project-research'`,
                ),
              ),
            ),
          ),
      ),
    })
    .from(question)
    .where(
      and(
        eq(question.id, command.questionEntryId),
        eq(question.conversationId, current.id),
        eq(question.kind, "question"),
        sql<boolean>`${question.payload}->>'contextId' IS NOT DISTINCT FROM ${command.contextId ?? null}`,
      ),
    );

  if (!found) throw new CommandError("conflict", "Interview question not found");
  if (found.payload["visibility"] === "developer")
    await projectDevelopmentAuthorityIn(transaction, command.createdBy, command.projectId);
  if (found.answered) throw new CommandError("conflict", "Interview question was already answered");
  if (found.superseded)
    throw new CommandError(
      "conflict",
      "The Interview direction changed. Answer the current question instead.",
    );

  const normalized = normalizeInterviewAnswer(
    interviewQuestionInput.parse(found.payload["question"]),
    command.answer,
  );
  await appendConversationEntry(transaction, current.id, {
    kind: "answer",
    actor: "user",
    mode: "plan",
    body: normalized.labels.join(", "),
    payload: {
      ...normalized,
      commandId: command.commandId,
      turnId: record.id,
      projectContext,
      ...(found.payload["visibility"] === "developer" ? { visibility: "developer" } : {}),
      ...(ticketContext ? { ticketContext } : {}),
    },
    citations: [],
    inReplyToEntryId: command.questionEntryId,
    requirementRevisionId: null,
    createdBy: command.createdBy,
    ...(command.contextId ? { contextId: command.contextId } : {}),
  });
}

export async function admitProjectTurn(
  deps: ProjectTurnAdmissionDeps,
  request: ProjectTurnRequest,
  transaction?: DatabaseTransaction,
) {
  const { database, turns, modelSettings, modelConnections, skills } = deps;
  const admit = async (tx: DatabaseTransaction) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${request.commandId}`}))`;
    // A proposal can bind a draft to a Ticket. Resolve replay before looking for a new draft.
    const previous = await turns.getByCommand(request.commandId, tx);
    if (previous) {
      await projectAuthorityIn(tx, request.createdBy, previous.command.projectId);
      if (previous.command.kind !== request.kind || previous.authority.mode === "build") {
        throw new CommandError(
          "conflict",
          "The Agent command identity was reused with different input",
        );
      }
      return turns.admitIn(
        tx,
        agentTurnCommandInput.parse({
          ...request,
          conversationId: previous.command.conversationId,
        }),
        previous.authority,
      );
    }

    const root = await ensureConversationIn(
      tx,
      request.projectId,
      request.ticketId ?? undefined,
      request.createdBy,
    );
    const current = request.contextId
      ? await lockConversation(tx, root.id, request.contextId)
      : root;
    if (!current) throw new CommandError("conflict", "This conversation is read-only.");
    if (current.mode === "build")
      throw new CommandError("conflict", "Build messages belong to the Change Agent");

    const command = agentTurnCommandInput.parse({ ...request, conversationId: current.id });
    if (
      command.kind === "project-message" &&
      (command.intent === "full-planning" || command.intent === "technical-planning")
    ) {
      await projectDevelopmentAuthorityIn(tx, command.createdBy, command.projectId);
      if (!command.ticketId || !command.sourceCommit || current.mode !== "plan")
        throw new CommandError(
          "conflict",
          "Technical Planning needs a selected Ticket and pinned source.",
        );
    }

    const scope = { projectID: request.projectId, userID: request.createdBy };
    const modelId = await modelSettings.resolve("planning", tx, scope);
    const modelConnection = await modelConnections.reference("planning", tx);
    const assignedSkills = await skills.resolveAssignment("planning", tx, scope);
    const authority = {
      mode: current.mode,
      conversationVersion: current.version,
      ...(modelConnection ? { modelConnection } : {}),
      modelId,
      skillRevisionIds: assignedSkills.revisionIds,
      requiredSkillRevisionIds: assignedSkills.requiredRevisionIds,
    };

    return turns.admitIn(tx, command, authority, async (admitTx, record) => {
      const locked = await lockConversation(admitTx, current.id, request.contextId);
      if (!locked || locked.mode !== current.mode || locked.version !== current.version)
        throw new CommandError("conflict", "The conversation changed before admission");

      const ticketContext = await admittedTicketContext(
        admitTx,
        command.projectId,
        command.ticketId,
      );
      const projectContext = await admittedProjectContext(
        admitTx,
        command.projectId,
        command.ticketId,
      );

      if (command.kind === "project-message") {
        await admitMessageEntry(admitTx, current, record, command, projectContext, ticketContext);
        return;
      }
      if (command.kind !== "project-answer") throw new Error("Project command required");
      await admitAnswerEntry(admitTx, current, record, command, projectContext, ticketContext);
    });
  };
  return transaction ? admit(transaction) : database.client.begin(admit);
}
