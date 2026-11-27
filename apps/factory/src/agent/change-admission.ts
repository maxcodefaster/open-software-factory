import type { AgentTurnCommand } from "#conversation-domain/agent-turn";
import type { ModelConnectionReference } from "#conversation-domain/model-connection";
import type { DatabaseTransaction } from "#db/client";
import { createSkillController } from "../skills/api";
import {
  type AdmissionDatabase,
  type AdmissionPhase,
  type ChangeAgentInput,
  type DefaultModelResolver,
  loadLockedChangeContextIn,
  parseChangeAgentInput,
  replayExistingCommandIn,
  transitionAdmissionPhase,
} from "./change-admission-context";
import {
  readTerminalObservation,
  readTurnDispatchIntent,
  recordAdmissionSideEffectsIn,
  saveTerminalCheckpoint,
} from "./change-admission-intent";
import { resolveAdmissionPolicyIn } from "./change-admission-policy";
import type { TerminalInput, TerminalOutcome } from "./terminal-outcome";
import { createAgentTurnStore } from "./turn-store";

export type { ChangeAgentInput };

export function createChangeAdmission(
  database: AdmissionDatabase,
  defaultModel: DefaultModelResolver,
  resolveConnection?: (sql: DatabaseTransaction) => Promise<ModelConnectionReference | undefined>,
) {
  const turns = createAgentTurnStore(database);
  const skills = createSkillController(database);

  async function admitIn(
    sql: DatabaseTransaction,
    changeID: string,
    userID: string,
    input: ChangeAgentInput,
  ) {
    let phase: AdmissionPhase = "validating";
    parseChangeAgentInput(input);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${input.commandId}`}))`;
    const replayed = await replayExistingCommandIn(sql, turns, changeID, userID, input);
    if (replayed) {
      phase = transitionAdmissionPhase(phase, "replayed");
      return replayed;
    }
    const current = await loadLockedChangeContextIn(sql, changeID, userID);
    phase = transitionAdmissionPhase(phase, "context-locked");
    const policy = await resolveAdmissionPolicyIn({
      database,
      sql,
      skills,
      defaultModel,
      resolveConnection,
      changeID,
      userID,
      input,
      current,
    });
    phase = transitionAdmissionPhase(phase, "policy-checked");
    const { resume: _resume, ...commandInput } = input as ChangeAgentInput & { resume?: boolean };
    const command = {
      ...commandInput,
      projectId: current.projectID,
      ticketId: current.ticketID,
      conversationId: current.conversationID,
      changeId: changeID,
      createdBy: userID,
      ...(current.contextID ? { contextId: current.contextID } : {}),
    } satisfies AgentTurnCommand;
    const admitted = await turns.admitIn(
      sql,
      command,
      {
        mode: "build",
        submissionPolicy: "native",
        browserTransport: "mcp",
        modelId: policy.modelID,
        ...(policy.modelConnection ? { modelConnection: policy.modelConnection } : {}),
        ...(policy.codingReasoning ? { codingReasoning: policy.codingReasoning } : {}),
        ...(policy.monitoringIncidentID
          ? { monitoringIncidentId: policy.monitoringIncidentID }
          : {}),
        skillRevisionIds: policy.assignedSkills.revisionIds,
        requiredSkillRevisionIds: policy.assignedSkills.requiredRevisionIds,
        requirementRevisionId: current.revisionID,
        conversationVersion: current.conversationVersion,
      },
      (transaction, record) =>
        recordAdmissionSideEffectsIn({
          transaction,
          record,
          changeID,
          userID,
          input,
          current,
          budget: policy.budget,
          admittedSkills: policy.admittedSkills,
          requiredSkillRevisionIds: policy.assignedSkills.requiredRevisionIds,
          nativeSkills: policy.nativeSkills,
        }),
    );
    phase = transitionAdmissionPhase(phase, "admitted");
    return admitted;
  }

  return {
    admitIn,
    terminalObservation: (input: TerminalInput) => readTerminalObservation(database, input),
    checkpointTerminal: (input: TerminalInput, ownerToken: string, value: TerminalOutcome) =>
      saveTerminalCheckpoint(turns, input, ownerToken, value),
    admit: (changeID: string, userID: string, input: ChangeAgentInput) =>
      database.client.begin((sql) => admitIn(sql, changeID, userID, input)),
    intent: (turnID: string) => readTurnDispatchIntent(database, turnID),
  };
}
