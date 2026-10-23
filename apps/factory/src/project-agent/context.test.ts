import { expect, test } from "bun:test";
import { ProjectContextLimitError, projectContextByteLimit, projectModelContext } from "./context";
import type { ConversationEntry } from "./conversation-store";

function entry(ordinal: number, values: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: crypto.randomUUID(),
    ordinal,
    kind: "user-message",
    actor: "user",
    mode: "plan",
    body: `decision-${ordinal}`,
    payload: {},
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdAt: "2026-10-13T00:00:00Z",
    ...values,
  };
}

test("current admitted input is identified by identity, not repeated text", () => {
  const prior = entry(1, { body: "yes" });
  const current = entry(2, {
    body: "yes",
    payload: {
      commandId: "operational-not-for-model",
      ticketContext: { title: "Current title" },
      projectContext: { project: { id: "frozen-project" } },
    },
  });
  const data = JSON.parse(
    projectModelContext({ prompt: "yes", history: [prior, current], inputEntryId: current.id }),
  );
  expect(data.conversation).toHaveLength(1);
  expect(data.conversation[0].id).toBe(prior.id);
  expect(data.currentInput.id).toBe(current.id);
  expect(data.frozenTicket.title).toBe("Current title");
  expect(data.frozenProject.project.id).toBe("frozen-project");
  expect(JSON.stringify(data)).not.toContain("operational-not-for-model");
});

test("retains long interviews, selected option identity, correction order and proposal provenance", () => {
  const question = entry(1, {
    actor: "project-agent",
    kind: "question",
    body: "Who can edit?",
    payload: {
      question: { options: [{ id: "reader", label: "Reader", description: "Read only" }] },
    },
  });
  const answer = entry(2, {
    kind: "answer",
    body: "Reader",
    inReplyToEntryId: question.id,
    payload: { selectedOptionIds: ["reader"], customText: "" },
  });
  const decisions = Array.from({ length: 30 }, (_, i) => entry(i + 3));
  const proposal = entry(33, {
    kind: "requirement",
    actor: "project-agent",
    body: "Proposal",
    payload: { requirement: { summary: "read only" } },
    citations: [{ source: "ticket", id: crypto.randomUUID(), label: "Original intent" }],
  });
  const current = entry(34, { body: "Correction: editors may change their own name" });
  const data = JSON.parse(
    projectModelContext({
      prompt: current.body,
      inputEntryId: current.id,
      history: [question, answer, ...decisions, proposal, current],
    }),
  );
  expect(
    data.conversation.find((e: { id: string }) => e.id === answer.id).payload.selectedOptionIds,
  ).toEqual(["reader"]);
  expect(data.conversation[0].payload.question.options[0].description).toBe("Read only");
  expect(data.conversation.filter((e: { actor: string }) => e.actor === "user")).toHaveLength(31);
  expect(data.conversation.at(-1).citations).toEqual(proposal.citations);
  expect(data.currentInput.text).toBe(current.body);
});

test("bounds background without silently discarding authored decisions", () => {
  const history = Array.from({ length: 10 }, (_, i) =>
    entry(i + 1, {
      actor: "project-agent",
      kind: "agent-message",
      body: "界".repeat(20_000),
    }),
  );
  const context = projectModelContext({ prompt: "Continue", history });
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(projectContextByteLimit);
  expect(JSON.parse(context).omittedBackgroundEntries).toBeGreaterThan(0);
  expect(() =>
    projectModelContext({ prompt: "Continue", history: [entry(1, { body: "界".repeat(40_000) })] }),
  ).toThrow(ProjectContextLimitError);
});

test("a current custom answer appears once with selected IDs and its question association", () => {
  const current = entry(2, {
    kind: "answer",
    body: "CURRENT_CUSTOM_SENTINEL",
    inReplyToEntryId: "question-id",
    payload: { selectedOptionIds: [], customText: "CURRENT_CUSTOM_SENTINEL" },
  });
  const context = projectModelContext({
    prompt: current.body,
    history: [current],
    inputEntryId: current.id,
  });
  expect(context.split("CURRENT_CUSTOM_SENTINEL")).toHaveLength(2);
  expect(JSON.parse(context).currentInput.inReplyToEntryId).toBe("question-id");
  expect(JSON.parse(context).currentInput.answer.hasCustomText).toBe(true);
});

test("committed Factory actions remain in core context when ordinary background is omitted", () => {
  const ticketID = crypto.randomUUID();
  const receipt = entry(1, {
    actor: "system",
    kind: "agent-message",
    body: "The requested Ticket was created.",
    payload: { factoryAction: { kind: "create-ticket", result: { id: ticketID, state: "ready" } } },
  });
  const background = Array.from({ length: 10 }, (_, index) =>
    entry(index + 2, {
      actor: "project-agent",
      kind: "agent-message",
      body: "Background".repeat(10_000),
    }),
  );
  const data = JSON.parse(
    projectModelContext({
      prompt: "Which ticket did you create?",
      history: [receipt, ...background],
    }),
  );
  expect(data.omittedBackgroundEntries).toBeGreaterThan(0);
  expect(
    data.conversation.find((value: { id: string }) => value.id === receipt.id).payload.factoryAction
      .result.id,
  ).toBe(ticketID);
});
