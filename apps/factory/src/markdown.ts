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
          ? `<span class="reader-code-controls"><span>${escapeHTML(language === "plaintext" ? "Plain text" : language)}</span><button type="button" class="copy-feedback" data-feedback="idle" aria-label="Copy code"><span class="feedback-mark" aria-hidden="true"></span><span class="copy-feedback-label" aria-hidden="true"><span class="copy-feedback-reserve">Copy</span><span data-copy-label>Copy</span></span></button></span>`
          : "";
        return `<pre>${controls}<code class="language-${escapeHTML(language)}">${content}</code></pre>\n`;
      },
      html({ text }) {
        return /^<br\s*\/?>$/i.test(text) ? "<br>" : escapeHTML(text);
      },
      image({ text, href }) {
        if (!/^\/api\/attachments\/[a-f0-9-]{36}$/i.test(href)) return escapeHTML(text);
        return `<a class="factory-attachment-preview" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open image ${escapeHTML(text)} in new tab"><img class="factory-attachment-image" src="${escapeHTML(href)}/previews/0" alt="${escapeHTML(text)}" loading="lazy"><span class="attachment-image-action">Open image</span></a>`;
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (!/^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(href)) return label;
        const attachment = /^\/api\/attachments\/[a-f0-9-]{36}$/i.test(href);
        const attribute =
          (title || attachment
            ? ' title="' + escapeHTML(title ?? tokens.map((token) => token.raw).join("")) + '"'
            : "") + (attachment ? ' class="factory-attachment-file" download' : "");
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
  wikiPages: readonly { slug: string; title: string }[] = [],
): string {
  if (!citations.length && !wikiPages.length)
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
  if (wikiPages.length) {
    const pages = new Map(wikiPages.map((page) => [page.slug, page.title]));
    citedReader.use({
      extensions: [
        {
          name: "factoryWikiReference",
          level: "inline",
          start: (source) => source.indexOf("#wiki/"),
          tokenizer(source) {
            if (this.lexer.state.inLink) return;
            const match = /^#wiki\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w/-])/.exec(source);
            const title = match && pages.get(match[1]!);
            if (!match || !title) return;
            return { type: "factoryWikiReference", raw: match[0], slug: match[1], title };
          },
          renderer(token) {
            return `<a href="#wiki/${escapeHTML(token["slug"])}" rel="noopener noreferrer">${escapeHTML(token["title"])}</a>`;
          },
        },
      ],
    });
  }
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
