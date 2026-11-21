import type { MonitoringDiagnosisInput } from "./diagnosis-contract";

export async function diagnoseMonitoringIncident(input: MonitoringDiagnosisInput) {
  input.signal.throwIfAborted();
  const { diagnoseMonitoringIncident: diagnose } = await import("./diagnosis-engine");
  input.signal.throwIfAborted();
  return diagnose(input);
}
