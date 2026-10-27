import type { InboxItem } from "./contracts";

export type InboxSection = "action" | "activity" | "archive";

export type InboxPosition = {
  section: InboxSection;
  project: string;
  projectName: string;
  selectedId: string | undefined;
  index: number;
  scrollTop: number;
};

export const initialInboxPosition = (): InboxPosition => ({
  section: "action",
  project: "",
  projectName: "",
  selectedId: undefined,
  index: 0,
  scrollTop: 0,
});

export function inboxSectionItems(
  items: readonly InboxItem[],
  scope: Pick<InboxPosition, "section" | "project">,
) {
  return items.filter(
    (item) =>
      (!scope.project || item.projectId === scope.project) &&
      (scope.section === "action"
        ? item.needsAction
        : scope.section === "archive"
          ? item.archived
          : !item.needsAction && !item.archived),
  );
}

export type InboxQueue = {
  ids: readonly string[];
  current: InboxItem;
  section: InboxSection;
  project: string;
};

/** Keep the chosen order. New arrivals never move an in-progress queue's next item. */
export function nextInboxQueueItem(queue: InboxQueue, items: readonly InboxItem[]) {
  const remaining = new Map(inboxSectionItems(items, queue).map((item) => [item.id, item]));
  const index = queue.ids.indexOf(queue.current.id);
  if (index < 0) return undefined;
  for (const id of queue.ids.slice(index + 1)) {
    const item = remaining.get(id);
    if (item) return item;
  }
  return undefined;
}
