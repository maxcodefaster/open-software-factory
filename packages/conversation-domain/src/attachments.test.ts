import { expect, test } from "bun:test";
import { attachmentReferenceCases } from "../../../test/fixtures/attachment-references";
import { attachmentIDs, attachmentLimits, attachmentMarkdown, attachmentURL } from "./attachments";

test("attachment limits bound individual files and messages, not cumulative storage", () => {
  expect(attachmentLimits).toEqual({
    fileBytes: 10_485_760,
    messageBytes: 20_971_520,
  });
});

test("attachment references preserve immutable IDs without accepting partial IDs", () => {
  const id = crypto.randomUUID();
  const markdown = attachmentMarkdown({
    id,
    name: "Reference[one].pdf",
    mediaType: "application/pdf",
    bytes: 1024,
  });
  expect(markdown).toContain("1 KiB");
  expect(attachmentIDs(`${markdown}\n${markdown}`)).toEqual([id]);
  expect(attachmentIDs(`/api/attachments/${id}not-an-id`)).toEqual([]);
  expect(attachmentIDs(`\`/api/attachments/${id}\``)).toEqual([]);
  expect(attachmentIDs(`\`\`\`md\n![Example](/api/attachments/${id})\n\`\`\``)).toEqual([]);
  expect(attachmentURL(id, 2)).toBe(`/api/attachments/${id}/previews/2`);
});

test("authored attachment references follow the native publication corpus", () => {
  const id = "01994a7d-abcd-7000-8000-000000000010";
  for (const { content, ids } of attachmentReferenceCases(id))
    expect(attachmentIDs(content), content).toEqual(ids);
});
