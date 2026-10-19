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

/** Keep the human edit separate from the next generated baseline, not just today's visible text. */
export function mergeGeneratedDocument(base: string, human: string, generated: string) {
  const conflict = () => ({ body: human, generatedBody: base, conflict: true });
  const result = (body: string, generatedBody: string) =>
    !body.length || !generatedBody.length || body.length > 120_000 || generatedBody.length > 120_000
      ? conflict()
      : { body, generatedBody, conflict: false };
  if (human === base) return result(generated, generated);

  const start = human.indexOf(base);
  if (base.length && start >= 0 && start === human.lastIndexOf(base)) {
    const before = human.slice(0, start);
    const after = human.slice(start + base.length);
    // Notes outside the generated document do not overlap a rewritten first/last
    // paragraph. Character merging alone treats their boundary offsets as conflicts.
    if ((!before || before.endsWith("\n\n")) && (!after || after.startsWith("\n\n"))) {
      let next = generated;
      for (const block of [before.replace(/\n+$/, ""), after.replace(/^\n+/, "")]) {
        if (!block) continue;
        const index = next.indexOf(block);
        if (
          index >= 0 &&
          (index === 0 || next.slice(0, index).endsWith("\n\n")) &&
          (index + block.length === next.length ||
            next.slice(index + block.length).startsWith("\n\n"))
        )
          next = (next.slice(0, index) + next.slice(index + block.length)).trim();
      }
      next = next.trim();
      return result(before + next + after, next);
    }
  }
  const merged = mergeDocumentText(base, human, generated);
  if (merged.conflict) return conflict();
  // The writer may already have repeated the human edit. Undo that edit only in
  // the stored generated baseline, so the next generation still sees its owner.
  const baseline = mergeDocumentText(human, base, generated);
  if (baseline.conflict) return conflict();
  return result(merged.text, baseline.text);
}

export function withoutRepeatedTitle(body: string, title: string) {
  const heading = /^\s*#{1,6}\s+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body);
  return heading?.[1]?.trim() === title.trim()
    ? body.slice(heading[0].length).replace(/^\n+/, "")
    : body;
}
