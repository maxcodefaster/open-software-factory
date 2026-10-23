import { attachmentIDs } from "../../../../packages/conversation-domain/src/attachments";

// Markdown remains the persisted format. The prose field and file controls edit
// separate parts of that value; callers must retain/submit the complete content.
const references = new WeakMap<HTMLTextAreaElement, string[]>();
export function splitAttachmentContent(content: string) {
  const files: string[] = [];
  const text = content.replace(
    /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)|~~~[\s\S]*?~~~|(?:\n\n)?!?\[[^\]\n]*\]\(\/api\/attachments\/[a-f0-9-]{36}\)/gi,
    (match) => {
      if (match.startsWith("`") || match.startsWith("~")) return match;
      if (!attachmentIDs(match).length) return match;
      // Remove only the separator added by readAttachmentContent. Trailing
      // spaces and blank lines in the human's prose belong to the draft.
      files.push(match.replace(/^\n\n/, ""));
      return "";
    },
  );
  return { text, files };
}
export function attachmentText(content: string) {
  return splitAttachmentContent(content).text;
}
export function readAttachmentContent(input: HTMLTextAreaElement) {
  const files = references.get(input) ?? [];
  return files.length ? [input.value, ...files].filter(Boolean).join("\n\n") : input.value;
}
export function restoreAttachmentContent(input: HTMLTextAreaElement, content: string) {
  const draft = splitAttachmentContent(content);
  references.set(input, draft.files);
  if (input.value !== draft.text) input.value = draft.text;
  input.dispatchEvent(new Event("factory-attachment-content"));
}
