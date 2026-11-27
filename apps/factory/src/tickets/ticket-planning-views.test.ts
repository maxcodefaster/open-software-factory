import { describe, expect, test } from "bun:test";
import { formatTechnicalDesignHTML } from "./ticket-planning-markdown";

describe("formatTechnicalDesignHTML", () => {
  test("renders cited [^N] markers as superscript citation buttons with source tooltips", () => {
    const html = formatTechnicalDesignHTML("Update the handler[^1] and keep the schema[^2].", [
      {
        source: "code",
        id: "10000000-0000-4000-8000-000000000001",
        label: "Server handler",
        path: "src/server.ts",
        commitSha: "3b576055abcdef0123456789abcdef0123456789",
        reference: 1,
      },
      {
        source: "knowledge",
        id: "10000000-0000-4000-8000-000000000002",
        label: "Architecture guide",
        reference: 2,
      },
    ]);
    expect(html).toContain('class="inline-citation" data-citation="1"');
    expect(html).toContain('title="src/server.ts · 3b576055"');
    expect(html).toContain("<sup>1</sup>");
    expect(html).toContain('class="inline-citation" data-citation="2"');
    expect(html).toContain('title="Architecture guide"');
    expect(html).not.toContain("[^1]");
    expect(html).not.toContain("[^2]");
  });

  test("replaces unreferenced [^N] footnote markers with superscript badges outside code", () => {
    const html = formatTechnicalDesignHTML(
      "Uses existing auth flow[^1] and preserves `[^2]` plus:\n\n```md\nKeep [^3] verbatim\n```",
    );
    expect(html).toContain('<sup class="ticket-citation-ref" aria-label="Reference 1">1</sup>');
    expect(html).not.toContain("flow[^1]");
    expect(html).toContain("<code>[^2]</code>");
    expect(html).toContain("Keep [^3] verbatim");
  });

  test("keeps raw HTML safely escaped while formatting citation markers", () => {
    const html = formatTechnicalDesignHTML("Safe <script>alert(1)</script> reference[^4].");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<sup class="ticket-citation-ref" aria-label="Reference 4">4</sup>');
  });
});
