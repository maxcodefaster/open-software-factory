import { setTimeout as wait } from "node:timers/promises";
import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { factorySigningSecret } from "../../../../packages/auth/src/signing-secret";
import {
  type AgentTurnCommand,
  agentTurnCommandInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import { attachmentURL } from "../../../../packages/conversation-domain/src/attachments";
import {
  type ConversationMode,
  type InterviewAnswer,
  interviewQuestionInput,
  normalizeInterviewAnswer,
  type PlanningIntent,
  type ProjectAgentOutput,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import type { SkillRevision } from "../../../../packages/conversation-domain/src/skills";
import type { ProjectAgentProgress } from "../../../../packages/conversation-domain/src/turn-observation";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  agentTurnSkill,
  change,
  conversationEntry,
  epic,
  knowledgePage,
  mcpObservation,
  requirementApproval,
  technicalDesignRevision,
  ticket,
  ticketConversation,
} from "../../../../packages/db/src/schema";
import { technicalPlanningBaseInput } from "../../../../packages/requirement-domain/src/technical-design";
import {
  createAccessController,
  projectAuthorityIn,
  projectDevelopmentAuthorityIn,
} from "../access/controller";
import { readTurnObservation } from "../agent/turn-observation";
import { type AgentTurnRecord, createAgentTurnStore } from "../agent/turn-store";
import { createUsageObservations } from "../agent/usage-observations";
import { attachmentContextIn, readableAttachmentIn } from "../attachments/store";
import { createAttachmentTools } from "../attachments/tools";
import { CommandError } from "../command-error";
import {
  contextCommandIn,
  contextsIn,
  contextTranscriptIn,
  insertContextIn,
} from "../conversations/contexts";
import {
  appendConversationEntry,
  type Citation,
  type ConversationEntry,
  type ConversationRow,
  ensureConversationIn,
  findConversation,
  lockConversation,
  readConversation,
  readConversationEntries,
} from "../conversations/store";
import { reportFailure } from "../failure-log";
import { codeReadInput } from "../knowledge/code-read";
import type { createKnowledgeController } from "../knowledge/controller";
import { type LearningSourceArtifact, retainLearningArtifactsIn } from "../learning/artifacts";
import type { createMCPConnections } from "../mcp/connections";
import { mcpDigest } from "../mcp/controller";
import { connectFactoryMCP } from "../mcp/factory";
import { mcpSourceTools } from "../mcp/sources";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import {
  knownModelRejection,
  ModelExecutionBoundError,
  modelExecutionBound,
} from "../models/execution-policy";
import type { ResolvedModelConnection } from "../models/native";
import { installationPlanningConnection } from "../models/resolver";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { createSkillController } from "../skills/controller";
import { renderArchitectureDiagrams } from "../technical-design/diagrams";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import { generateProjectResponse } from "./adapter";
import { ProjectContextLimitError } from "./context";
import { persistProjectOutput } from "./effects";
import { createEpicConfirmation } from "./epic-confirmation";
import { isRequirementsInterview, planningRequest } from "./interview-intent";
import { canAdvanceInterviewRound } from "./interview-round";
import { readResearch, searchResearch } from "./research";
import { ProjectAgentOutputError } from "./structured-output";
import { admittedProjectContext, admittedTicketContext } from "./ticket-context";

export { projectAgentStructuredOutput, projectAgentStructuredOutputFor } from "./adapter";

type Database = ReturnType<typeof createDatabase>;
export type ProjectResponseObserver = {
  admitted(turnId: string): void;
  answerText(turnId: string, text: string): void;
};

function authorityFailure(cause: unknown) {
  let current = cause;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const error = current as Record<string, unknown>;
    // Native steps can preserve the name/code without the CommandError prototype.
    const code = error["code"];
    if (
      error["name"] === "CommandError" &&
      (code === "forbidden" || code === "not-found" || code === "conflict")
    )
      return new CommandError(
        code,
        typeof error["message"] === "string" ? error["message"] : "Project authority changed",
      );
    current = error["cause"];
  }
  return undefined;
}

export async function searchProjectKnowledge(
  database: Database,
  projectID: string,
  query: string,
  userID: string,
) {
  return searchResearch(database, projectID, userID, query, "knowledge");
}

export async function searchProjectTickets(
  database: Database,
  projectID: string,
  query: string,
  userID: string,
) {
  return searchResearch(database, projectID, userID, query, "ticket");
}

