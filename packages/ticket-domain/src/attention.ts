export type AttentionCapability = "contribute" | "develop" | "manage";
export type AttentionMember = {
  id: string;
  develop: boolean;
  manage: boolean;
};

// Responsibility coordinates a Ticket. It neither grants authority nor changes
// the admitted Agent commissioner, current writer, or decision's actual addressee.
export function receivesAttention(input: {
  viewer: AttentionMember;
  responsible?: AttentionMember | undefined;
  capability: AttentionCapability;
  addressedTo?: string | null | undefined;
  authorID?: string | null | undefined;
}) {
  const eligible = (member: AttentionMember) =>
    input.capability === "contribute" ||
    (input.capability === "develop" && (member.develop || member.id === input.authorID)) ||
    (input.capability === "manage" && member.manage);
  if (!eligible(input.viewer)) return false;
  if (input.addressedTo) return input.viewer.id === input.addressedTo;
  if (input.responsible && eligible(input.responsible))
    return input.viewer.id === input.responsible.id;
  return true;
}

const identity = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

export function mentionText(person: { id: string; name: string }) {
  const label = person.name.replace(/[\r\n[\]\\]/g, " ").trim() || "Member";
  return `[@${label}](factory-person:${person.id})`;
}

export function mentionedPeople(body: string): string[] {
  // Literal examples and escaped markup are not addressed messages.
  const prose = body
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "$1")
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/\\./g, "");
  return [
    ...new Set(
      [
        ...prose.matchAll(new RegExp(`\\[@[^\\]\\n]+\\]\\(factory-person:(${identity})\\)`, "gi")),
      ].flatMap((match) => (match[1] ? [match[1].toLowerCase()] : [])),
    ),
  ];
}
