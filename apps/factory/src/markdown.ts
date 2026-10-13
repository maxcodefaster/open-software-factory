import { Marked } from "marked";
import { highlightedCode } from "./code-highlighting";

function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Reader and editor use the same pinned GFM parser. Raw HTML never enters the DOM.
function createReader(codeControls = false) {
  return new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }) {
        const language = lang?.split(/\s+/)[0] ?? "plaintext";
        const content = highlightedCode(text, language) ?? escapeHTML(text);
        const controls = codeControls
          ? `<span class="reader-code-controls"><span>${escapeHTML(language === "plaintext" ? "Plain text" : language)}</span><button type="button" aria-label="Copy code">Copy</button></span>`
          : "";
        return `<pre>${controls}<code class="language-${escapeHTML(language)}">${content}</code></pre>\n`;
      },
      html({ text }) {
        return /^<br\s*\/?>$/i.test(text) ? "<br>" : escapeHTML(text);
      },
      image({ text }) {
        return escapeHTML(text);
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (!/^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(href)) return label;
        const attribute = title ? ' title="' + escapeHTML(title) + '"' : "";
        return (
          '<a href="' +
          escapeHTML(href) +
          '"' +
          attribute +
          ' rel="noopener noreferrer">' +
          label +
          "</a>"
        );
      },
    },
  });
}
const reader = createReader();
const documentReader = createReader(true);

export function markdownHTML(
  markdown: string,
  codeControls = false,
  citations: readonly { reference: number; label: string }[] = [],
): string {
  if (!citations.length)
    return (codeControls ? documentReader : reader).parse(markdown, { async: false });
  // References keep their admitted numbers when an unauthorized source is removed.
  // Ambiguous or unknown numbers remain text, never links to a different source.
  const references = new Map<number, string | undefined>();
  for (const citation of citations)
    references.set(
      citation.reference,
      references.has(citation.reference) ? undefined : citation.label,
    );
  const citedReader = createReader(codeControls);
  citedReader.use({
    extensions: [
      {
        name: "factoryCitation",
        level: "inline",
        start: (source) => source.indexOf("[^"),
        tokenizer(source) {
          const match = /^\[\^(\d{1,2})\]/.exec(source);
          const reference = Number(match?.[1]);
          const label = references.get(reference);
          if (!match || !label) return;
          return { type: "factoryCitation", raw: match[0], reference, label };
        },
        renderer(token) {
          return `&#8288;<button type="button" class="inline-citation" data-citation="${token["reference"]}" title="${escapeHTML(token["label"])}" aria-label="Source ${token["reference"]}: ${escapeHTML(token["label"])}"><sup>${token["reference"]}</sup></button>`;
        },
      },
    ],
  });
  return citedReader.parse(markdown, { async: false });
}

export function documentRepeatsTitle(body: string, title: string) {
  const heading = /^#{1,6}\s+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body.trimStart());
  return !!title.trim() && heading?.[1]?.trim() === title.trim();
}