export function createProjectAgentController(
  database: Database,
  knowledge?: Pick<ReturnType<typeof createKnowledgeController>, "codePaths" | "code">,
  mcp?: ReturnType<typeof createMCPConnections>,
  retainedMessages?: (
    conversationID: string,
    contextID?: string,
  ) => Promise<{ messages: unknown[]; messagesAvailable: boolean } | undefined>,
) {
  const turns = createAgentTurnStore(database);
  const modelSettings = createModelSettingsController(database);
  const modelConnections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    factorySigningSecret(),
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [],
  );
  const skills = createSkillController(database);
  const usage = createUsageObservations();
  const progress = new Map<string, ProjectAgentProgress>();
  const recovering = new Set<string>();
  const pending = new Set<Promise<void>>();
  const responses = new Set<AbortController>();
  const lifetime = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  function track(work: Promise<void>) {
    pending.add(work);
    const settled = () => {
      pending.delete(work);
    };
    void work.then(settled, settled);
    return work;
  }

  async function conversation(projectID: string, ticketID: string | undefined, userID: string) {
    return findConversation(database, projectID, ticketID, userID);
  }

  async function conversationByID(conversationID: string, contextID?: string) {
    return readConversation(database, conversationID, contextID);
  }

  async function entries(conversationID: string, contextID?: string) {
    return readConversationEntries(database, conversationID, contextID);
  }

  async function validatedCitations(
    projectID: string,
    citations: Citation[],
    userID: string,
    readCodeSources: Set<string>,
    projectSources: Set<string>,
  ) {
    const parsed = citations.flatMap((value, index) => {
      const result = sourceCitationInput.safeParse(value);
      return result.success
        ? [{ ...result.data, reference: result.data.reference ?? index + 1 }]
        : [];
    });
    if (!parsed.length) return [];
    const knowledgeIDs = parsed
      .filter((value) => value.source === "knowledge")
      .map((value) => value.id);
    const ticketIDs = parsed.filter((value) => value.source === "ticket").map((value) => value.id);
    const epicIDs = parsed.filter((value) => value.source === "epic").map((value) => value.id);
    const rows = await database.db
      .select({ source: sql<string>`'knowledge'::text`, id: knowledgePage.id })
      .from(knowledgePage)
      .where(
        and(
          eq(knowledgePage.projectId, projectID),
          eq(knowledgePage.state, "active"),
          inArray(knowledgePage.id, knowledgeIDs),
        ),
      )
      .unionAll(
        database.db
          .select({ source: sql<string>`'ticket'::text`, id: ticket.id })
          .from(ticket)
          .where(
            and(
              eq(ticket.projectId, projectID),
              isNull(ticket.trashedAt),
              ne(ticket.state, "cancelled"),
              isNull(ticket.convertedToEpicId),
              inArray(ticket.id, ticketIDs),
            ),
          ),
      )
      .unionAll(
        database.db
          .select({ source: sql<string>`'epic'::text`, id: epic.id })
          .from(epic)
          .where(and(eq(epic.projectId, projectID), inArray(epic.id, epicIDs))),
      );
    const allowed = new Set(
      rows.map((row) => `${row.source}:${row.id}`).filter((key) => projectSources.has(key)),
    );
    for (const citation of parsed.filter((value) => value.source === "attachment")) {
      if (!projectSources.has(`attachment:${citation.id}`)) continue;
      const asset = await database.client.begin((sql) =>
        readableAttachmentIn(sql, userID, citation.id),
      );
      if (asset.projectId === projectID && asset.state === "ready")
        allowed.add(`attachment:${asset.id}`);
    }
    for (const citation of parsed.filter(
      (value) => value.source === "code" && value.id === projectID,
    )) {
      if (!knowledge || !readCodeSources.has(`${citation.commitSha}:${citation.path}`)) continue;
      await knowledge.code(
        projectID,
        { commitSha: citation.commitSha, path: citation.path, startLine: 1, lineCount: 1 },
        userID,
      );
      allowed.add(`code:${citation.id}:${citation.commitSha}:${citation.path}`);
    }
    return parsed.filter((value) =>
      allowed.has(
        value.source === "code"
          ? `code:${value.id}:${value.commitSha}:${value.path}`
          : `${value.source}:${value.id}`,
      ),
    );
  }

  async function view(current: ConversationRow | undefined, userID: string) {
    if (!current) return null;
    let developer = await createAccessController(database).canDevelop(userID, current.projectId);
    const [history, turn] = await Promise.all([
      entries(current.id, current.contextId),
      readTurnObservation(database, {
        conversationID: current.id,
        ...(current.contextId ? { contextID: current.contextId } : {}),
      }),
    ]);
    let codingHistory: unknown = null;
    if (
      developer &&
      current.mode === "build" &&
      (current.contextId ?? null) !== (current.activeCodingContextId ?? null)
    ) {
      const archive = await contextTranscriptIn(database.client, current.id, current.contextId);
      codingHistory = archive?.transcript ?? null;
      if (archive && archive.transcript["messagesAvailable"] !== true && retainedMessages) {
        const observed = await retainedMessages(current.id, current.contextId);
        if (observed) codingHistory = { ...archive.transcript, ...observed };
      }
    }
    await createAccessController(database).requireProject(userID, current.projectId);
    developer = await createAccessController(database).canDevelop(userID, current.projectId);
    if (!developer) codingHistory = null;
    return {
      ...current,
      contextId: current.contextId ?? null,
      activeCodingContextId: current.activeCodingContextId ?? null,
      contexts: await database.client.begin((sql) => contextsIn(sql, current.id)),
      codingHistory,
      isActiveCoding:
        current.mode === "build" &&
        (current.contextId ?? null) === (current.activeCodingContextId ?? null),
      entries: developer
        ? history
        : history.filter(
            (entry) =>
              entry.payload["visibility"] !== "developer" &&
              !entry.citations.some((citation) => citation.source === "code"),
          ),
      turn: turn
        ? {
            ...turn,
            usage: usage.get(turn.id),
            ...(progress.has(turn.id) ? { progress: progress.get(turn.id) } : {}),
          }
        : undefined,
    };
  }

  type ProjectRequest =
    | Omit<Extract<AgentTurnCommand, { kind: "project-message" }>, "conversationId">
    | Omit<Extract<AgentTurnCommand, { kind: "project-answer" }>, "conversationId">;

  async function admitProject(request: ProjectRequest, transaction?: DatabaseTransaction) {
    const admit = async (transaction: DatabaseTransaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${request.commandId}`}))`;
      // A proposal can bind a draft to a Ticket. Resolve replay before looking for a new draft.
      const previous = await turns.getByCommand(request.commandId, transaction);
      if (previous) {
        await projectAuthorityIn(transaction, request.createdBy, previous.command.projectId);
        if (previous.command.kind !== request.kind || previous.authority.mode === "build") {
          throw new CommandError(
            "conflict",
            "The Agent command identity was reused with different input",
          );
        }
        return turns.admitIn(
          transaction,
          agentTurnCommandInput.parse({
            ...request,
            conversationId: previous.command.conversationId,
          }),
          previous.authority,
        );
      }
      const root = await ensureConversationIn(
        transaction,
        request.projectId,
        request.ticketId ?? undefined,
        request.createdBy,
      );
      const current = request.contextId
        ? await lockConversation(transaction, root.id, request.contextId)
        : root;
      if (!current) throw new CommandError("conflict", "This conversation is read-only.");
      if (current.mode === "build")
        throw new CommandError("conflict", "Build messages belong to the Change Agent");
      const command = agentTurnCommandInput.parse({ ...request, conversationId: current.id });
      if (
        command.kind === "project-message" &&
        ["full-planning", "technical-planning"].includes(command.intent ?? "")
      ) {
        await projectDevelopmentAuthorityIn(transaction, command.createdBy, command.projectId);
        if (!command.ticketId || !command.sourceCommit || current.mode !== "plan")
          throw new CommandError(
            "conflict",
            "Technical Planning needs a selected Ticket and pinned source.",
          );
      }
      const modelId = await modelSettings.resolve("planning", transaction, {
        projectID: request.projectId,
        userID: request.createdBy,
      });
      const modelConnection = await modelConnections.reference("planning", transaction);
      const assignedSkills = await skills.resolveAssignment("planning", transaction, {
        projectID: request.projectId,
        userID: request.createdBy,
      });
      const authority = {
        mode: current.mode,
        conversationVersion: current.version,
        ...(modelConnection ? { modelConnection } : {}),
        modelId,
        skillRevisionIds: assignedSkills.revisionIds,
        requiredSkillRevisionIds: assignedSkills.requiredRevisionIds,
      };
      return turns.admitIn(transaction, command, authority, async (transaction, record) => {
        const locked = await lockConversation(transaction, current.id, request.contextId);
        if (!locked || locked.mode !== current.mode || locked.version !== current.version) {
          throw new CommandError("conflict", "The conversation changed before admission");
        }
        const ticketContext = await admittedTicketContext(
          transaction,
          command.projectId,
          command.ticketId,
        );
        const projectContext = await admittedProjectContext(
          transaction,
          command.projectId,
          command.ticketId,
        );
        if (command.kind === "project-message") {
          let technicalBase: z.infer<typeof technicalPlanningBaseInput> | undefined;
          if (command.intent === "technical-planning") {
            if (!command.ticketId) throw new Error("Technical Planning Ticket required");
            const db = drizzleTransaction(transaction);
            const [latest] = await db
              .select({ id: technicalDesignRevision.id })
              .from(technicalDesignRevision)
              .where(eq(technicalDesignRevision.ticketId, command.ticketId))
              .orderBy(desc(technicalDesignRevision.ordinal))
              .limit(1);
            const [scope] = await db
              .select({ id: requirementApproval.id })
              .from(requirementApproval)
              .where(eq(requirementApproval.ticketId, command.ticketId));
            if (!ticketContext?.revisionId || ticketContext.implementationAdmitted || scope)
              throw new CommandError(
                "conflict",
                "Save complete product requirements before Technical Planning.",
              );
            technicalBase = technicalPlanningBaseInput.parse({
              requestId: record.id,
              requirementRevisionId: ticketContext.revisionId,
              documentId: ticketContext.documentId,
              previousDesignId: latest?.id ?? null,
              sourceCommit: command.sourceCommit,
            });
          }
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
          return;
        }
        if (command.kind !== "project-answer") throw new Error("Project command required");
        const db = drizzleTransaction(transaction);
        const question = alias(conversationEntry, "question");
        const answer = alias(conversationEntry, "answer");
        const newer = alias(conversationEntry, "newer");
        const questions = await db
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
        const found = questions[0];
        if (!found) throw new CommandError("conflict", "Interview question not found");
        if (found.payload["visibility"] === "developer") {
          const { projectDevelopmentAuthorityIn } = await import("../access/controller");
          await projectDevelopmentAuthorityIn(transaction, command.createdBy, command.projectId);
        }
        if (found.answered)
          throw new CommandError("conflict", "Interview question was already answered");
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
      });
    };
    return transaction ? admit(transaction) : database.client.begin(admit);
  }

  function respond(record: AgentTurnRecord, observer?: ProjectResponseObserver) {
    if (closed) return Promise.resolve();
    return track(respondOwned(record, observer));
  }

  async function respondOwned(record: AgentTurnRecord, observer?: ProjectResponseObserver) {
    const owner = await turns.claimPending(record.id);
    if (!owner?.ownerToken) return;
    if (closed) {
      await turns.releasePending(owner.id, owner.ownerToken);
      return;
    }
    const token = owner.ownerToken;
    const { command, authority } = owner;
    if (
      !command.conversationId ||
      authority.mode === "build" ||
      (command.kind !== "project-message" && command.kind !== "project-answer")
    )
      throw new Error("Project turn required");
    const conversationID = command.conversationId;
    let connection: ResolvedModelConnection;
    let history: ConversationEntry[];
    let loadedSkills: SkillRevision[];
    try {
      history = await entries(command.conversationId, command.contextId);
      if (
        !(await createAccessController(database).canDevelop(command.createdBy, command.projectId))
      )
        history = history.filter(
          (entry) =>
            entry.payload["visibility"] !== "developer" &&
            !entry.citations.some((citation) => citation.source === "code"),
        );
      if (command.kind === "project-answer") {
        const question = history.find((entry) => entry.id === command.questionEntryId);
        const parsed = z
          .array(interviewQuestionInput)
          .safeParse(question?.payload["roundQuestions"]);
        const index = question?.payload["roundIndex"];
        const next =
          parsed.success && typeof index === "number" ? parsed.data[index + 1] : undefined;
        const answeredQuestion = interviewQuestionInput.safeParse(question?.payload["question"]);
        if (
          question &&
          next &&
          answeredQuestion.success &&
          canAdvanceInterviewRound(answeredQuestion.data, command.answer)
        ) {
          if (!(await turns.beginDispatch(owner.id, token)))
            throw new CommandError("conflict", "Interview authority changed");
          await turns.settle(
            owner.id,
            token,
            "completed",
            "Answer saved. Next question ready.",
            async (transaction) => {
              const current = await lockConversation(
                transaction,
                conversationID,
                command.contextId,
              );
              if (!current || current.version !== authority.conversationVersion)
                throw new CommandError("conflict", "Interview changed");
              await appendConversationEntry(transaction, current.id, {
                kind: "question",
                actor: "project-agent",
                mode: "plan",
                body: next.prompt,
                payload: {
                  question: next,
                  ...(question.payload["visibility"] === "developer"
                    ? { visibility: "developer" }
                    : {}),
                  roundId: question.payload["roundId"],
                  roundQuestions: parsed.data,
                  roundIndex: Number(index) + 1,
                },
                citations: [],
                inReplyToEntryId: null,
                requirementRevisionId: null,
                ...(command.contextId ? { contextId: command.contextId } : {}),
              });
            },
          );
          return;
        }
      }
      connection = authority.modelConnection
        ? await modelConnections.resolve(
            authority.modelConnection.connectionID,
            authority.modelConnection.version,
          )
        : installationPlanningConnection();
      loadedSkills = await skills.load(authority.skillRevisionIds);
    } catch (cause) {
      await turns.failPending(
        owner.id,
        token,
        "Project Agent unavailable before dispatch. Your input is saved.",
      );
      throw cause;
    }
    const input = history.find((entry) => entry.payload["commandId"] === command.commandId);
    if (!input) {
      await turns.failPending(owner.id, token, "The admitted Project input could not be found.");
      throw new Error("Admitted Project input missing");
    }
    const request = planningRequest(command, history);
    const technicalPlanning =
      request?.payload["intent"] === "technical-planning"
        ? technicalPlanningBaseInput.parse(request.payload["technicalBase"])
        : undefined;
    if (!(await turns.beginDispatch(owner.id, token))) {
      await turns.failPending(
        owner.id,
        token,
        "The conversation authority changed before dispatch.",
      );
      throw new CommandError("conflict", "The conversation changed before Agent dispatch");
    }
    const abort = new AbortController();
    responses.add(abort);
    if (closed) abort.abort();
    const authorizeExecution = async () => {
      abort.signal.throwIfAborted();
      // Turn validation already checks live account and Project access inside
      // the same transaction as conversation ownership. Do not repeat it per token.
      if (!(await turns.validateExecution(owner.id, token)))
        throw new CommandError("conflict", "The Agent no longer owns this conversation authority");
      if (technicalPlanning)
        await createAccessController(database).requireDevelopment(
          command.createdBy,
          command.projectId,
        );
    };
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewal) return;
      renewal = turns
        .renew(owner.id, token)
        .then((owned) => {
          if (!owned)
            abort.abort(new CommandError("conflict", "The Agent execution authority changed"));
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, 10_000);
    timer.unref();
    // Observe normal dispatches too, not only work found at process startup.
    // A provider promise may outlive its lease, or settlement may correctly
    // refuse an expired owner. Neither may leave the UI busy indefinitely.
    void track(recoverTurn(owner.id)).catch(reportFailure("Project agent turn recovery"));
    try {
      let output: ProjectAgentOutput;
      const learningArtifacts: LearningSourceArtifact[] = [];
      let codeRead = history.some(
        (entry) =>
          entry.payload["visibility"] === "developer" ||
          entry.citations.some((citation) => citation.source === "code"),
      );
      const readCodeSources = new Set(
        history.flatMap((entry) =>
          entry.citations
            .filter((citation) => citation.source === "code")
            .map((citation) => `${citation.commitSha}:${citation.path}`),
        ),
      );
      const projectSources = new Set(
        history.flatMap((entry) =>
          entry.citations.map((citation) => `${citation.source}:${citation.id}`),
        ),
      );
      if (command.ticketId) projectSources.add(`ticket:${command.ticketId}`);
      async function observedSearch(query: string, source?: "knowledge" | "ticket" | "epic") {
        const hits = await searchResearch(
          database,
          command.projectId,
          command.createdBy,
          query,
          source,
        );
        return hits;
      }
      let factoryMCP: Awaited<ReturnType<typeof connectFactoryMCP>> | undefined;
      try {
        const attachmentTools = createAttachmentTools(database);
        const observedRead = async (
          source: "knowledge" | "ticket" | "epic",
          id: string,
          offset?: number,
          expectedVersion?: number,
        ) => {
          const result = await readResearch(
            database,
            command.projectId,
            command.createdBy,
            source,
            id,
            offset,
            expectedVersion,
          );
          projectSources.add(`${source}:${id}`);
          if (learningArtifacts.length < 3)
            learningArtifacts.push({
              reference: `${source}:${id}:v${result.version}`,
              body: result.body,
              truncated: result.truncated || (offset ?? 0) > 0,
            });
          await attachmentTools.discover(
            owner.id,
            token,
            (result.attachments ?? []).map((id) => attachmentURL(id)).join("\n"),
          );
          return result;
        };
        factoryMCP = await connectFactoryMCP({
          database,
          turn: owner,
          ownerToken: token,
          signal: abort.signal,
          authorize: authorizeExecution,
          created: (id) => projectSources.add(`ticket:${id}`),
          search: ({ query, source }) => observedSearch(query, source),
          read: ({ source, id, offset, expectedVersion }) =>
            observedRead(source, id, offset, expectedVersion),
        });
        output = await generateProjectResponse({
          factoryTools: factoryMCP.tools,
          attachmentContext: await database.client.begin((sql) =>
            attachmentContextIn(sql, owner.id),
          ),
          attachmentRead: async (call) => {
            const result = await attachmentTools.call(owner.id, token, call);
            if (call.name === "attachment_read")
              projectSources.add(`attachment:${call.arguments.id}`);
            return result;
          },
          requirementsInterview: isRequirementsInterview(command, history),
          ...(technicalPlanning ? { technicalPlanning } : {}),
          mode:
            command.kind === "project-message" && command.intent === "project-research"
              ? "investigate"
              : authority.mode,
          modelId: authority.modelId,
          connection,
          prompt: input.body,
          inputEntryId: input.id,
          history,
          signal: abort.signal,
          usageObserved: (observation) => usage.record(owner.id, observation),
          progress: (value) => progress.set(owner.id, value),
          ...(observer &&
          command.kind === "project-message" &&
          command.intent !== "requirements-interview"
            ? {
                answerText: async (text: string) => {
                  if (codeRead)
                    await createAccessController(database).requireDevelopment(
                      command.createdBy,
                      command.projectId,
                    );
                  observer.answerText(owner.id, text);
                },
              }
            : {}),
          usageSink: recordedMastraUsage(database, {
            id: `turn:${owner.id}`,
            projectID: command.projectId,
            userID: command.createdBy,
            purpose:
              authority.mode === "plan" &&
              !(command.kind === "project-message" && command.intent === "project-research")
                ? "requirements"
                : "research",
            provider: connection.provider ?? "openai",
            model: authority.modelId,
          }),
          skills: loadedSkills,
          mcpTools: mcp
            ? await mcpSourceTools(
                mcp,
                owner.id,
                command.projectId,
                command.createdBy,
                async () => {
                  if (!(await turns.validateExecution(owner.id, token)))
                    throw new CommandError(
                      "forbidden",
                      "MCP lookup no longer owns this conversation",
                    );
                },
                abort.signal,
                async (connectionId, tool, digest, result) => {
                  const current = await turns.validateExecution(owner.id, token, async (sql) => {
                    await drizzleTransaction(sql)
                      .insert(mcpObservation)
                      .values({
                        id: crypto.randomUUID(),
                        turnId: owner.id,
                        connectionId,
                        toolName: tool,
                        toolDigest: digest,
                        resultDigest: mcpDigest(result.content),
                        isError: result.isError,
                      });
                  });
                  if (!current)
                    throw new CommandError(
                      "forbidden",
                      "MCP observation no longer owns this conversation",
                    );
                },
              )
            : [],
          requiredSkillRevisionIds: authority.requiredSkillRevisionIds,
          skillsLoaded: async (revisionIDs) => {
            const owned = await turns.validateExecution(owner.id, token, async (sql) => {
              for (const revisionID of revisionIDs) {
                await drizzleTransaction(sql)
                  .insert(agentTurnSkill)
                  .values({ turnId: owner.id, revisionId: revisionID })
                  .onConflictDoNothing();
              }
            });
            if (!owned)
              throw new CommandError("conflict", "The Agent no longer owns this Skill load");
          },
          research: {
            authorize: authorizeExecution,
            search: observedSearch,
            read: observedRead,
            ...(knowledge &&
            (await createAccessController(database).canDevelop(
              command.createdBy,
              command.projectId,
            ))
              ? {
                  code: {
                    projectID: command.projectId,
                    authorize: () =>
                      createAccessController(database).requireDevelopment(
                        command.createdBy,
                        command.projectId,
                      ),
                    paths: async (query: string) => {
                      const result = await knowledge.codePaths(
                        command.projectId,
                        query,
                        command.createdBy,
                        technicalPlanning?.sourceCommit,
                      );
                      codeRead = true;
                      return result;
                    },
                    read: async (value: Parameters<typeof knowledge.code>[1]) => {
                      const parsed = codeReadInput.parse(value);
                      if (technicalPlanning && parsed.commitSha !== technicalPlanning.sourceCommit)
                        throw new CommandError(
                          "conflict",
                          "Read the source pinned to this Technical Planning task.",
                        );
                      const result = await knowledge.code(
                        command.projectId,
                        parsed,
                        command.createdBy,
                      );
                      codeRead = true;
                      readCodeSources.add(`${parsed.commitSha}:${parsed.path}`);
                      if (learningArtifacts.length < 3)
                        learningArtifacts.push({
                          reference: `code:${parsed.commitSha}:${parsed.path}:${parsed.startLine}`,
                          body: result.body,
                          truncated: result.truncated,
                        });
                      return result;
                    },
                  },
                }
              : {}),
          },
        });
      } catch (cause) {
        const lostAuthority = authorityFailure(cause) || authorityFailure(abort.signal.reason);
        const bound = modelExecutionBound(cause);
        const knownFailure =
          lostAuthority ||
          cause instanceof ProjectAgentOutputError ||
          cause instanceof ProjectContextLimitError ||
          cause instanceof ModelExecutionBoundError ||
          knownModelRejection(cause);
        const summary = lostAuthority
          ? "The Project Agent execution authority changed. Your input is saved; no response was published."
          : cause instanceof ProjectAgentOutputError
            ? cause.retainedMessage
            : cause instanceof ProjectContextLimitError
              ? cause.message
              : bound
                ? `The model ${bound === "input" ? "input limit" : "request allowance"} was reached before the next provider request. Your input is saved. No additional provider request was started.`
                : knownFailure
                  ? "The provider rejected this request or a configured bound was reached. Your input is saved."
                  : "The provider outcome could not be established. The same command will not be submitted again.";
        await turns.settle(owner.id, token, knownFailure ? "failed" : "uncertain", summary);
        if (!lostAuthority && bound) throw new CommandError("unavailable", summary);
        throw lostAuthority ?? cause;
      } finally {
        await factoryMCP?.close();
      }
      let publicationStep = "source validation";
      try {
        output.citations = await validatedCitations(
          command.projectId,
          output.citations,
          command.createdBy,
          readCodeSources,
          projectSources,
        );
        publicationStep = "technical source validation";
        if (
          output.kind === "technical-design" &&
          (!technicalPlanning ||
            !output.citations.some((citation) => citation.source === "code") ||
            output.citations.some(
              (citation) =>
                citation.source === "code" && citation.commitSha !== technicalPlanning.sourceCommit,
            ))
        )
          throw new ProjectAgentOutputError();
        publicationStep = "architecture diagram rendering";
        const technical =
          output.kind === "technical-design" && technicalPlanning
            ? {
                base: technicalPlanning,
                renders: await renderArchitectureDiagrams(output.design, { allowUnrendered: true }),
              }
            : undefined;
        publicationStep = "citation reference validation";
        const supported = new Set(output.citations.map((citation) => citation.reference));
        if (
          [...output.message.matchAll(/\[\^(\d+)\]/g)].some(
            (match) => !supported.has(Number(match[1])),
          )
        )
          throw new ProjectAgentOutputError();
        publicationStep = "saving the response";
        const settled = await turns.settle(
          owner.id,
          token,
          "completed",
          "Project Agent response saved.",
          async (transaction) => {
            await persistProjectOutput(
              transaction,
              owner,
              output,
              codeRead || Boolean(technicalPlanning),
              technical,
              request?.payload["intent"] === "full-planning"
                ? String(request.payload["sourceCommit"])
                : undefined,
            );
            await retainLearningArtifactsIn(transaction, owner, learningArtifacts);
          },
        );
        if (!settled)
          throw new CommandError("conflict", "The Agent turn no longer owns this response");
      } catch (cause) {
        await turns.settle(
          owner.id,
          token,
          "failed",
          cause instanceof ProjectAgentOutputError
            ? `${cause.retainedMessage} Step: ${publicationStep}.`
            : cause instanceof CommandError
              ? cause.message
              : `The Agent response could not be saved during ${publicationStep}. Your input is retained.`,
        );
        // Keep diagnostics content-free. Provider/generated content and raw SDK
        // errors may contain private source or credentials.
        console.error("Project response publication failed", {
          turnID: owner.id,
          step: publicationStep,
          category:
            cause instanceof ProjectAgentOutputError
              ? "invalid-output"
              : cause instanceof CommandError
                ? cause.code
                : "persistence-or-renderer",
        });
        throw cause;
      }
    } finally {
      progress.delete(owner.id);
      responses.delete(abort);
      clearInterval(timer);
      await renewal;
    }
  }

  async function recoverTurn(id: string) {
    if (recovering.has(id)) return;
    recovering.add(id);
    try {
      // A live owner may outlast the first observation window. Recheck at its
      // lease boundary until terminal, without stealing work or polling each second.
      // SQL remains authoritative if clocks drift or another owner renews the lease.
      while (!closed) {
        try {
          const record = await turns.get(id);
          if (!record || record.authority.mode === "build" || "changeId" in record.command) return;
          if (record.state === "pending") {
            // Dispatch is tracked independently. Awaiting a provider here would
            // stop this very watcher from observing its lost lease.
            void respond(record).catch(reportFailure("Project agent dispatch"));
          } else if (record.state === "dispatching" || record.state === "running") {
            if (await turns.quarantineExpiredProject(id)) {
              await createUsageJournal(database).abandon(`turn:${id}`);
              return;
            }
          } else return;
          const expiry = record.ownerExpiresAt
            ? new Date(record.ownerExpiresAt).getTime()
            : Date.now();
          await wait(Math.max(25, Math.min(30_000, expiry - Date.now() + 25)), undefined, {
            signal: lifetime.signal,
          });
        } catch {
          // A failed observation is not a terminal result. Keep observing the
          // same identity at the existing lease cadence, never replay dispatch.
          if (!closed) await wait(30_000, undefined, { signal: lifetime.signal }).catch(() => {});
        }
      }
    } finally {
      recovering.delete(id);
    }
  }

  return {
    shutdown() {
      closed = true;
      lifetime.abort();
      for (const response of responses) response.abort();
      closing ??= (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      })();
      return closing;
    },
    async admitTechnicalIn(
      sql: DatabaseTransaction,
      input: {
        commandID: string;
        projectID: string;
        ticketID: string;
        userID: string;
        sourceCommit: string;
        contextID?: string;
      },
    ) {
      return admitProject(
        {
          kind: "project-message",
          commandId: input.commandID,
          projectId: input.projectID,
          ticketId: input.ticketID,
          createdBy: input.userID,
          intent: "technical-planning",
          sourceCommit: input.sourceCommit,
          text: "Prepare the technical design for the confirmed product specification.",
          ...(input.contextID ? { contextId: input.contextID } : {}),
        },
        sql,
      );
    },
    confirmEpic: createEpicConfirmation(database),
    async recover() {
      if (closed) return;
      const pending = await database.db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .where(
          and(
            isNull(agentTurn.changeId),
            inArray(agentTurn.state, ["pending", "dispatching", "running"]),
          ),
        )
        .orderBy(asc(agentTurn.createdAt));
      for (const record of pending) {
        // respond records unavailable/failed/uncertain outcomes itself. A DB
        // failure leaves durable intent for the next startup, not a paid retry.
        if (!closed)
          void track(recoverTurn(record.id)).catch(reportFailure("Project agent turn recovery"));
      }
    },
    async get(projectID: string, ticketID: string | undefined, userID: string, contextID?: string) {
      await createAccessController(database).requireProject(userID, projectID);
      const root = await conversation(projectID, ticketID, userID);
      if (!root) return null;
      const full = await conversationByID(root.id);
      return view(
        await conversationByID(
          root.id,
          contextID === "original"
            ? undefined
            : (contextID ?? full?.activeCodingContextId ?? undefined),
        ),
        userID,
      );
    },
    async newConversation(
      projectID: string,
      ticketID: string | undefined,
      userID: string,
      commandID: string,
    ) {
      const id = await database.client.begin(async (sql) => {
        const root = await ensureConversationIn(sql, projectID, ticketID, userID);
        await lockConversation(sql, root.id);
        const previous = await contextCommandIn(sql, {
          conversationID: root.id,
          commandID,
          createdBy: userID,
          kind: "research",
        });
        if (previous) return previous;
        const id = crypto.randomUUID();
        await insertContextIn(sql, {
          id,
          conversationID: root.id,
          commandID,
          kind: "research",
          title: "New conversation",
          createdBy: userID,
          mode: ticketID && root.mode === "build" ? "investigate" : "plan",
        });
        return id;
      });
      return this.get(projectID, ticketID, userID, id);
    },
    async message(
      projectID: string,
      ticketID: string | undefined,
      text: string,
      userID: string,
      commandID: string,
      intent?: PlanningIntent,
      observer?: ProjectResponseObserver,
      contextID?: string,
    ) {
      let sourceCommit: string | undefined;
      if (intent === "full-planning" || intent === "technical-planning") {
        await createAccessController(database).requireDevelopment(userID, projectID);
        const previous = await turns.getByCommand(commandID);
        sourceCommit =
          previous?.command.kind === "project-message" ? previous.command.sourceCommit : undefined;
        if (!sourceCommit) {
          if (!knowledge)
            throw new CommandError("unavailable", "Project code research is unavailable.");
          sourceCommit = (await knowledge.codePaths(projectID, "", userID)).commitSha;
        }
      }
      const { turn } = await admitProject({
        kind: "project-message",
        commandId: commandID,
        projectId: projectID,
        ticketId: ticketID ?? null,
        createdBy: userID,
        text,
        ...(intent ? { intent } : {}),
        ...(sourceCommit ? { sourceCommit } : {}),
        ...(contextID ? { contextId: contextID } : {}),
      });
      observer?.admitted(turn.id);
      await respond(turn, observer);
      if (!turn.command.conversationId) throw new Error("Project conversation required");
      await createAccessController(database).requireProject(userID, projectID);
      return view(
        await conversationByID(turn.command.conversationId, turn.command.contextId),
        userID,
      );
    },
    async answer(
      projectID: string,
      ticketID: string | undefined,
      questionEntryID: string,
      answer: InterviewAnswer,
      userID: string,
      commandID: string,
      contextID?: string,
    ) {
      const { turn } = await admitProject({
        kind: "project-answer",
        commandId: commandID,
        projectId: projectID,
        ticketId: ticketID ?? null,
        createdBy: userID,
        questionEntryId: questionEntryID,
        answer,
        ...(contextID ? { contextId: contextID } : {}),
      });
      await respond(turn);
      if (!turn.command.conversationId) throw new Error("Project conversation required");
      return view(
        await conversationByID(turn.command.conversationId, turn.command.contextId),
        userID,
      );
    },
    async setMode(
      projectID: string,
      ticketID: string | undefined,
      nextMode: ConversationMode,
      userID: string,
    ) {
      if (nextMode === "build")
        throw new CommandError(
          "conflict",
          "Use Implement to approve the exact saved requirements and start Coding.",
        );
      const id = await database.client.begin(async (transaction) => {
        const scope = await ensureConversationIn(transaction, projectID, ticketID, userID);
        const current = await lockConversation(transaction, scope.id);
        if (!current) throw new CommandError("not-found", "Conversation not found");
        const db = drizzleTransaction(transaction);
        const [coding] = current.ticketId
          ? await db
              .select({ id: change.id })
              .from(change)
              .where(eq(change.ticketId, current.ticketId))
          : [];
        if (coding)
          throw new CommandError(
            "conflict",
            "This Ticket keeps its Coding conversation. Use Ask about this Project for separate research.",
          );
        if (current.mode !== nextMode) {
          await db
            .update(ticketConversation)
            .set({
              mode: nextMode,
              version: sql<number>`${ticketConversation.version}+1`,
              updatedAt: sql<Date>`now()`,
            })
            .where(eq(ticketConversation.id, current.id));
          await appendConversationEntry(transaction, current.id, {
            kind: "mode-change",
            actor: "system",
            mode: nextMode,
            body: `Switched to ${nextMode}.`,
            payload: { from: current.mode, to: nextMode },
            citations: [],
            inReplyToEntryId: null,
            requirementRevisionId: null,
          });
        }
        return current.id;
      });
      return view(await conversationByID(id), userID);
    },
  };
}
