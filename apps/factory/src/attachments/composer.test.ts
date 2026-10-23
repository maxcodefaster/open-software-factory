import { expect, test } from "bun:test";
import {
  attachmentIDs,
  attachmentMarkdown,
} from "../../../../packages/conversation-domain/src/attachments";
import {
  readAttachmentContent,
  restoreAttachmentContent,
  splitAttachmentContent,
} from "./composer";

test("composer separates exact references from prose without interpreting code", () => {
  const id = crypto.randomUUID();
  const file = attachmentMarkdown({ id, name: "Design.png", mediaType: "image/png" });
  const prose = `Please follow this.\n\n\`${file}\`\n\n\`\`${file}\`\`\n\n\`\`\`md\n${file}\n\`\`\``;
  const draft = splitAttachmentContent(`${prose}\n\n${file}`);
  expect(draft.text).toBe(prose);
  expect(draft.files).toEqual([file]);
  expect(attachmentIDs(draft.files.join("\n"))).toEqual([id]);
  expect(splitAttachmentContent("Unchanged prose\n\n").text).toBe("Unchanged prose\n\n");
});

test("document names and unrelated links survive composer restoration", () => {
  const file = attachmentMarkdown({
    id: crypto.randomUUID(),
    name: "Brief (final) [team].pdf",
    mediaType: "application/pdf",
    bytes: 1234,
  });
  const draft = splitAttachmentContent(`See [the brief](https://example.test).\n\n${file}`);
  expect(draft.text).toBe("See [the brief](https://example.test).");
  expect(draft.files).toEqual([file]);
});

test("editing, retaining and resetting a prose field preserves its separate file references", () => {
  const input = Object.assign(new EventTarget(), { value: "" }) as HTMLTextAreaElement;
  const file = attachmentMarkdown({
    id: crypto.randomUUID(),
    name: "Brief.pdf",
    mediaType: "application/pdf",
  });
  restoreAttachmentContent(input, `Keep this context.\n\n${file}`);
  restoreAttachmentContent(input, readAttachmentContent(input));
  expect(input.value).toBe("Keep this context.");
  input.value = "Keep the revised context.";
  expect(readAttachmentContent(input)).toBe(`Keep the revised context.\n\n${file}`);
  restoreAttachmentContent(input, file);
  expect(input.value).toBe("");
  expect(readAttachmentContent(input)).toBe(file);
  restoreAttachmentContent(input, "");
  expect(readAttachmentContent(input)).toBe("");
});

test("attachment round trips preserve slash completion spaces and deliberate blank lines", () => {
  const input = Object.assign(new EventTarget(), { value: "" }) as HTMLTextAreaElement;
  const files = [
    attachmentMarkdown({
      id: crypto.randomUUID(),
      name: "Brief.pdf",
      mediaType: "application/pdf",
    }),
    attachmentMarkdown({
      id: crypto.randomUUID(),
      name: "Reference.png",
      mediaType: "image/png",
    }),
  ];
  restoreAttachmentContent(input, files.join("\n\n"));
  for (const text of ["Please /review-ui ", "First paragraph.\n\n", "  ", ""]) {
    input.value = text;
    const content = readAttachmentContent(input);
    expect(splitAttachmentContent(content)).toEqual({ text, files });
    restoreAttachmentContent(input, content);
    expect(input.value).toBe(text);
  }
});
