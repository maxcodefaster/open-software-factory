import type { InterviewQuestion } from "#conversation-domain/conversation";

export function splitInlineCode(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ code: false, text: text.slice(last, start) });
    parts.push({ code: true, text: match[1] ?? "" });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

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
