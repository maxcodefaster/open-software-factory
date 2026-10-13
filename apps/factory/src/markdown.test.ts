import { expect, test } from "bun:test";
import { highlightedCode } from "./code-highlighting";
import { documentRepeatsTitle, markdownHTML } from "./markdown";

test("preserves fenced language, code whitespace, and ordered list start", () => {
  const rendered = markdownHTML("```ts\n  const x = 1;\n```\n\n3. Third\n4. Fourth");
  expect(rendered).toContain('class="language-ts"');
  expect(rendered).toContain("hljs-keyword");
  expect(rendered.replace(/<[^>]*>/g, "")).toContain("  const x = 1;");
  expect(rendered).toContain('<ol start="3">');
});
test("does not interpret Markdown or HTML inside code", () => {
  expect(markdownHTML("`**literal** <script>`")).toContain(
    "<p><code>**literal** &lt;script&gt;</code></p>",
  );
  expect(markdownHTML("[unsafe](javascript:alert(1))")).not.toContain("href=");
});
test("renders tables, nested lists and disabled tasks consistently in read views", () => {
  const rendered = markdownHTML(
    "| Name | Status |\n| --- | --- |\n| Counter | Ready |\n\n- outer\n  - inner\n\n- [x] done",
  );
  expect(rendered).toContain("<table>");
  expect(rendered).toContain("<td>Ready</td>");
  expect(rendered.match(/<ul>/g)?.length).toBe(2);
  expect(rendered).toContain('disabled=""');
});
test("the editor's table-cell line breaks render without admitting arbitrary HTML", () => {
  expect(markdownHTML("| Owner<br>Scope |\n| --- |\n| Developer |")).toContain("Owner<br>Scope");
  expect(markdownHTML('<br onmouseover="alert(1)">')).not.toContain("<br onmouseover");
});
test("raw HTML, unsafe and encoded URLs cannot create executable markup", () => {
  for (const value of [
    "<img src=x onerror=alert(1)>",
    "[link](javascript:alert%281%29)",
    "[link](data:text/html,test)",
    "[link](jav&#x61;script:alert%281%29)",
  ]) {
    const rendered = markdownHTML(value);
    expect(rendered).not.toMatch(/<(?:img|script|iframe)/);
    expect(rendered).not.toContain('href="javascript:');
    expect(rendered).not.toContain('href="data:');
  }
  expect(markdownHTML('[safe](https://example.com?q="test")')).toContain(
    'href="https://example.com',
  );
});
test("duplicate title suppression never removes or matches a different authored heading", () => {
  expect(documentRepeatsTitle("\n# Factory starter\n\nBody", "Factory starter")).toBe(true);
  expect(documentRepeatsTitle("# Factory starter guide\n", "Factory starter")).toBe(false);
  expect(documentRepeatsTitle("## Purpose\n", "Factory starter")).toBe(false);
  expect(documentRepeatsTitle("No heading", "")).toBe(false);
});
test("document code controls copy text without interpreting language or code markup", () => {
  const html = markdownHTML('```ts\nconst safe = "<script>";\n```', true);
  expect(html).toContain('aria-label="Copy code"');
  expect(html).toContain("hljs-keyword");
  expect(html).not.toContain("<script>");
  expect(markdownHTML("```ts\nconst safe = true;\n```")).not.toContain("Copy code");
  expect(highlightedCode("const safe = true;", "plaintext")).not.toContain("hljs-keyword");
});

test("answer references stay beside their claims without linking code or invented sources", () => {
  const rendered = markdownHTML(
    "First claim.[^2]\n\nSecond claim.[^5]\n\n`[^2]`\n\nUnknown.[^1]",
    false,
    [
      { reference: 2, label: "Ticket guide" },
      { reference: 5, label: 'Wiki <img src=x onerror="unsafe">' },
    ],
  );
  expect(rendered).toContain('First claim.&#8288;<button type="button" class="inline-citation"');
  expect(rendered).toContain('data-citation="2"');
  expect(rendered).toContain('data-citation="5"');
  expect(rendered).toContain("<code>[^2]</code>");
  expect(rendered).not.toContain('data-citation="1"');
  expect(rendered).not.toContain("<img");
  expect(rendered).toContain("&lt;img");
  expect(
    markdownHTML("[link](https://example.com) and [^2]", false, [{ reference: 2, label: "Guide" }]),
  ).toContain('href="https://example.com"');
});

test("duplicate citation numbers never redirect a claim to an ambiguous source", () => {
  expect(
    markdownHTML("Claim.[^2]", false, [
      { reference: 2, label: "First" },
      { reference: 2, label: "Second" },
    ]),
  ).not.toContain("data-citation");
  expect(markdownHTML("```md\n[^2]\n```", false, [{ reference: 2, label: "Guide" }])).not.toContain(
    "data-citation",
  );
});
