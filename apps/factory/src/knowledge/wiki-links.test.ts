import { expect, test } from "bun:test";
import { wikiLinkIssues } from "./wiki-links";

const pages = [{ slug: "tasks", title: "Managing tasks", state: "active" }];
test("Wiki writing gets an actionable repair for bare and unknown references", () => {
  expect(wikiLinkIssues("See #wiki/tasks and [Missing](#wiki/missing).", pages)).toEqual([
    "Use the Markdown link [Managing tasks](#wiki/tasks) instead of the bare #wiki/tasks reference.",
    "Unavailable internal link missing",
  ]);
  expect(wikiLinkIssues("#wiki/tasks", [{ ...pages[0]!, state: "archived" }])).toEqual([
    "Unavailable internal link tasks",
  ]);
});
test("Wiki validation inspects nested prose but preserves literal code and authored link labels", () => {
  expect(
    wikiLinkIssues(
      "`#wiki/tasks` [#wiki/tasks](https://example.com) [Tasks](#wiki/tasks)\n\n```md\n[Literal](#wiki/missing)\n```\n\n\\#wiki/tasks",
      pages,
    ),
  ).toEqual([]);
  expect(
    wikiLinkIssues("- **See #wiki/tasks.**\n\n| Guide |\n| --- |\n| #wiki/tasks |", pages),
  ).toHaveLength(1);
});
