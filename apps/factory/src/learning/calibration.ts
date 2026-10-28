import type {
  LearningCase,
  LearningResult,
} from "../../../../packages/conversation-domain/src/learning";

// These are fixed product checks, never editable by the optimizer. They test
// Evidence failures and healthy test cleanup must not be confused with each other.
export const calibrationCases: LearningCase[] = [
  {
    id: "calibration:healthy",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: false,
    activity: "research",
    outcome: "completed",
    settledAt: "2026-10-26T00:00:00.000Z",
    evidence: [
      {
        id: "healthy:task",
        kind: "task",
        body: "Report the exact documented retry limit. Do not change code.",
        truncated: false,
      },
      {
        id: "healthy:source",
        kind: "artifact",
        body: "Pinned source settings.ts at commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: MAX_RETRIES = 3.",
        truncated: false,
      },
      {
        id: "healthy:answer",
        kind: "outcome",
        body: "The retry limit is 3, citing settings.ts at the exact commit. No source changes.",
        truncated: false,
      },
    ],
    targets: [],
  },
  {
    id: "calibration:defect",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: false,
    activity: "build",
    outcome: "completed",
    settledAt: "2026-10-26T00:00:00.000Z",
    evidence: [
      {
        id: "defect:task",
        kind: "task",
        body: "Reject empty API tokens before making a network request.",
        truncated: false,
      },
      {
        id: "defect:source",
        kind: "artifact",
        body: "Exact submitted function: async function fetchData(token) { return fetch('/api/data', { headers: {Authorization: token} }); }. No token guard.",
        truncated: false,
      },
      {
        id: "defect:check",
        kind: "outcome",
        body: "Observed test: fetchData('') invoked fetch once, expected zero calls. Agent nevertheless reported implementation complete.",
        truncated: false,
      },
    ],
    targets: [],
  },
  {
    id: "calibration:false-alarm",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: false,
    activity: "review",
    outcome: "failed",
    settledAt: "2026-10-26T00:00:00.000Z",
    evidence: [
      {
        id: "alarm:task",
        kind: "task",
        body: "Review the exact candidate. Block delivery if an unauthenticated user can read invoices.",
        truncated: false,
      },
      {
        id: "alarm:source",
        kind: "artifact",
        body: "Candidate endpoint has no authentication check. Observed unauthenticated GET /invoices returned 200 with actual invoice rows.",
        truncated: false,
      },
      {
        id: "alarm:outcome",
        kind: "outcome",
        body: "Reviewer blocked delivery and reported the observed unauthorized access. The review operation is marked failed because the candidate did not pass.",
        truncated: false,
      },
    ],
    targets: [],
  },
  {
    id: "calibration:missing",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: false,
    activity: "build",
    outcome: "completed",
    settledAt: "2026-10-26T00:00:00.000Z",
    evidence: [
      {
        id: "missing:task",
        kind: "task",
        body: "Implement payment refunds and verify duplicate requests.",
        truncated: false,
      },
      {
        id: "missing:summary",
        kind: "outcome",
        body: "Agent summary: done, all tests pass. No source, tool output, test results or independent observations are retained.",
        truncated: false,
      },
    ],
    targets: [],
  },
  {
    id: "calibration:green-diagnostics",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: true,
    activity: "build",
    outcome: "completed",
    settledAt: "2026-10-27T00:00:00.000Z",
    evidence: [
      {
        id: "diagnostics:task",
        kind: "task",
        truncated: false,
        body: "Repair and verify the Skill editor with no structural reactivity diagnostics.",
      },
      {
        id: "diagnostics:run",
        kind: "artifact",
        truncated: false,
        body: "Exact-candidate browser run: 49 cases passed. The same run emitted STRICT_READ_UNTRACKED in SkillRevisionEditor. It imported plain Playwright test and bypassed the diagnostic fixture. Adding the fixture made that case fail before the production repair.",
      },
      {
        id: "diagnostics:claim",
        kind: "outcome",
        truncated: false,
        body: "Agent reported that the Skill editor was fully verified with no reactivity issues.",
      },
    ],
    targets: [],
  },
  {
    id: "calibration:scope-mismatch",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: true,
    activity: "build",
    outcome: "completed",
    settledAt: "2026-10-27T00:00:00.000Z",
    evidence: [
      {
        id: "scope:task",
        kind: "task",
        truncated: false,
        body: "Implement and verify the UI change with unit and browser checks.",
      },
      {
        id: "scope:run",
        kind: "artifact",
        truncated: false,
        body: "Protected exact-candidate workflow recorded one successful unit job, attempt 1. Its browser job was skipped. No browser observations or implementation source were retained.",
      },
      {
        id: "scope:claim",
        kind: "outcome",
        truncated: false,
        body: "Agent reported all required unit and browser checks passed. The UI implementation itself has no observed defect or correctness proof.",
      },
    ],
    targets: [],
  },
  {
    id: "calibration:coverage-lost",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: true,
    activity: "build",
    outcome: "completed",
    settledAt: "2026-10-27T00:00:00.000Z",
    evidence: [
      {
        id: "lost:task",
        kind: "task",
        truncated: false,
        body: "Remove redundant test orchestration while preserving duplicate-payment regression coverage.",
      },
      {
        id: "lost:source",
        kind: "artifact",
        truncated: false,
        body: "Exact diff deletes the sole duplicate-payment assertion. No equivalent case remains. An owned replay of the old defect passes the remaining suite but double-charges the request.",
      },
      {
        id: "lost:claim",
        kind: "outcome",
        truncated: false,
        body: "Agent called the deleted test redundant because the remaining suite was green.",
      },
    ],
    targets: [],
  },
  {
    id: "calibration:coverage-preserved",
    projectId: "00000000-0000-4000-8000-000000000001",
    ownerId: null,
    developerOnly: true,
    activity: "build",
    outcome: "completed",
    settledAt: "2026-10-27T00:00:00.000Z",
    evidence: [
      {
        id: "preserved:task",
        kind: "task",
        truncated: false,
        body: "Remove duplicate browser wrappers and replace an opaque historical schema hash without losing defect detection.",
      },
      {
        id: "preserved:proof",
        kind: "artifact",
        truncated: false,
        body: "Exact runner mapping shows removed wrappers only re-executed 31 preserved browser cases 32 times. Canonical cases still run. Five behavior checks preserve build ownership and cleanup. The schema replacement compares fresh and repeated installs and tests typed columns, PostgreSQL invariants and the publication allowlist. Injecting a missing constraint fails the new check; healthy installs pass.",
      },
      {
        id: "preserved:outcome",
        kind: "outcome",
        truncated: false,
        body: "Owned canonical browser, ownership and installation checks passed. Coverage preservation was demonstrated, not inferred from fewer tests or a green total.",
      },
    ],
    targets: [],
  },
];
export function calibrationPassed(result: LearningResult) {
  const get = (id: string) => result.cases.find((item) => item.caseId === `calibration:${id}`);
  return (
    get("healthy")?.fulfillment === "supported" &&
    get("defect")?.fulfillment === "problem" &&
    get("false-alarm")?.fulfillment === "supported" &&
    get("false-alarm")?.rework !== "avoidable" &&
    get("missing")?.fulfillment === "unknown" &&
    get("missing")?.verification === "unknown" &&
    get("green-diagnostics")?.fulfillment === "problem" &&
    get("green-diagnostics")?.verification === "problem" &&
    get("scope-mismatch")?.fulfillment === "unknown" &&
    get("scope-mismatch")?.verification === "problem" &&
    get("coverage-lost")?.fulfillment === "problem" &&
    get("coverage-lost")?.verification === "problem" &&
    get("coverage-preserved")?.fulfillment === "supported" &&
    get("coverage-preserved")?.verification === "supported" &&
    get("coverage-preserved")?.rework !== "avoidable" &&
    !result.findings.some(
      (item) =>
        item.caseIds.includes("calibration:healthy") ||
        item.caseIds.includes("calibration:false-alarm") ||
        item.caseIds.includes("calibration:coverage-preserved"),
    )
  );
}
