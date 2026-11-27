import type { AgentTurnCommand } from "#conversation-domain/agent-turn";
import type { ProjectAgentProgress } from "#conversation-domain/turn-observation";
import type { createDatabase } from "#db/client";
import type { createAccessController } from "../access/api";
import type { createAgentTurnStore, createUsageObservations } from "../agent/turns-api";
import type { ConversationEntry } from "../conversations/api";
import type { createKnowledgeController } from "../knowledge/api";
import type { createMCPConnections } from "../mcp/library-api";
import type { createModelConnections, createModelSettingsController } from "../models/api";
import type { createSkillController } from "../skills/api";

export type ProjectAgentDatabase = ReturnType<typeof createDatabase>;

export type ProjectResponseObserver = {
  admitted(turnId: string): void;
  answerText(turnId: string, text: string): void;
};

export type ProjectKnowledgeTools = Pick<
  ReturnType<typeof createKnowledgeController>,
  "codePaths" | "code"
>;

export type RetainedMessagesReader = (
  conversationID: string,
  contextID?: string,
) => Promise<{ messages: unknown[]; messagesAvailable: boolean } | undefined>;

export type ProjectTurnRequest =
  | Omit<Extract<AgentTurnCommand, { kind: "project-message" }>, "conversationId">
  | Omit<Extract<AgentTurnCommand, { kind: "project-answer" }>, "conversationId">;

export type ProjectTurnAdmissionDeps = {
  database: ProjectAgentDatabase;
  turns: ReturnType<typeof createAgentTurnStore>;
  modelSettings: ReturnType<typeof createModelSettingsController>;
  modelConnections: ReturnType<typeof createModelConnections>;
  skills: ReturnType<typeof createSkillController>;
};

export type ProjectTurnExecutionDeps = {
  database: ProjectAgentDatabase;
  access: ReturnType<typeof createAccessController>;
  turns: ReturnType<typeof createAgentTurnStore>;
  modelConnections: ReturnType<typeof createModelConnections>;
  skills: ReturnType<typeof createSkillController>;
  usage: ReturnType<typeof createUsageObservations>;
  progress: Map<string, ProjectAgentProgress>;
  responses: Set<AbortController>;
  isClosed: () => boolean;
  onDispatchStarted: (turnID: string) => void;
  knowledge?: ProjectKnowledgeTools;
  mcp?: ReturnType<typeof createMCPConnections>;
};

export function filterVisibleEntries(history: ConversationEntry[], developer: boolean) {
  if (developer) return history;
  return history.filter(
    (entry) =>
      entry.payload["visibility"] !== "developer" &&
      !entry.citations.some((citation) => citation.source === "code"),
  );
}
