# Keep human attachments private and bound to immutable work

Wiki, Tickets, conversations and review discussions reference immutable files in the chart-managed
private object store shared with QA media. PostgreSQL owns their identities, hashes, publication intent, byte
reservations and authored references. File bytes and page images do not enter Zero, Markdown or
the product database. [ADR 0027](0027-chart-managed-private-file-storage.md) replaces the former
external bucket prerequisite and separate state-volume media storage with one bundled service.

Upload intent and all object keys are recorded before external writes. Publication checks the
same content and current authority. Unconfirmed uploads can reconcile only their exact identity.
Pending uploads are private; saving or sending is the sharing decision. Project conversations
remain personal, Ticket conversations and feedback follow Project access, and private Ticket
drafts do not publish their files merely by uploading.

Agent admission freezes the relevant Ticket revision and human attachment references, including
the meaning supplied in Ticket chat. Explicit review revision batches retain their complete
discussion context. Independent review receives the same admitted reference content. Scoped native
tools return bounded text and actual images or document pages, with current authority checked
before and after object reads. Compaction can reread those exact files without changing identity.
Wiki attachments are discovered through authorized source reads, not injected Project-wide.
File content never grants instructions, tools or execution authority.

Factory limits each original file and the total original bytes in one message, not cumulative
Project or installation storage. The operator manages Kubernetes storage capacity; an arbitrary total
cap must not block accumulated Project history. Originals, rendered pages and extracted text
remain accounted for, with write intent retained before storage I/O. Referenced history does not
expire to make room. Unassigned uploads expire after one day, with accounted bytes released only
after confirmed deletion of their recorded, installation-owned
keys. PDF processing retains scanned and digital page images. Unsupported DOCX drawings and
embedded objects fail explicitly rather than silently becoming incomplete reference text.
