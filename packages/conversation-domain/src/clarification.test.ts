import { expect, test } from "bun:test";
import { clarificationAction, unansweredClarification } from "./clarification";

const question = { id: "q", ordinal: 1, kind: "question" };
test("ordinary research preserves a paused question; changed intent supersedes it", () => {
  const research = {
    id: "research",
    ordinal: 2,
    kind: "user-message",
    payload: { intent: "project-research" },
  };
  expect(unansweredClarification([question, research])).toBe(question);
  expect(unansweredClarification([question, { ...research, payload: {} }])).toBeUndefined();
  expect(
    unansweredClarification([
      question,
      { id: "a", ordinal: 2, kind: "answer", inReplyToEntryId: "q" },
    ]),
  ).toBeUndefined();
});
test("Ticket owns one restore action, while the active interview owns answering", () => {
  const input = { question: true, working: false, open: false, paused: false, started: true };
  expect(clarificationAction(input)).toEqual({ label: "Continue clarification", status: false });
  expect(clarificationAction({ ...input, open: true }).status).toBe(true);
  expect(clarificationAction({ ...input, open: true, paused: true })).toEqual({
    label: "Clarification paused",
    status: true,
  });
  expect(clarificationAction({ ...input, working: true }).label).toBe("Clarification in progress");
});
