import type {
  AgentTurnAuthority,
  AgentTurnCommand,
  AgentTurnState,
} from "#conversation-domain/agent-turn";

// Turn history owns this record. Attachment admission only needs its pinned context.
export type AgentTurnRecord = {
  id: string;
  commandId: string;
  command: AgentTurnCommand;
  authority: AgentTurnAuthority;
  state: AgentTurnState;
  ownerToken: string | null;
  ownerExpiresAt: string | null;
  outcomeSummary: string | null;
};
