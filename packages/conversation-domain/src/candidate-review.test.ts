import { expect, test } from "bun:test";
import {
  candidateReviewCallInput,
  candidateReviewPermissions,
  candidateReviewToolCatalogue,
  candidateReviewResultInput,
  reviewNeedsBrowser,
} from "./candidate-review";

const result = {
  verdict: "passed",
  summary: "The requested behavior works.",
  criteria: [{ criterion: 1, status: "passed", evidence: "Observed the requested outcome." }],
  findings: [],
  ui: "not-applicable",
};
test("review cannot approve missing proof, duplicate coverage or a blocking defect", () => {
  expect(candidateReviewResultInput.safeParse(result).success).toBe(true);
  for (const changed of [
    { criteria: [{ criterion: 1, status: "unverified", evidence: "Not checked." }] },
    { criteria: [...result.criteria, ...result.criteria] },
    { ui: "unverified" },
    {
      findings: [
        {
          severity: "blocking",
          title: "Wrong result",
          explanation: "Expected 3, received 4.",
          reproduction: "Add 1 and 2.",
        },
      ],
    },
    { verdict: "changes-requested" },
  ])
    expect(candidateReviewResultInput.safeParse({ ...result, ...changed }).success).toBe(false);
});
test("review only exposes fixed immutable source/report tools, not arbitrary execution", () => {
  for (const name of ["shell", "subagent", "edit", "write", "eval"])
    expect(candidateReviewCallInput.safeParse({ name, arguments: {} }).success).toBe(false);
  for (const path of ["../secrets", "/etc/passwd", "src/../secret", "src\\secret", "src/\0"]) {
    expect(
      candidateReviewCallInput.safeParse({ name: "review_read", arguments: { path } }).success,
    ).toBe(false);
  }
  expect(candidateReviewPermissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  expect(
    candidateReviewPermissions.slice(1).every((rule) => rule.action.startsWith("factory_browser_")),
  ).toBe(true);
});
test("frontend source needs a real browser review, not only code inspection", () => {
  expect(reviewNeedsBrowser(["src/server.ts", "test/server.test.ts"])).toBe(false);
  for (const path of ["src/app.tsx", "styles/main.css", "index.html", "App.vue"])
    expect(reviewNeedsBrowser([path])).toBe(true);
});

test("MCP input schemas keep defaulted source-read arguments optional", () => {
  const read = candidateReviewToolCatalogue.find((tool) => tool.name === "review_read");
  expect(read?.inputSchema.required).toEqual(["path"]);
});
