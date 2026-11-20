import { factorySchema } from "./namespaces";

export const agentTurnState = factorySchema.enum("agent_turn_state", [
  "pending",
  "dispatching",
  "running",
  "completed",
  "failed",
  "stopped",
  "uncertain",
]);

export const branchOperationState = factorySchema.enum("branch_operation_state", [
  "pending",
  "executing",
  "ambiguous",
  "succeeded",
  "failed",
  "cancelled",
]);

export const changeAgentState = factorySchema.enum("change_agent_state", [
  "starting",
  "working",
  "waiting",
  "stopped",
  "failed",
  "committed",
]);

export const changeCommitSource = factorySchema.enum("change_commit_source", [
  "agent",
  "integration",
  "repository-document",
  "workspace",
]);

export const changeCommitState = factorySchema.enum("change_commit_state", [
  "commit-intended",
  "committed",
  "push-intended",
  "succeeded",
  "failed",
]);

export const changeState = factorySchema.enum("change_state", [
  "branch-pending",
  "starting",
  "active",
  "cancelling",
  "cancelled",
  "failed",
  "delivering",
  "delivered",
]);

export const conversationActor = factorySchema.enum("conversation_actor", [
  "user",
  "project-agent",
  "change-agent",
  "system",
]);

export const conversationEntryKind = factorySchema.enum("conversation_entry_kind", [
  "user-message",
  "agent-message",
  "question",
  "answer",
  "requirement",
  "mode-change",
]);

export const conversationMode = factorySchema.enum("conversation_mode", [
  "investigate",
  "plan",
  "build",
]);

export const workspaceKind = factorySchema.enum("development_workspace_kind", [
  "personal",
  "ticket",
]);

export const isolatedRuntimeKind = factorySchema.enum("isolated_runtime_kind", [
  "staging",
  "verification",
  "prebuild",
  "publication",
]);

export const knowledgeGenerationState = factorySchema.enum("knowledge_generation_state", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export const knowledgePageState = factorySchema.enum("knowledge_page_state", [
  "active",
  "archived",
]);

export const knowledgeRevisionKind = factorySchema.enum("knowledge_revision_kind", [
  "generated",
  "human",
  "proposed",
]);

export const mergeOperationState = factorySchema.enum("merge_operation_state", [
  "pending",
  "executing",
  "ambiguous",
  "succeeded",
  "failed",
]);

export const promotionOperationState = factorySchema.enum("promotion_operation_state", [
  "pending",
  "starting",
  "switching",
  "succeeded",
  "failed",
]);

export const pullRequestOperationState = factorySchema.enum("pull_request_operation_state", [
  "pending",
  "executing",
  "ambiguous",
  "succeeded",
  "failed",
]);

export const runtimeAttemptState = factorySchema.enum("runtime_attempt_state", [
  "create-intended",
  "starting",
  "ready",
  "stop-intended",
  "stopping",
  "stopped",
  "cleanup-failed",
  "failed",
  "pausing",
  "paused",
  "resuming",
]);

export const ticketState = factorySchema.enum("ticket_state", [
  "inbox",
  "backlog",
  "ready",
  "in-progress",
  "cancelled",
  "done",
]);

export const verificationState = factorySchema.enum("verification_state", [
  "pending",
  "runner-starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
