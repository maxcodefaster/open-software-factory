import type {
  LearningCase,
  LearningResult,
} from "../../../../packages/conversation-domain/src/learning";

// These are fixed product checks, never editable by the optimizer. They test
// clean work, a real defect, a false alarm, and an unsupported success claim.
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
    !result.findings.some(
      (item) =>
        item.caseIds.includes("calibration:healthy") ||
        item.caseIds.includes("calibration:false-alarm"),
    )
  );
}
