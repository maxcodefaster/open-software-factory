import { diffChars } from "diff";

type Edit = { start: number; end: number; text: string };
function edits(base: string, next: string): Edit[] {
  const changes = diffChars(base, next, { timeout: 100, maxEditLength: 10_000 });
  if (!changes) return [{ start: 0, end: base.length, text: next }];
  const result: Edit[] = [];
  let offset = 0;
  let pending: Edit | undefined;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (pending) result.push(pending);
      pending = undefined;
      offset += change.value.length;
    } else {
      pending ??= { start: offset, end: offset, text: "" };
      if (change.removed) {
        offset += change.value.length;
        pending.end = offset;
      } else pending.text += change.value;
    }
  }
  if (pending) result.push(pending);
  return result;
}

/** Character offsets, not headings, identify changes. Ambiguity retains the local draft. */
export function mergeDocumentText(base: string, local: string, remote: string) {
  if (local === remote || remote === base) return { text: local, conflict: false };
  if (local === base) return { text: remote, conflict: false };
  const ours = edits(base, local);
  const theirs = edits(base, remote);
  const combined = [...ours];
  for (const next of theirs) {
    let duplicate = false;
    for (const own of ours) {
      if (own.start === next.start && own.end === next.end && own.text === next.text) {
        duplicate = true;
        break;
      }
      const intersects =
        own.start === own.end || next.start === next.end
          ? own.start <= next.end && next.start <= own.end
          : own.start < next.end && next.start < own.end;
      if (intersects) return { text: local, conflict: true };
    }
    if (!duplicate) combined.push(next);
  }
  let text = base;
  for (const edit of combined.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, conflict: false };
}

export function withoutRepeatedTitle(body: string, title: string) {
  const heading = /^\s*#{1,6}\s+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body);
  return heading?.[1]?.trim() === title.trim()
    ? body.slice(heading[0].length).replace(/^\n+/, "")
    : body;
}
