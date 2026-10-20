import { z } from "zod";
import {
  type AgentTurnCommand,
  agentTurnCommandInput,
} from "../../../../packages/conversation-domain/src/agent-turn";
import {
  assertModeAuthority,
  type ConversationMode,
  type InterviewAnswer,
  interviewQuestionInput,
  normalizeInterviewAnswer,
  type ProjectAgentOutput,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import type { SkillRevision } from "../../../../packages/conversation-domain/src/skills";
import type { ProjectAgentProgress } from "../../../../packages/conversation-domain/src/turn-observation";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createAccessController, projectAuthorityIn } from "../access/controller";
import { readTurnObservation } from "../agent/turn-observation";
import {
  type AgentTurnRecord,
  type AgentTurnTransaction,
  createAgentTurnStore,
} from "../agent/turn-store";
import { createUsageObservations } from "../agent/usage-observations";
import type { ChangeView } from "../change/types";
import { CommandError } from "../command-error";
import { codeReadInput } from "../knowledge/code-read";
import type { createKnowledgeController } from "../knowledge/controller";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { knownModelRejection, ModelExecutionBoundError } from "../models/execution-policy";
import type { ResolvedModelConnection } from "../models/native";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { createSkillController } from "../skills/controller";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import { generateProjectResponse, projectModelConnection } from "./adapter";
import { ProjectContextLimitError } from "./context";
import {
  appendConversationEntry,
  type Citation,
  type ConversationEntry,
  type ConversationRow,
  lockConversation,
} from "./conversation-store";
import { persistProjectOutput } from "./effects";
import { createEpicConfirmation } from "./epic-confirmation";
import { canAdvanceInterviewRound } from "./interview-round";
import { isRequirementsInterview } from "./interview-intent";
import { readResearch, searchResearch } from "./research";
import { ProjectAgentOutputError } from "./structured-output";
import { admittedProjectContext, admittedTicketContext } from "./ticket-context";

export { projectAgentStructuredOutput, projectAgentStructuredOutputFor } from "./adapter";

