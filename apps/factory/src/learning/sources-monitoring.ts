import { and, eq, isNotNull, sql as typedSQL } from "drizzle-orm";
import { monitoringHook, monitoringIncident, monitoringPolicy } from "#db/schema";
import type {
  EvidenceCollector,
  LearningDrizzle,
  SnapshotMetadata,
  SourceOperation,
} from "./sources-types";

export async function collectMonitoringEvidence(
  db: LearningDrizzle,
  operation: SourceOperation,
  incidentId: string,
  collector: EvidenceCollector,
): Promise<SnapshotMetadata | null> {
  const [incident] = await db
    .select({
      state: monitoringIncident.state,
      title: monitoringIncident.title,
      instructions: monitoringPolicy.instructions,
      payloadDigest: monitoringIncident.payloadDigest,
      diagnosis: monitoringIncident.diagnosis,
      reason: monitoringIncident.reason,
      assignment: typedSQL<Record<string, unknown>>`jsonb_build_object(
        'revisionIds',${monitoringIncident.skillAssignment}->'revisionIds',
        'requiredRevisionIds',${monitoringIncident.skillAssignment}->'requiredRevisionIds',
        'codeAccess',${monitoringIncident.skillAssignment}->'codeAccess')`,
      policyId: monitoringIncident.policyId,
      hookId: monitoringHook.id,
      version: monitoringHook.version,
      current: eq(monitoringHook.policyId, monitoringPolicy.id),
    })
    .from(monitoringIncident)
    .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, monitoringIncident.policyId))
    .innerJoin(monitoringHook, eq(monitoringHook.id, monitoringPolicy.hookId))
    .where(
      and(
        eq(monitoringIncident.id, incidentId),
        eq(monitoringIncident.projectId, operation.projectId),
        isNotNull(monitoringIncident.settledAt),
      ),
    );
  if (!incident) return null;

  const assignment = incident.assignment as Record<string, unknown> | null;
  const diagnosis = incident.diagnosis as Record<string, unknown> | null;
  const developerOnly =
    assignment?.["codeAccess"] === true ||
    (Array.isArray(diagnosis?.["code"]) && diagnosis["code"].length > 0);

  // Raw webhook context is not a shared UI projection and may contain
  // credentials. Review the saved task and published outcome, not that body.
  collector.add(`input:${incidentId}:task`, "task", {
    title: incident.title,
    instructions: incident.instructions,
  });
  collector.add(
    `input:${incidentId}:outcome`,
    "outcome",
    { state: incident.state, diagnosis: incident.diagnosis, reason: incident.reason },
    8_000,
  );
  collector.add(`input:${incidentId}:configuration`, "configuration", {
    policyId: incident.policyId,
    payloadDigest: incident.payloadDigest,
    revisionIds: assignment?.["revisionIds"],
    requiredRevisionIds: assignment?.["requiredRevisionIds"],
    codeAccess: assignment?.["codeAccess"],
    omitted: "Raw webhook context and private admission context are not shared work evidence.",
  });
  if (incident.current)
    collector.editable(
      {
        kind: "input",
        id: incident.hookId,
        revisionId: incident.policyId,
        version: incident.version,
        field: "instructions",
      },
      `input:${incidentId}:task`,
      incident.instructions,
    );

  return {
    ownerId: null,
    developerOnly,
    activity: "input",
    outcome: operation.outcome,
    settledAt: operation.settledAt,
    nativeTurnID: null,
  };
}
