import { expect, test } from "bun:test";
import type { TicketDocumentRevision } from "./api-contracts";
import { approvedDocument, documentChangedSinceImplementation } from "./ticket-document-notice";

const implementation = {
  id: "11111111-1111-4111-8111-111111111111",
  approvedAt: "2026-01-02T10:00:00.000Z",
};

function document(
  id: string,
  createdAt: string,
  ordinal: number,
  fields: Partial<TicketDocumentRevision> = {},
): TicketDocumentRevision {
  return {
    id,
    ordinal,
    createdAt,
    title: "Invoices",
    description: "Export invoices",
    canonicalContent: '{"summary":"Export"}',
    contentDigest: "digest",
    requirementRevisionId: implementation.id,
    ...fields,
  };
}

const approved = document("approved", "2026-01-02T09:00:00.000Z", 1);

test("a later save with different wording announces a change", () => {
  const edited = document("edited", "2026-01-02T11:00:00.000Z", 2, {
    canonicalContent: '{"summary":"Export more"}',
  });
  expect(documentChangedSinceImplementation([edited, approved], implementation)).toBe(true);
});

test("a title or description change alone announces a change", () => {
  const retitled = document("retitled", "2026-01-02T11:00:00.000Z", 2, { title: "Billing" });
  expect(documentChangedSinceImplementation([retitled, approved], implementation)).toBe(true);
});

test("writing the approved text back leaves no notice", () => {
  const edited = document("edited", "2026-01-02T11:00:00.000Z", 2, {
    canonicalContent: '{"summary":"Export more"}',
  });
  const reverted = document("reverted", "2026-01-02T12:00:00.000Z", 3);
  expect(documentChangedSinceImplementation([reverted, edited, approved], implementation)).toBe(
    false,
  );
});

test("a document saved before approval is the baseline and never a change", () => {
  expect(documentChangedSinceImplementation([approved], implementation)).toBe(false);
});

test("without a recorded baseline a later save still announces", () => {
  const later = document("later", "2026-01-02T11:00:00.000Z", 1);
  expect(documentChangedSinceImplementation([later], implementation)).toBe(true);
});

test("nothing is announced before an approval exists", () => {
  expect(documentChangedSinceImplementation([approved], { id: implementation.id })).toBe(false);
  expect(documentChangedSinceImplementation([], implementation)).toBe(false);
});

test("the baseline prefers the document linked to the approved revision", () => {
  const unlinked = document("unlinked", "2026-01-02T09:30:00.000Z", 2, {
    requirementRevisionId: null,
  });
  expect(approvedDocument([unlinked, approved], implementation)?.id).toBe("approved");
});
