import { and, eq, sql as query } from "drizzle-orm";
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import {
  auditEvent,
  monitoringIncident,
  requirementApproval,
  requirementRevision,
  ticket,
  ticketConversation,
  ticketDocumentRevision,
} from "#db/schema";
import { createRequirementRevision } from "#requirement-domain/requirement";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { createKnowledgeController } from "../knowledge/api";
import type { createMCPConnections } from "../mcp/library-api";
import type { createModelConnections, createModelSettingsController } from "../models/api";
import { knownModelRejection } from "../models/execution-policy";
import { installationPlanningConnection } from "../models/resolver";
import {
  clarifyProjectInput,
  type InputClarification,
  inputClarification,
  type inputSkillAssignment,
} from "../project-agent/api";
import { admittedProjectContext, ProjectContextLimitError } from "../project-agent/context-api";
import { ProjectAgentOutputError } from "../project-agent/output-api";
import type { createSkillController } from "../skills/api";
import { recordedMastraUsage } from "../usage/record-mastra";
import { monitoringAuthorityIn } from "./authority";
import { diagnoseMonitoringIncident } from "./diagnosis";
import { MonitoringDiagnosisError } from "./diagnosis-contract";
import {
  createIncidentLease,
  type Database,
  hasBusyProjectIncidentIn,
  type Incident,
  lockMonitoringProjectIn,
  monitoringUsageId,
  requireOwnedDiagnosingIncidentIn,
  settleIncidentFailure,
} from "./worker-state";

type DiagnosisDeps = {
  mcp: ReturnType<typeof createMCPConnections>;
  code: Pick<ReturnType<typeof createKnowledgeController>, "codePaths" | "code">;
  models: ReturnType<typeof createModelSettingsController>;
  skills: ReturnType<typeof createSkillController>;
  connections: ReturnType<typeof createModelConnections>;
  diagnose?: typeof diagnoseMonitoringIncident;
  prepare?: typeof clarifyProjectInput;
};

type AdmittedDiagnosis = {
  modelId: string;
  reference: Awaited<ReturnType<ReturnType<typeof createModelConnections>["reference"]>>;
  skillAssignment: z.infer<typeof inputSkillAssignment>;
};

