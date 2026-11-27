type DocumentFields = {
  id: string;
  ordinal: number;
  createdAt?: string | undefined;
  title: string;
  description: string;
  canonicalContent: string;
  requirementRevisionId: string | null;
};
type ImplementationFields = { id: string; approvedAt?: string | null | undefined };

function signature(document: DocumentFields) {
  return JSON.stringify([document.title, document.description, document.canonicalContent]);
}

// The document that was current when the implementation's requirements were approved.
export function approvedDocument(
  documents: readonly DocumentFields[],
  implementation: ImplementationFields,
) {
  const approvedAt = Date.parse(implementation.approvedAt ?? "");
  if (Number.isNaN(approvedAt)) return undefined;
  const before = documents
    .filter((document) => Date.parse(document.createdAt ?? "") <= approvedAt)
    .sort(
      (a, b) =>
        Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") || b.ordinal - a.ordinal,
    );
  return (
    before.find((document) => document.requirementRevisionId === implementation.id) ?? before[0]
  );
}

// Compares what the document says, not when it was saved: writing the approved text back
// after an edit leaves nothing to announce. Without a recorded baseline the later save time
// is the only evidence, so the notice stays.
export function documentChangedSinceImplementation(
  documents: readonly DocumentFields[],
  implementation: ImplementationFields | undefined,
) {
  const current = documents[0];
  if (!current || !implementation?.approvedAt) return false;
  const approvedAt = Date.parse(implementation.approvedAt);
  if (Number.isNaN(approvedAt) || !(Date.parse(current.createdAt ?? "") > approvedAt)) return false;
  const baseline = approvedDocument(documents, implementation);
  if (!baseline) return true;
  return baseline.id !== current.id && signature(baseline) !== signature(current);
}
