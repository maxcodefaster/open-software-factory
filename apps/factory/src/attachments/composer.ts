import { attachmentIDs } from "../../../../packages/conversation-domain/src/attachments";
import { readableMentions, serializeMentions } from "./mention-text";

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
  return readableMentions(splitAttachmentContent(content).text);
}
export function readAttachmentContent(input: HTMLTextAreaElement) {
  const files = references.get(input) ?? [];
  const text = serializeMentions(input.value, input);
  return files.length ? [text, ...files].filter(Boolean).join("\n\n") : text;
}
export function restoreAttachmentContent(input: HTMLTextAreaElement, content: string) {
  const draft = splitAttachmentContent(content);
  references.set(input, draft.files);
  const visible = readableMentions(draft.text, input);
  if (input.value !== visible) input.value = visible;
  input.dispatchEvent(new Event("factory-attachment-content"));
}
