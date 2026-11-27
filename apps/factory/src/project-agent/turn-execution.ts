import { z } from "zod";
import { interviewQuestionInput, type ProjectAgentOutput } from "#conversation-domain/conversation";
import type { SkillRevision } from "#conversation-domain/skills";
import { technicalPlanningBaseInput } from "#requirement-domain/technical-design";
import type { AgentTurnRecord } from "../agent/turn-record";
import type { createAgentTurnStore } from "../agent/turns-api";
import { CommandError } from "../command-error";
import {
  appendConversationEntry,
  type ConversationEntry,
  lockConversation,
  readConversationEntries,
} from "../conversations/api";
import type { ResolvedModelConnection } from "../models/inference-contracts";
import { installationPlanningConnection } from "../models/resolver";
import { recordedMastraUsage } from "../usage/record-mastra";
import { generateProjectResponse } from "./adapter";
import { isRequirementsInterview, planningRequest } from "./interview-intent";
import { canAdvanceInterviewRound } from "./interview-round";
import { classifyExecutionFailure, publishProjectOutput } from "./turn-publication";
import {
  assembleTurnTools,
  createTurnObservationState,
  type ProjectTurnCommand,
} from "./turn-tools";
import {
  filterVisibleEntries,
  type ProjectResponseObserver,
  type ProjectTurnExecutionDeps,
} from "./turn-types";

async function tryAdvanceInterviewRound(
  turns: ReturnType<typeof createAgentTurnStore>,
  owner: AgentTurnRecord,
  token: string,
  command: ProjectTurnCommand,
  conversationID: string,
  history: ConversationEntry[],
) {
  if (command.kind !== "project-answer") return false;
  const question = history.find((entry) => entry.id === command.questionEntryId);
  const parsed = z.array(interviewQuestionInput).safeParse(question?.payload["roundQuestions"]);
  const index = question?.payload["roundIndex"];
  const next = parsed.success && typeof index === "number" ? parsed.data[index + 1] : undefined;
  const answeredQuestion = interviewQuestionInput.safeParse(question?.payload["question"]);
  if (
    !question ||
    !next ||
    !answeredQuestion.success ||
    !canAdvanceInterviewRound(answeredQuestion.data, command.answer)
  )
    return false;

  if (!(await turns.beginDispatch(owner.id, token)))
    throw new CommandError("conflict", "Interview authority changed");
  await turns.settle(
    owner.id,
    token,
    "completed",
    "Answer saved. Next question ready.",
    async (transaction) => {
      const current = await lockConversation(transaction, conversationID, command.contextId);
      if (!current || current.version !== owner.authority.conversationVersion)
        throw new CommandError("conflict", "Interview changed");
      await appendConversationEntry(transaction, current.id, {
        kind: "question",
        actor: "project-agent",
        mode: "plan",
        body: next.prompt,
        payload: {
          question: next,
          ...(question.payload["visibility"] === "developer" ? { visibility: "developer" } : {}),
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
  return true;
}

function startLeaseRenewal(
  turns: ReturnType<typeof createAgentTurnStore>,
  ownerID: string,
  token: string,
  abort: AbortController,
) {
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewal) return;
    renewal = turns
      .renew(ownerID, token)
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
  return async () => {
    clearInterval(timer);
    await renewal;
  };
}

export async function executeProjectTurn(
  deps: ProjectTurnExecutionDeps,
  record: AgentTurnRecord,
  observer?: ProjectResponseObserver,
) {
  const { database, access, turns, modelConnections, skills, usage, progress, responses } = deps;
  const owner = await turns.claimPending(record.id);
  if (!owner?.ownerToken) return;
  if (deps.isClosed()) {
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
    const rawHistory = await readConversationEntries(database, conversationID, command.contextId);
    const canDevelop = await access.canDevelop(command.createdBy, command.projectId);
    history = filterVisibleEntries(rawHistory, canDevelop);
    if (await tryAdvanceInterviewRound(turns, owner, token, command, conversationID, history))
      return;
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
    await turns.failPending(owner.id, token, "The conversation authority changed before dispatch.");
    throw new CommandError("conflict", "The conversation changed before Agent dispatch");
  }

  const abort = new AbortController();
  responses.add(abort);
  if (deps.isClosed()) abort.abort();

  const authorizeExecution = async () => {
    abort.signal.throwIfAborted();
    // Turn validation already checks live account and Project access inside
    // the same transaction as conversation ownership. Do not repeat it per token.
    if (!(await turns.validateExecution(owner.id, token)))
      throw new CommandError("conflict", "The Agent no longer owns this conversation authority");
    if (technicalPlanning) await access.requireDevelopment(command.createdBy, command.projectId);
  };

  const stopLeaseRenewal = startLeaseRenewal(turns, owner.id, token, abort);
  // Observe normal dispatches too, not only work found at process startup.
  // A provider promise may outlive its lease, or settlement may correctly
  // refuse an expired owner. Neither may leave the UI busy indefinitely.
  deps.onDispatchStarted(owner.id);

  try {
    const state = createTurnObservationState(history, command.ticketId);
    const isResearchMessage =
      command.kind === "project-message" && command.intent === "project-research";
    let output: ProjectAgentOutput;
    let tools: Awaited<ReturnType<typeof assembleTurnTools>> | undefined;
    try {
      tools = await assembleTurnTools(deps, {
        owner,
        token,
        command,
        signal: abort.signal,
        authorizeExecution,
        ...(technicalPlanning ? { technicalPlanning } : {}),
        state,
      });
      output = await generateProjectResponse({
        factoryTools: tools.factoryTools,
        attachmentContext: tools.attachmentContext,
        attachmentRead: tools.attachmentRead,
        mcpTools: tools.mcpTools,
        skillsLoaded: tools.skillsLoaded,
        research: tools.research,
        requirementsInterview: isRequirementsInterview(command, history),
        ...(technicalPlanning ? { technicalPlanning } : {}),
        mode: isResearchMessage ? "investigate" : authority.mode,
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
                if (state.codeRead)
                  await access.requireDevelopment(command.createdBy, command.projectId);
                observer.answerText(owner.id, text);
              },
            }
          : {}),
        usageSink: recordedMastraUsage(database, {
          id: `turn:${owner.id}`,
          projectID: command.projectId,
          userID: command.createdBy,
          purpose: authority.mode === "plan" && !isResearchMessage ? "requirements" : "research",
          provider: connection.provider ?? "openai",
          model: authority.modelId,
        }),
        skills: loadedSkills,
        requiredSkillRevisionIds: authority.requiredSkillRevisionIds,
      });
    } catch (cause) {
      const classified = classifyExecutionFailure(cause, abort.signal.reason);
      await turns.settle(owner.id, token, classified.status, classified.summary);
      throw classified.errorToThrow;
    } finally {
      await tools?.close();
    }

    await publishProjectOutput(
      { database, turns, ...(deps.knowledge ? { knowledge: deps.knowledge } : {}) },
      {
        owner,
        token,
        output,
        codeRead: state.codeRead,
        ...(technicalPlanning ? { technicalPlanning } : {}),
        ...(request?.payload["intent"] === "full-planning"
          ? { fullPlanningSourceCommit: String(request.payload["sourceCommit"]) }
          : {}),
        readCodeSources: state.readCodeSources,
        projectSources: state.projectSources,
        learningArtifacts: state.learningArtifacts,
      },
    );
  } finally {
    progress.delete(owner.id);
    responses.delete(abort);
    await stopLeaseRenewal();
  }
}
