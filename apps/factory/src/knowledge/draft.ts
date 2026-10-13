import {
  mergeDocumentText,
  withoutRepeatedTitle,
} from "../../../../packages/knowledge-domain/src/document-merge";

export type PageSnapshot = { id: string; version: number; title: string; body: string };
export type KnowledgeDraft = { base: PageSnapshot; title: string; body: string; conflict: boolean };
export function pageSnapshot(page: {
  id: string;
  version: number;
  title: string;
  currentBody: string;
}): PageSnapshot {
  return {
    id: page.id,
    version: page.version,
    title: page.title,
    body: withoutRepeatedTitle(page.currentBody, page.title),
  };
}
export function draftFrom(base: PageSnapshot): KnowledgeDraft {
  return { base, title: base.title, body: base.body, conflict: false };
}
export function draftDirty(draft: KnowledgeDraft) {
  return draft.title !== draft.base.title || draft.body !== draft.base.body;
}
export function reconcileDraft(draft: KnowledgeDraft, next: PageSnapshot): KnowledgeDraft {
  if (draft.base.id !== next.id || next.version <= draft.base.version) return draft;
  const title = mergeDocumentText(draft.base.title, draft.title, next.title);
  const body = mergeDocumentText(draft.base.body, draft.body, next.body);
  if (title.conflict || body.conflict) return { ...draft, conflict: true };
  return { base: next, title: title.text, body: body.text, conflict: false };
}
export function readDraft(
  key: string,
  storage: Pick<Storage, "getItem">,
): KnowledgeDraft | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(`wiki-draft:${key}`) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("base" in value) ||
      !("title" in value) ||
      !("body" in value)
    )
      return;
    const base = value.base;
    if (
      !base ||
      typeof base !== "object" ||
      !("id" in base) ||
      !("version" in base) ||
      !("title" in base) ||
      !("body" in base)
    )
      return;
    if (
      typeof base.id !== "string" ||
      typeof base.version !== "number" ||
      !Number.isInteger(base.version) ||
      base.version < 1 ||
      typeof base.title !== "string" ||
      typeof base.body !== "string" ||
      base.body.length > 120_000 ||
      base.title.length > 200 ||
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      value.body.length > 120_000 ||
      value.title.length > 200
    )
      return;
    return {
      base: { id: base.id, version: base.version, title: base.title, body: base.body },
      title: value.title,
      body: value.body,
      conflict: false,
    };
  } catch {
    return;
  }
}
