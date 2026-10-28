import type { VerificationReceipt } from "../../packages/conversation-domain/src/verification";

export function verificationReceipt(
  commit: string,
  changes: Partial<VerificationReceipt> = {},
): VerificationReceipt {
  return {
    commit,
    runId: 1,
    workflow: "factory-verification.yml",
    status: "success",
    complete: true,
    jobs: [
      {
        id: 8,
        attempt: 1,
        name: "Unit checks",
        status: "success",
        steps: [{ number: 1, name: "unit", status: "success" }],
      },
    ],
    changes: { baseCommit: "a".repeat(40), tests: false, ci: false, removedTests: false },
    ...changes,
  };
}