export function createIncidentDiagnoser(database: Database, deps: DiagnosisDeps) {
  async function admitDiagnosis(
    incident: Incident,
    token: string,
  ): Promise<AdmittedDiagnosis | null> {
    try {
      return await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await lockMonitoringProjectIn(db, incident.projectId);
        const [queued] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.state, "queued")),
          );
        if (!queued) return null;
        if (await hasBusyProjectIncidentIn(db, incident.projectId)) return null;
        const authority = await monitoringAuthorityIn(database, sql, incident.id);
        // Intake locks Hook before Incident when counting duplicate deliveries.
        // Keep that order here and in every lease/result transaction.
        const [locked] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.state, "queued")),
          )
          .for("update");
        if (!locked) return null;
        const modelId = await deps.models.resolve("planning", sql, {
          projectID: incident.projectId,
          userID: authority.userId,
          personal: false,
        });
        const reference = await deps.connections.reference("planning", sql);
        const assigned = await deps.skills.resolveAssignment("planning", sql, {
          projectID: incident.projectId,
          userID: authority.userId,
          personal: false,
        });
        let codeAccess = false;
        try {
          await projectDevelopmentAuthorityIn(sql, authority.userId, incident.projectId);
          codeAccess = true;
        } catch (cause) {
          if (!(cause instanceof CommandError) || cause.code !== "forbidden") throw cause;
        }
        const skillAssignment = {
          ...assigned,
          projectContext: await admittedProjectContext(sql, incident.projectId, null),
          codeAccess,
        };
        const [claimed] = await db
          .update(monitoringIncident)
          .set({
            state: "diagnosing",
            startedAt: query<Date>`now()`,
            modelId,
            modelConnection: reference,
            ownerToken: token,
            ownerExpiresAt: query<Date>`now()+interval '2 minutes'`,
            skillAssignment,
          })
          .where(
            and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.state, "queued")),
          )
          .returning({ id: monitoringIncident.id });
        if (!claimed)
          throw new CommandError("conflict", "Monitoring diagnosis already has an owner");
        return { modelId, reference, skillAssignment };
      });
    } catch (cause) {
      if (cause instanceof CommandError) {
        await settleIncidentFailure(database, incident.id, cause.message, "blocked", {
          allowedFrom: ["queued"],
        });
      }
      throw cause;
    }
  }

  async function recordObservation(
    incidentId: string,
    token: string,
    value: { kind: string; digest: string; path?: string; commitSha?: string },
  ) {
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const current = await monitoringAuthorityIn(database, sql, incidentId);
      if (!/^[a-f0-9]{64}$/.test(value.digest))
        throw new CommandError("conflict", "Invalid monitoring evidence digest");
      await requireOwnedDiagnosingIncidentIn(
        db,
        incidentId,
        token,
        "Monitoring observation lost execution ownership",
      );
      await db.insert(auditEvent).values({
        id: crypto.randomUUID(),
        kind: "monitoring.evidence",
        scopeType: "incident",
        scopeId: incidentId,
        actorId: current.userId,
        payload: {
          kind: value.kind,
          digest: value.digest,
          path: value.path ?? null,
          commitSha: value.commitSha ?? null,
        },
      });
    });
  }

  async function persistOutcome(incident: Incident, token: string, result: InputClarification) {
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const current = await monitoringAuthorityIn(database, sql, incident.id);
      await requireOwnedDiagnosingIncidentIn(
        db,
        incident.id,
        token,
        "Monitoring result lost execution ownership",
      );
      if (result.outcome !== "fix" && result.outcome !== "ticket") {
        await db
          .update(monitoringIncident)
          .set({
            state: result.outcome,
            reason: result.explanation,
            diagnosis: result,
            ownerToken: null,
            ownerExpiresAt: null,
            settledAt: query<Date>`now()`,
          })
          .where(eq(monitoringIncident.id, incident.id));
        return;
      }
      const automatic =
        current.delegation === "application-fix-and-delivery" && result.outcome === "fix";
      if (!result.requirements || (automatic && !result.code.length))
        throw new MonitoringDiagnosisError();
      const ticketId = crypto.randomUUID();
      const revision = createRequirementRevision({
        id: crypto.randomUUID(),
        ticketId,
        ordinal: 1,
        content: result.requirements,
      });
      const description = `${automatic ? "Autofix commissioned by an explicit Project Input delegation." : "Prepared by the Project Harness from an external Input. Implementation requires approval."}\n\n${result.explanation}${
        incident.reference ? `\n\nSource: ${incident.reference}` : ""
      }`;
      await db.insert(ticket).values({
        id: ticketId,
        projectId: incident.projectId,
        title: result.title,
        description,
        state: "ready",
        createdBy: current.userId,
      });
      await db.insert(requirementRevision).values({
        id: revision.id,
        ticketId,
        ordinal: 1,
        canonicalContent: revision.canonicalContent,
        contentDigest: revision.contentDigest,
        createdBy: current.userId,
      });
      if (automatic) {
        await db.insert(requirementApproval).values({
          id: crypto.randomUUID(),
          ticketId,
          requirementRevisionId: revision.id,
          approvedBy: current.userId,
          monitoringIncidentId: incident.id,
          monitoringPolicyId: current.policyId,
        });
      }
      await db.insert(ticketDocumentRevision).values({
        id: crypto.randomUUID(),
        ticketId,
        ordinal: 1,
        title: result.title,
        description,
        canonicalContent: revision.canonicalContent,
        contentDigest: revision.contentDigest,
        requirementRevisionId: revision.id,
        inputDigest: revision.contentDigest,
        createdBy: current.userId,
        authorKind: "ai",
      });
      await db.insert(ticketConversation).values({
        id: crypto.randomUUID(),
        projectId: incident.projectId,
        ticketId,
        mode: automatic ? "build" : "plan",
        createdBy: current.userId,
      });
      await db
        .update(monitoringIncident)
        .set({
          state: automatic ? "implementing" : "prepared",
          ticketId,
          diagnosis: result,
          reason: null,
          ownerToken: null,
          ownerExpiresAt: null,
          settledAt: automatic ? null : query<Date>`now()`,
        })
        .where(eq(monitoringIncident.id, incident.id));
    });
  }

  return async function diagnose(incident: Incident, controller: AbortController) {
    const token = crypto.randomUUID();
    const admitted = await admitDiagnosis(incident, token);
    if (!admitted) return;
    const lease = createIncidentLease(database, incident.id, token, controller);
    try {
      const authority = await lease.authorize();
      const connection = admitted.reference
        ? await deps.connections.resolve(
            admitted.reference.connectionID,
            admitted.reference.version,
          )
        : installationPlanningConnection();
      const common = {
        ...authority,
        title: incident.title,
        reference: incident.reference,
        context: incident.context,
        modelId: admitted.modelId,
        connection,
        code: deps.code,
        mcp: deps.mcp,
        signal: controller.signal,
        authorize: async () => {
          await lease.authorize();
        },
        usage: recordedMastraUsage(database, {
          id: monitoringUsageId(incident.id),
          projectID: incident.projectId,
          userID: authority.userId,
          purpose: "research",
          engine: "mastra",
          provider: connection.provider ?? "openai",
          model: admitted.modelId,
        }),
        observe: (value: { kind: string; digest: string; path?: string; commitSha?: string }) =>
          recordObservation(incident.id, token, value),
      };
      const [assignment] = authority.assignments;
      if (authority.delegation === "application-fix-and-delivery" && !assignment)
        throw new CommandError("conflict", "Delegated Autofix requires an admitted source");
      const result = inputClarification.parse(
        authority.delegation === "application-fix-and-delivery" && assignment
          ? await (deps.diagnose ?? diagnoseMonitoringIncident)({
              ...common,
              assignment,
              assignments: authority.assignments,
            })
          : await (deps.prepare ?? clarifyProjectInput)({
              ...common,
              database,
              skills: await deps.skills.load(admitted.skillAssignment.revisionIds),
              skillAssignment: admitted.skillAssignment,
            }),
      );
      await lease.authorize();
      await persistOutcome(incident, token, result);
    } catch (cause) {
      const known =
        cause instanceof CommandError ||
        cause instanceof MonitoringDiagnosisError ||
        cause instanceof ProjectAgentOutputError ||
        cause instanceof ProjectContextLimitError ||
        cause instanceof z.ZodError ||
        knownModelRejection(cause);
      await settleIncidentFailure(
        database,
        incident.id,
        cause instanceof CommandError || cause instanceof MonitoringDiagnosisError
          ? cause.message
          : known
            ? "Input preparation was rejected. No automatic retry was started."
            : "Input preparation outcome is uncertain. No automatic retry was started.",
        known ? "blocked" : "uncertain",
        { token },
      );
    } finally {
      await lease.stop();
    }
  };
}
