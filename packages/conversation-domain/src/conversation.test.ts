import { describe, expect, test } from "bun:test";
import {
  assertModeAuthority,
  conversationMessageInput,
  interviewAnswerCommandInput,
  interviewQuestionInput,
  normalizeInterviewAnswer,
} from "./conversation";

test("agent execution commands require caller-owned identity", () => {
  expect(conversationMessageInput.safeParse({ text: "Investigate" }).success).toBe(false);
  expect(
    conversationMessageInput.parse({ text: "  Investigate  ", commandId: crypto.randomUUID() })
      .text,
  ).toBe("Investigate");
  expect(
    interviewAnswerCommandInput.safeParse({
      questionEntryId: crypto.randomUUID(),
      answer: { customText: "Answer" },
    }).success,
  ).toBe(false);
});
test("an explicit Interview action requires a Ticket but grants no new mode authority", () => {
  const request = {
    commandId: crypto.randomUUID(),
    text: "Start Interview",
    intent: "requirements-interview",
  };
  expect(conversationMessageInput.safeParse(request).success).toBe(false);
  expect(
    conversationMessageInput.safeParse({ ...request, ticketId: crypto.randomUUID() }).success,
  ).toBe(true);
  expect(
    conversationMessageInput.safeParse({ ...request, ticketId: crypto.randomUUID(), mode: "build" })
      .success,
  ).toBe(false);
});

describe("Conversation Mode authority", () => {
  test("keeps checkout-free modes independent from a Ticket", () => {
    expect(() => assertModeAuthority({ nextMode: "investigate" })).not.toThrow();
    expect(() => assertModeAuthority({ nextMode: "plan" })).not.toThrow();
  });

  test("gates Build on approval of the latest exact revision", () => {
    expect(() =>
      assertModeAuthority({
        nextMode: "build",
        ticketId: "ticket",
        latestRequirementId: "revision-2",
        approvedRequirementId: "revision-1",
      }),
    ).toThrow("latest Requirement Revision");
    expect(() =>
      assertModeAuthority({
        nextMode: "build",
        ticketId: "ticket",
        latestRequirementId: "revision-2",
        approvedRequirementId: "revision-2",
      }),
    ).not.toThrow();
  });
});

describe("Requirements Interview answers", () => {
  const question = {
    type: "multi-select" as const,
    prompt: "Which clients matter?",
    options: [
      { id: "desktop", label: "Desktop", description: "" },
      { id: "mobile", label: "Mobile", description: "" },
    ],
    allowCustom: true,
  };

  for (const type of ["single-select", "multi-select"] as const)
    test(`${type} rejects duplicate option identities before an answer can change meaning`, () => {
      const duplicate = {
        ...question,
        type,
        options: [
          { id: "access", label: "Read only", description: "Never allow editing" },
          { id: "access", label: "Editable", description: "Allow editing" },
        ],
      };
      expect(interviewQuestionInput.safeParse(duplicate).success).toBe(false);
      expect(() =>
        normalizeInterviewAnswer(duplicate, { selectedOptionIds: ["access"], customText: "" }),
      ).toThrow("unique");
      const valid = {
        ...duplicate,
        options: [duplicate.options[0]!, { ...duplicate.options[1]!, id: "edit" }],
      };
      expect(
        normalizeInterviewAnswer(valid, { selectedOptionIds: ["access"], customText: "" }).labels,
      ).toEqual(["Read only"]);
    });

  test("keeps selected labels and a custom answer", () => {
    expect(
      normalizeInterviewAnswer(question, {
        selectedOptionIds: ["desktop", "desktop"],
        customText: "Kiosk",
      }),
    ).toEqual({
      selectedOptionIds: ["desktop"],
      customText: "Kiosk",
      labels: ["Desktop", "Kiosk"],
    });
  });

  test("rejects options that were not asked", () => {
    expect(() =>
      normalizeInterviewAnswer(question, { selectedOptionIds: ["server"], customText: "" }),
    ).toThrow("unknown option");
  });

  test("requires a choice or custom answer", () => {
    expect(() =>
      normalizeInterviewAnswer(question, { selectedOptionIds: [], customText: "" }),
    ).toThrow("answer is required");
  });

  test("keeps single-select custom text exclusive", () => {
    expect(() =>
      normalizeInterviewAnswer(
        {
          ...question,
          type: "single-select",
        },
        { selectedOptionIds: ["desktop"], customText: "Kiosk" },
      ),
    ).toThrow("option or write a custom answer");
  });

  test("accepts free text without selectable values", () => {
    expect(
      normalizeInterviewAnswer(
        { type: "free-text", prompt: "What stays out?", placeholder: "Non-goals" },
        { selectedOptionIds: [], customText: "No runtime changes" },
      ),
    ).toEqual({
      selectedOptionIds: [],
      customText: "No runtime changes",
      labels: ["No runtime changes"],
    });
  });
});
