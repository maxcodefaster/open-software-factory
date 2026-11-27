import type { TechnicalDesignRevision } from "../change/contracts";
import { markdownHTML } from "../editor/client";

const PROTECTED_OR_FOOTNOTE =
  /(<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>|<[^>]+>)|\[\^(\d{1,2})\]/gi;

export function formatTechnicalDesignHTML(
  markdown: string,
  citations: readonly TechnicalDesignRevision["citations"][number][] = [],
): string {
  const references = citations.map((citation, index) => ({
    reference: citation.reference ?? index + 1,
    label:
      citation.source === "code" && citation.path
        ? `${citation.path}${citation.commitSha ? ` · ${citation.commitSha.slice(0, 8)}` : ""}`
        : citation.label,
  }));
  const html = markdownHTML(markdown, true, references);
  return html.replace(
    PROTECTED_OR_FOOTNOTE,
    (match, protectedSegment: string | undefined, reference: string | undefined) => {
      if (protectedSegment || !reference) return match;
      return `&#8288;<sup class="ticket-citation-ref" aria-label="Reference ${reference}">${reference}</sup>`;
    },
  );
}
