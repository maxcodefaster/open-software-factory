import { type PersonalTicketDraft, personalTicketDraftSchema } from "./contracts";

export function readPersonalTicketDraft(key: string): PersonalTicketDraft {
  try {
    const parsed = personalTicketDraftSchema.safeParse(
      JSON.parse(localStorage.getItem(key) ?? "null"),
    );
    if (parsed.success) return parsed.data;
  } catch {
    /* A new local draft remains usable without browser storage. */
  }
  return { id: crypto.randomUUID(), title: "", description: "" };
}
