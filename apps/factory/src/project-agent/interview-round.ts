import type {
  InterviewAnswer,
  InterviewQuestion,
} from "../../../../packages/conversation-domain/src/conversation";

// Declared independent choices are safe to advance without inference. A custom
// choice leaves that declaration; explicit corrections of free text also replan.
// This is a conservative dispatch rule, not a semantic classifier.
export function canAdvanceInterviewRound(question: InterviewQuestion, answer: InterviewAnswer) {
  if (question.type !== "free-text" && answer.customText) return false;
  return !/(?:^|[.!?]\s*)(?:actually\b|instead\b|correction\b|change (?:of )?direction\b|forget (?:that|the)\b|on second thought\b|korrektur\b|stattdessen\b|eigentlich\b|richtungswechsel\b|anders als\b)/iu.test(
    answer.customText,
  );
}
