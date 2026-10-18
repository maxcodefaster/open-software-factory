import type { InterviewQuestion } from "../../../packages/conversation-domain/src/conversation";

export function interviewOptions(question: InterviewQuestion) {
  if (question.type === "free-text")
    return { options: [], customOptionIds: [], customDescription: "" };
  const custom = question.allowCustom
    ? question.options.filter((option) =>
        ["something else", "other"].includes(option.label.trim().toLowerCase()),
      )
    : [];
  const customOptionIds = custom.map((option) => option.id);
  return {
    options: question.options.filter((option) => !customOptionIds.includes(option.id)),
    customOptionIds,
    customDescription: custom.find((option) => option.description)?.description ?? "",
  };
}
