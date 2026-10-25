import { z } from "zod";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/requirement";

export const monitoringDiagnosis = z
  .object({
    outcome: z.enum(["fix", "insufficient-context", "not-application-defect"]),
    explanation: z.string().trim().min(1).max(4_000),
    title: z.string().trim().min(1).max(200),
    requirements: requirementContentInput.nullable(),
    code: z.array(z.object({ path: z.string(), commitSha: z.string() }).strict()).max(12),
  })
  .strict();
export type MonitoringDiagnosis = z.infer<typeof monitoringDiagnosis>;

export class MonitoringDiagnosisError extends Error {
  constructor() {
    super("Diagnosis did not establish the monitoring incident and exact application source");
    this.name = "MonitoringDiagnosisError";
  }
}

export async function diagnoseMonitoringIncident(
  input: Parameters<typeof import("./diagnosis-engine").diagnoseMonitoringIncident>[0],
) {
  input.signal.throwIfAborted();
  const { diagnoseMonitoringIncident: diagnose } = await import("./diagnosis-engine");
  input.signal.throwIfAborted();
  return diagnose(input);
}
