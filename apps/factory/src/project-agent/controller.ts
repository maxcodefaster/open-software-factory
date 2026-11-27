import { factorySigningSecret } from "#auth/signing-secret";
import type {
  ConversationMode,
  InterviewAnswer,
  PlanningIntent,
} from "#conversation-domain/conversation";
import type { ProjectAgentProgress } from "#conversation-domain/turn-observation";
import type { DatabaseTransaction } from "#db/client";
import { createAccessController } from "../access/api";
import type { AgentTurnRecord } from "../agent/turn-record";
import { createAgentTurnStore, createUsageObservations } from "../agent/turns-api";
import { CommandError } from "../command-error";
import { type ConversationRow, findConversation, readConversation } from "../conversations/api";
import type { createMCPConnections } from "../mcp/library-api";
import {
  createModelConnections,
  createModelSettingsController,
  createOpenBaoModelSecrets,
} from "../models/api";
import { createSkillController } from "../skills/api";
import {
  buildConversationView,
  createResearchContext,
  updateConversationMode,
} from "./conversation-view";
import { createEpicConfirmation } from "./epic-confirmation";
import { searchResearch } from "./research";
import { admitProjectTurn } from "./turn-admission";
import { executeProjectTurn } from "./turn-execution";
import { createTurnRecovery } from "./turn-recovery";
import type {
  ProjectAgentDatabase,
  ProjectKnowledgeTools,
  ProjectResponseObserver,
  RetainedMessagesReader,
} from "./turn-types";

export { projectAgentStructuredOutput, projectAgentStructuredOutputFor } from "./adapter";
export type { ProjectResponseObserver } from "./turn-types";

export async function searchProjectKnowledge(
  database: ProjectAgentDatabase,
  projectID: string,
  query: string,
  userID: string,
) {
  return searchResearch(database, projectID, userID, query, "knowledge");
}

export async function searchProjectTickets(
  database: ProjectAgentDatabase,
  projectID: string,
  query: string,
  userID: string,
) {
  return searchResearch(database, projectID, userID, query, "ticket");
}

export function createProjectAgentController(
  database: ProjectAgentDatabase,
  knowledge?: ProjectKnowledgeTools,
  mcp?: ReturnType<typeof createMCPConnections>,
  retainedMessages?: RetainedMessagesReader,
) {
  const access = createAccessController(database);
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

  const admissionDeps = { database, turns, modelSettings, modelConnections, skills };

  const recovery = createTurnRecovery({
    database,
    turns,
    lifetime,
    isClosed: () => closed,
    track,
    dispatch: (record) => respond(record),
  });

  const executionDeps = {
    database,
    access,
    turns,
    modelConnections,
    skills,
    usage,
    progress,
    responses,
    isClosed: () => closed,
    onDispatchStarted: (turnID: string) => recovery.observe(turnID),
    ...(knowledge ? { knowledge } : {}),
    ...(mcp ? { mcp } : {}),
  };

  const viewDeps = {
    database,
    access,
    usage,
    progress,
    ...(retainedMessages ? { retainedMessages } : {}),
  };

  function view(current: ConversationRow | undefined, userID: string) {
    return buildConversationView(viewDeps, current, userID);
  }

  function respond(record: AgentTurnRecord, observer?: ProjectResponseObserver) {
    if (closed) return Promise.resolve();
    return track(executeProjectTurn(executionDeps, record, observer));
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
      tx: DatabaseTransaction,
      input: {
        commandID: string;
        projectID: string;
        ticketID: string;
        userID: string;
        sourceCommit: string;
        contextID?: string;
      },
    ) {
      return admitProjectTurn(
        admissionDeps,
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
        tx,
      );
    },
    confirmEpic: createEpicConfirmation(database),
    recover: () => recovery.recoverAll(),
    async get(projectID: string, ticketID: string | undefined, userID: string, contextID?: string) {
      await access.requireProject(userID, projectID);
      const root = await findConversation(database, projectID, ticketID, userID);
      if (!root) return null;
      const full = await readConversation(database, root.id);
      return view(
        await readConversation(
          database,
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
      const id = await createResearchContext(database, projectID, ticketID, userID, commandID);
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
        await access.requireDevelopment(userID, projectID);
        const previous = await turns.getByCommand(commandID);
        sourceCommit =
          previous?.command.kind === "project-message" ? previous.command.sourceCommit : undefined;
        if (!sourceCommit) {
          if (!knowledge)
            throw new CommandError("unavailable", "Project code research is unavailable.");
          sourceCommit = (await knowledge.codePaths(projectID, "", userID)).commitSha;
        }
      }
      const { turn } = await admitProjectTurn(admissionDeps, {
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
      await access.requireProject(userID, projectID);
      return view(
        await readConversation(database, turn.command.conversationId, turn.command.contextId),
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
      const { turn } = await admitProjectTurn(admissionDeps, {
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
        await readConversation(database, turn.command.conversationId, turn.command.contextId),
        userID,
      );
    },
    async setMode(
      projectID: string,
      ticketID: string | undefined,
      nextMode: ConversationMode,
      userID: string,
    ) {
      const id = await updateConversationMode(database, projectID, ticketID, nextMode, userID);
      return view(await readConversation(database, id), userID);
    },
  };
}
