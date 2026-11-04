import { mentionText } from "../../../../packages/ticket-domain/src/attention";

// Composers show "@Name" while the stored Markdown keeps the exact person link.
// Mentions the person chose (or restored from saved content) are remembered by
// label so the visible text can be turned back into the link form on send.
const codeOrLink =
  /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)|(?:^|\n)[ \t]*(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\k<fence>[ \t]*(?=\n|$)|$)|\[@(?<label>[^\]\n]+)\]\(factory-person:(?<id>[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\)/gi;
const known = new Map<string, Set<string>>();
const chosen = new WeakMap<object, Array<{ label: string; id: string }>>();
const word = "\\p{L}\\p{N}_";

function remember(label: string, id: string, owner?: object) {
  const ids = known.get(label) ?? new Set<string>();
  ids.add(id);
  known.set(label, ids);
  if (known.size > 500) {
    const oldest = known.keys().next().value;
    if (oldest !== undefined) known.delete(oldest);
  }
  if (owner) chosen.set(owner, [...(chosen.get(owner) ?? []), { label, id }].slice(-50));
}

export function mentionLabel(person: { id: string; name: string }) {
  return /^\[@([^\]]*)\]/.exec(mentionText(person))?.[1] ?? "Member";
}

/** Records a person the user picked in a composer and returns the visible text to insert. */
export function chooseMention(person: { id: string; name: string }, owner: object) {
  const label = mentionLabel(person);
  remember(label, person.id, owner);
  return `@${label}`;
}

/** Visible composer text for stored Markdown. Links in code stay literal. */
export function readableMentions(content: string, owner?: object) {
  return content.replace(codeOrLink, (match, ...rest) => {
    const groups = rest.at(-1) as { label?: string; id?: string };
    if (!groups.label || !groups.id) return match;
    remember(groups.label, groups.id, owner);
    return `@${groups.label}`;
  });
}

function escapeLabel(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Stored Markdown for visible composer text. Only remembered, unambiguous names become links. */
export function serializeMentions(text: string, owner?: object) {
  if (!text.includes("@") || !known.size) return text;
  const labels = [...known.keys()].filter((label) => text.includes(`@${label}`));
  if (!labels.length) return text;
  labels.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![${word}@])@(${labels.map(escapeLabel).join("|")})(?![${word}])`,
    "gu",
  );
  const picks = new Map<string, string[]>();
  for (const entry of chosen.get(owner ?? {}) ?? [])
    picks.set(entry.label, [...(picks.get(entry.label) ?? []), entry.id]);
  const used = new Map<string, number>();
  const plain =
    /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)|(?:^|\n)[ \t]*(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\k<fence>[ \t]*(?=\n|$)|$)/g;
  let result = "";
  let index = 0;
  const convert = (segment: string) =>
    segment.replace(pattern, (match, label: string) => {
      const ids = [...(known.get(label) ?? [])];
      const count = used.get(label) ?? 0;
      used.set(label, count + 1);
      const id = ids.length === 1 ? ids[0] : (picks.get(label)?.[count] ?? "");
      return id ? `[@${label}](factory-person:${id})` : match;
    });
  for (const code of text.matchAll(plain)) {
    result += convert(text.slice(index, code.index)) + code[0];
    index = code.index + code[0].length;
  }
  return result + convert(text.slice(index));
}

/** Length of a whole mention that ends exactly at the caret, for atomic deletion. */
export function mentionEndingAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  let longest = 0;
  for (const label of known.keys()) {
    const token = `@${label}`;
    if (token.length <= longest || !before.endsWith(token)) continue;
    const start = before.length - token.length;
    if (start === 0 || !new RegExp(`[${word}@]`, "u").test(before[start - 1] ?? ""))
      longest = token.length;
  }
  return longest;
}
