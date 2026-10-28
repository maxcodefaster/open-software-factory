import { expect, test } from "bun:test";
import { verificationChangeScope, verificationReviewReasons } from "./verification";
import { verificationReceipt } from "../../../test/fixtures/verification";
import { fixtureValue } from "../../../test/fixtures/value";

const commit = "b".repeat(40);

test("exact clean check evidence keeps healthy sampling, missing and foreign evidence do not", () => {
  expect(verificationReviewReasons(verificationReceipt(commit), commit)).toEqual([]);
  for (const receipt of [null, {}, verificationReceipt("c".repeat(40))])
    expect(verificationReviewReasons(receipt, commit)).toEqual(["missing-verification-evidence"]);
});

test("suspicious successes are selected without declaring their changes defective", () => {
  const receipt = verificationReceipt(commit);
  receipt.complete = false;
  const job = fixtureValue(receipt.jobs[0], "receipt.jobs[0]");
  job.attempt = 2;
  fixtureValue(job.steps[0], "job.steps[0]").status = "skipped";
  Object.assign(fixtureValue(receipt.changes, "receipt.changes"), { tests: true, ci: true });
  expect(verificationReviewReasons(receipt, commit)).toEqual([
    "incomplete-verification-evidence",
    "skipped-checks",
    "retried-checks",
    "test-changes",
    "ci-changes",
  ]);
  expect(verificationReviewReasons({ ...receipt, changes: null }, commit)).toContain(
    "incomplete-verification-evidence",
  );
});

test("source flags use actual content identities, distinguish deletion and include CI owners", () => {
  const before = [
    { path: "test/payment.test.ts", sha: "1" },
    { path: "src/unchanged.test.ts", sha: "2" },
    { path: "package.json", sha: "3" },
    { path: "src/app.ts", sha: "4" },
  ];
  expect(verificationChangeScope(commit, before, before)).toEqual({
    baseCommit: commit,
    tests: false,
    ci: false,
    removedTests: false,
  });
  expect(
    verificationChangeScope(
      commit,
      before,
      before
        .slice(1)
        .map((file) => (file.path === "package.json" ? { ...file, sha: "new" } : file)),
    ),
  ).toEqual({
    baseCommit: commit,
    tests: true,
    ci: true,
    removedTests: true,
  });
  for (const path of [
    ".forgejo/workflows/test.yml",
    "scripts/testing/lanes.ts",
    "playwright.config.ts",
    "tsconfig.app.json",
    "services/runtime-connector/go.mod",
  ])
    expect(verificationChangeScope(commit, [], [{ path, sha: "new" }]).ci).toBe(true);
  expect(
    verificationChangeScope(
      commit,
      [],
      [{ path: "services/runtime-connector/main_test.go", sha: "new" }],
    ).tests,
  ).toBe(true);
  expect(verificationChangeScope(commit, [], [{ path: "src/contest.ts", sha: "new" }]).tests).toBe(
    false,
  );
});