type Database = ReturnType<typeof createDatabase>;
type ChangeController = {
  start(ticketID: string, userID: string): Promise<ChangeView | null>;
};
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
  changes: ChangeController,
  knowledge?: Pick<ReturnType<typeof createKnowledgeController>, "codePaths" | "code">,
) {
  const turns = createAgentTurnStore(database);
  const modelSettings = createModelSettingsController(database);
  const modelConnections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    process.env["FACTORY_AUTH_SECRET"] ?? "local-development-secret-change-before-production",
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [],
  );
  const skills = createSkillController(database);
  const usage = createUsageObservations();
  const progress = new Map<string, ProjectAgentProgress>();
  const recovering = new Set<string>();

  async function conversation(projectID: string, ticketID: string | undefined, userID: string) {
    const rows = await database.client<ConversationRow[]>`
      SELECT id, project_id AS "projectId", ticket_id AS "ticketId", mode,
        version::integer AS version
      FROM factory.ticket_conversation
      WHERE project_id = ${projectID}
        AND (
          (${ticketID ?? null}::uuid IS NULL AND ticket_id IS NULL AND created_by = ${userID})
          OR ticket_id = ${ticketID ?? null}
        )
      LIMIT 1
    `;
    return rows[0];
  }

  async function conversationByID(conversationID: string) {
    const rows = await database.client<ConversationRow[]>`
      SELECT id, project_id AS "projectId", ticket_id AS "ticketId", mode,
        version::integer AS version
      FROM factory.ticket_conversation WHERE id = ${conversationID}
    `;
    return rows[0];
  }

  async function ensureConversationIn(
    transaction: AgentTurnTransaction,
    projectID: string,
    ticketID: string | undefined,
    userID: string,
  ) {
    const key = `conversation:${projectID}:${ticketID ?? userID}`;
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const projects = await transaction<Array<{ id: string }>>`
      SELECT project.id FROM factory.project project
      LEFT JOIN factory.ticket ticket ON ticket.id = ${ticketID ?? null}
      WHERE project.id = ${projectID}
        AND (${ticketID ?? null}::uuid IS NULL OR (ticket.project_id = project.id AND ticket.converted_to_epic_id IS NULL))
    `;
    if (!projects[0]) throw new Error("Project or Ticket not found");
    const existing = await transaction<ConversationRow[]>`
      SELECT id, project_id AS "projectId", ticket_id AS "ticketId", mode, version::integer AS version
      FROM factory.ticket_conversation
      WHERE project_id = ${projectID} AND (
        (${ticketID ?? null}::uuid IS NULL AND ticket_id IS NULL AND created_by = ${userID})
        OR ticket_id = ${ticketID ?? null}
      ) LIMIT 1
    `;
    if (existing[0]) return existing[0];
    const rows = await transaction<ConversationRow[]>`
      INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, created_by)
      VALUES (${crypto.randomUUID()}, ${projectID}, ${ticketID ?? null}, ${userID})
      RETURNING id, project_id AS "projectId", ticket_id AS "ticketId", mode, version::integer AS version
    `;
    if (!rows[0]) throw new Error("Conversation could not be created");
    return rows[0];
  }

  async function ensureConversation(
    projectID: string,
    ticketID: string | undefined,
    userID: string,
  ) {
    return database.client.begin((transaction) =>
      ensureConversationIn(transaction, projectID, ticketID, userID),
    );
  }

  async function entries(conversationID: string) {
    return database.client<ConversationEntry[]>`
      SELECT id, ordinal::integer AS ordinal, kind, actor, mode, body, payload, citations,
        in_reply_to_entry_id AS "inReplyToEntryId",
        requirement_revision_id AS "requirementRevisionId", created_at AS "createdAt"
      FROM factory.conversation_entry
      WHERE conversation_id = ${conversationID}
      ORDER BY ordinal
    `;
  }

  async function appendEntry(
    conversationID: string,
    entry: Omit<ConversationEntry, "id" | "ordinal" | "createdAt"> & { createdBy?: string },
  ) {
    return database.client.begin((transaction) =>
      appendConversationEntry(transaction, conversationID, entry),
    );
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
    const rows = await database.client<Array<{ source: string; id: string }>>`
      SELECT 'knowledge'::text AS source, id FROM factory.knowledge_page
      WHERE project_id = ${projectID} AND state='active' AND id = ANY(${knowledgeIDs}::uuid[])
      UNION ALL
      SELECT 'ticket'::text AS source, id FROM factory.ticket
      WHERE project_id = ${projectID} AND trashed_at IS NULL AND state!='cancelled' AND converted_to_epic_id IS NULL AND id = ANY(${ticketIDs}::uuid[])
      UNION ALL SELECT 'epic',id FROM factory.epic WHERE project_id=${projectID} AND id=ANY(${epicIDs}::uuid[])
    `;
    const allowed = new Set(
      rows.map((row) => `${row.source}:${row.id}`).filter((key) => projectSources.has(key)),
    );
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
    const [history, turn] = await Promise.all([
      entries(current.id),
      readTurnObservation(database, { conversationID: current.id }),
    ]);
    return {
      ...current,
      entries: (await createAccessController(database).canDevelop(userID, current.projectId))
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

  async function admitProject(request: ProjectRequest) {
    return database.client.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${request.commandId}`}))`;
      // A proposal can bind a draft to a Ticket. Resolve replay before looking for a new draft.
      const previous = await turns.getByCommand(request.commandId, transaction);
      await projectAuthorityIn(
        transaction,
        request.createdBy,
        previous?.command.projectId ?? request.projectId,
      );
      if (previous) {
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
      const current = await ensureConversationIn(
        transaction,
        request.projectId,
        request.ticketId ?? undefined,
        request.createdBy,
      );
      if (current.mode === "build")
        throw new CommandError("conflict", "Build messages belong to the Change Agent");
      const command = agentTurnCommandInput.parse({ ...request, conversationId: current.id });
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
        const locked = await lockConversation(transaction, current.id);
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
              ...(ticketContext ? { ticketContext } : {}),
            },
            citations: [],
            inReplyToEntryId: null,
            requirementRevisionId: null,
            createdBy: command.createdBy,
          });
          return;
        }
        if (command.kind !== "project-answer") throw new Error("Project command required");
        const questions = await transaction<
          Array<{
            payload: { question?: unknown; visibility?: string };
            answered: boolean;
            superseded: boolean;
          }>
        >`
        SELECT question.payload, EXISTS(
          SELECT 1 FROM factory.conversation_entry answer
          WHERE answer.in_reply_to_entry_id = question.id AND answer.kind = 'answer'
        ) AS answered, EXISTS(SELECT 1 FROM factory.conversation_entry newer
          WHERE newer.conversation_id=question.conversation_id AND newer.ordinal>question.ordinal
            AND (newer.kind IN ('question','requirement') OR
              (newer.kind='user-message' AND coalesce(newer.payload->>'intent','')!='project-research'))) AS superseded
        FROM factory.conversation_entry question
        WHERE question.id = ${command.questionEntryId} AND question.conversation_id = ${current.id}
          AND question.kind = 'question'
      `;
        const found = questions[0];
        if (!found) throw new CommandError("conflict", "Interview question not found");
        if (found.payload.visibility === "developer") {
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
          interviewQuestionInput.parse(found.payload.question),
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
            ...(found.payload.visibility === "developer" ? { visibility: "developer" } : {}),
            ...(ticketContext ? { ticketContext } : {}),
          },
          citations: [],
          inReplyToEntryId: command.questionEntryId,
          requirementRevisionId: null,
          createdBy: command.createdBy,
        });
      });
    });
  }

  async function respond(record: AgentTurnRecord, observer?: ProjectResponseObserver) {
    const owner = await turns.claimPending(record.id);
    if (!owner?.ownerToken) return;
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
      history = await entries(command.conversationId);
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
              const current = await lockConversation(transaction, conversationID);
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
        : projectModelConnection();
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
    if (!(await turns.beginDispatch(owner.id, token))) {
      await turns.failPending(
        owner.id,
        token,
        "The conversation authority changed before dispatch.",
      );
      throw new CommandError("conflict", "The conversation changed before Agent dispatch");
    }
    const abort = new AbortController();
    const authorizeExecution = async () => {
      // Turn validation already checks live account and Project access inside
      // the same transaction as conversation ownership. Do not repeat it per token.
      if (!(await turns.validateExecution(owner.id, token)))
        throw new CommandError("conflict", "The Agent no longer owns this conversation authority");
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
    try {
      let output: ProjectAgentOutput;
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
      try {
        output = await generateProjectResponse({
          requirementsInterview: isRequirementsInterview(command, history),
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
          requiredSkillRevisionIds: authority.requiredSkillRevisionIds,
          skillsLoaded: async (revisionIDs) => {
            const owned = await turns.validateExecution(owner.id, token, async (sql) => {
              for (const revisionID of revisionIDs) {
                await sql`INSERT INTO factory.agent_turn_skill(turn_id, revision_id)
                  VALUES (${owner.id}, ${revisionID}) ON CONFLICT DO NOTHING`;
              }
            });
            if (!owned)
              throw new CommandError("conflict", "The Agent no longer owns this Skill load");
          },
          research: {
            authorize: authorizeExecution,
            search: observedSearch,
            read: async (source, id, offset, expectedVersion) => {
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
              return result;
            },
            ...(knowledge &&
            (await createAccessController(database).canDevelop(
              command.createdBy,
              command.projectId,
            ))
              ? {
                  code: {
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
                      );
                      codeRead = true;
                      return result;
                    },
                    read: async (value: Parameters<typeof knowledge.code>[1]) => {
                      const parsed = codeReadInput.parse(value);
                      const result = await knowledge.code(
                        command.projectId,
                        parsed,
                        command.createdBy,
                      );
                      codeRead = true;
                      readCodeSources.add(`${parsed.commitSha}:${parsed.path}`);
                      return result;
                    },
                  },
                }
              : {}),
          },
        });
      } catch (cause) {
        const lostAuthority = authorityFailure(cause) || authorityFailure(abort.signal.reason);
        const knownFailure =
          lostAuthority ||
          cause instanceof ProjectAgentOutputError ||
          cause instanceof ProjectContextLimitError ||
          cause instanceof ModelExecutionBoundError ||
          knownModelRejection(cause);
        await turns.settle(
          owner.id,
          token,
          knownFailure ? "failed" : "uncertain",
          lostAuthority
            ? "The Project Agent execution authority changed. Your input is saved; no response was published."
            : cause instanceof ProjectAgentOutputError || cause instanceof ProjectContextLimitError
              ? cause.message
              : knownFailure
                ? "The provider rejected this request or a configured bound was reached. Your input is saved."
                : "The provider outcome could not be established. The same command will not be submitted again.",
        );
        throw lostAuthority ?? cause;
      }
      try {
        output.citations = await validatedCitations(
          command.projectId,
          output.citations,
          command.createdBy,
          readCodeSources,
          projectSources,
        );
        const supported = new Set(output.citations.map((citation) => citation.reference));
        if (
          [...output.message.matchAll(/\[\^(\d+)\]/g)].some(
            (match) => !supported.has(Number(match[1])),
          )
        )
          throw new ProjectAgentOutputError();
        const settled = await turns.settle(
          owner.id,
          token,
          "completed",
          "Project Agent response saved.",
          (transaction) => persistProjectOutput(transaction, owner, output, codeRead),
        );
        if (!settled)
          throw new CommandError("conflict", "The Agent turn no longer owns this response");
      } catch (cause) {
        await turns.settle(
          owner.id,
          token,
          "failed",
          "The Agent response could not be applied under current authority.",
        );
        throw cause;
      }
    } finally {
      progress.delete(owner.id);
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
      for (;;) {
        const record = await turns.get(id);
        if (!record || record.authority.mode === "build" || "changeId" in record.command) return;
        if (record.state === "pending") {
          await respond(record);
          if ((await turns.get(id))?.state !== "pending") return;
        } else if (record.state === "dispatching" || record.state === "running") {
          if (await turns.quarantineExpiredProject(id)) {
            await createUsageJournal(database).abandon(`turn:${id}`);
            return;
          }
        } else return;
        const expiry = record.ownerExpiresAt
          ? new Date(record.ownerExpiresAt).getTime()
          : Date.now();
        await Bun.sleep(Math.max(25, Math.min(30_000, expiry - Date.now() + 25)));
      }
    } finally {
      recovering.delete(id);
    }
  }

  return {
    confirmEpic: createEpicConfirmation(database),
    async recover() {
      const pending = await database.client<Array<{ id: string }>>`SELECT id FROM factory.agent_turn
        WHERE change_id IS NULL AND state IN ('pending', 'dispatching', 'running') ORDER BY created_at`;
      for (const record of pending) {
        // respond records unavailable/failed/uncertain outcomes itself. A DB
        // failure leaves durable intent for the next startup, not a paid retry.
        void recoverTurn(record.id).catch(() => {});
      }
    },
    async get(projectID: string, ticketID: string | undefined, userID: string) {
      await createAccessController(database).requireProject(userID, projectID);
      return view(await conversation(projectID, ticketID, userID), userID);
    },
    async message(
      projectID: string,
      ticketID: string | undefined,
      text: string,
      userID: string,
      commandID: string,
      intent?: "requirements-interview" | "project-research",
      observer?: ProjectResponseObserver,
    ) {
      const { turn } = await admitProject({
        kind: "project-message",
        commandId: commandID,
        projectId: projectID,
        ticketId: ticketID ?? null,
        createdBy: userID,
        text,
        ...(intent ? { intent } : {}),
      });
      observer?.admitted(turn.id);
      await respond(turn, observer);
      if (!turn.command.conversationId) throw new Error("Project conversation required");
      await createAccessController(database).requireProject(userID, projectID);
      return view(await conversationByID(turn.command.conversationId), userID);
    },
    async answer(
      projectID: string,
      ticketID: string | undefined,
      questionEntryID: string,
      answer: InterviewAnswer,
      userID: string,
      commandID: string,
    ) {
      const { turn } = await admitProject({
        kind: "project-answer",
        commandId: commandID,
        projectId: projectID,
        ticketId: ticketID ?? null,
        createdBy: userID,
        questionEntryId: questionEntryID,
        answer,
      });
      await respond(turn);
      if (!turn.command.conversationId) throw new Error("Project conversation required");
      return view(await conversationByID(turn.command.conversationId), userID);
    },
    async setMode(
      projectID: string,
      ticketID: string | undefined,
      nextMode: ConversationMode,
      userID: string,
    ) {
      const current = await ensureConversation(projectID, ticketID, userID);
      const requirements = current.ticketId
        ? await database.client<Array<{ latestId: string | null; approvedId: string | null }>>`
            SELECT latest.id AS "latestId", approval.requirement_revision_id AS "approvedId"
            FROM (SELECT id FROM factory.requirement_revision WHERE ticket_id = ${current.ticketId}
              ORDER BY ordinal DESC LIMIT 1) latest
            LEFT JOIN factory.requirement_approval approval ON approval.ticket_id = ${current.ticketId}
          `
        : [];
      assertModeAuthority({
        nextMode,
        ticketId: current.ticketId,
        latestRequirementId: requirements[0]?.latestId ?? null,
        approvedRequirementId: requirements[0]?.approvedId ?? null,
      });
      if (nextMode === "build" && current.ticketId) await changes.start(current.ticketId, userID);
      if (current.mode !== nextMode) {
        await database.client`
          UPDATE factory.ticket_conversation SET mode = ${nextMode}, version = version + 1,
            updated_at = now() WHERE id = ${current.id}
        `;
        await appendEntry(current.id, {
          kind: "mode-change",
          actor: "system",
          mode: nextMode,
          body:
            nextMode === "build"
              ? "Build is ready from the approved Requirement Revision."
              : `Switched to ${nextMode}.`,
          payload: { from: current.mode, to: nextMode },
          citations: [],
          inReplyToEntryId: null,
          requirementRevisionId: null,
        });
      }
      return view(await conversationByID(current.id), userID);
    },
  };
}
