import { expect, test } from "bun:test";
import {
  type AgentTurnCommand,
  agentTurnBoundary,
  agentTurnCommandInput,
  assertAgentTurnAuthority,
  changeAgentPromptInput,
  changeAgentStartInput,
  changeAgentStopConfirmationInput,
} from "./agent-turn";

const command = {
  kind: "project-message",
  commandId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  createdBy: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  ticketId: null,
  text: "Investigate",
} satisfies AgentTurnCommand;

test("personal draft boundaries are user-owned; Ticket boundaries are shared", () => {
  const otherUser = { ...command, createdBy: crypto.randomUUID() };
  expect(agentTurnBoundary(otherUser)).not.toBe(agentTurnBoundary(command));
  const ticketId = crypto.randomUUID();
  expect(agentTurnBoundary({ ...otherUser, ticketId })).toBe(
    agentTurnBoundary({ ...command, ticketId }),
  );
  expect(agentTurnBoundary({ ...command, ticketId, projectId: crypto.randomUUID() })).not.toBe(
    agentTurnBoundary({ ...command, ticketId }),
  );
});

test("Build HTTP commands require stable identity and bounded strict input", () => {
  expect(changeAgentStartInput.safeParse({}).success).toBe(false);
  expect(changeAgentStartInput.parse({ commandId: command.commandId })).toEqual({
    commandId: command.commandId,
  });
  expect(
    changeAgentStartInput.parse({ commandId: command.commandId, codingReasoning: "high" })
      .codingReasoning,
  ).toBe("high");
  for (const codingReasoning of ["none", "low", "invalid"]) {
    expect(
      changeAgentStartInput.safeParse({ commandId: command.commandId, codingReasoning }).success,
    ).toBe(false);
  }
  expect(
    changeAgentPromptInput.safeParse({
      commandId: command.commandId,
      text: "Continue",
      codingReasoning: "high",
    }).success,
  ).toBe(false);
  expect(
    changeAgentPromptInput.parse({ commandId: command.commandId, text: "  Build this  " }).text,
  ).toBe("Build this");
  expect(
    changeAgentPromptInput.safeParse({ commandId: command.commandId, text: "x".repeat(8_001) })
      .success,
  ).toBe(false);
  expect(
    changeAgentPromptInput.safeParse({
      commandId: command.commandId,
      text: "Build",
      modelId: "unapproved",
    }).success,
  ).toBe(false);
});

test("turn inputs are bounded, strict and normalized", () => {
  expect(agentTurnCommandInput.parse({ ...command, text: "  Investigate  " })).toMatchObject({
    text: "Investigate",
  });
  expect(agentTurnCommandInput.safeParse({ ...command, text: "x".repeat(12_001) }).success).toBe(
    false,
  );
  expect(
    agentTurnCommandInput.safeParse({ ...command, arbitraryProvider: "unapproved" }).success,
  ).toBe(false);
});

test("Stop confirmation requires only the exact displayed Stop identity", () => {
  const stopId = crypto.randomUUID();
  expect(changeAgentStopConfirmationInput.parse({ stopId })).toEqual({ stopId });
  for (const input of [{}, { stopId: "invalid" }, { stopId, restart: true }])
    expect(changeAgentStopConfirmationInput.safeParse(input).success).toBe(false);
});

test("Project and Change authority cannot be relabeled into another role", () => {
  expect(() =>
    assertAgentTurnAuthority(command, {
      mode: "build",
      conversationVersion: null,
      modelId: "model",
      requirementRevisionId: crypto.randomUUID(),
    }),
  ).toThrow("do not match");
  expect(() =>
    assertAgentTurnAuthority(
      {
        ...command,
        kind: "project-answer",
        questionEntryId: crypto.randomUUID(),
        answer: { customText: "Answer", selectedOptionIds: [] },
      },
      { mode: "investigate", modelId: "model", conversationVersion: 1 },
    ),
  ).toThrow("Plan authority");
});
