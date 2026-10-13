type GroupableTicket = { id: string; epicId?: string | null };
type EpicLabel = { id: string; title: string };

export type BoardGroup<T> =
  | { kind: "ticket"; ticket: T }
  | { kind: "epic"; epic: EpicLabel; tickets: T[] };

/** Group one stage only, preserving the first occurrence and every member's order. */
export function boardGroups<T extends GroupableTicket>(
  tickets: readonly T[],
  epics: readonly EpicLabel[],
): BoardGroup<T>[] {
  const labels = new Map(epics.map((epic) => [epic.id, epic]));
  const groups = new Map<string, Extract<BoardGroup<T>, { kind: "epic" }>>();
  const entries: BoardGroup<T>[] = [];
  for (const ticket of tickets) {
    const epic = ticket.epicId ? labels.get(ticket.epicId) : undefined;
    if (!epic) {
      entries.push({ kind: "ticket", ticket });
      continue;
    }
    let group = groups.get(epic.id);
    if (!group) {
      group = { kind: "epic", epic, tickets: [] };
      groups.set(epic.id, group);
      entries.push(group);
    }
    group.tickets.push(ticket);
  }
  return entries;
}
