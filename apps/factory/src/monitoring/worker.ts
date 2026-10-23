import type { createDatabase } from "../../../../packages/db/src/client";
import { z } from "zod";
import { createRequirementRevision } from "../../../../packages/requirement-domain/src/requirement";
import type { createAgentController } from "../agent/controller";
import type { createChangeController } from "../change/controller";
import { CommandError } from "../command-error";
import type { createDeliveryController } from "../delivery/controller";
import type { createKnowledgeController } from "../knowledge/controller";
import type { createMCPConnections } from "../mcp/connections";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { knownModelRejection } from "../models/execution-policy";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { projectModelConnection } from "../project-agent/adapter";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import { monitoringAuthorityIn } from "./authority";
import {
  clarifyProjectInput,
  inputClarification,
  inputSkillAssignment,
  type InputClarification,
} from "../project-agent/input";
import { createSkillController } from "../skills/controller";
import { admittedProjectContext } from "../project-agent/ticket-context";
import { ProjectAgentOutputError } from "../project-agent/structured-output";
import { ProjectContextLimitError } from "../project-agent/context";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { diagnoseMonitoringIncident, MonitoringDiagnosisError } from "./diagnosis";

type Database = ReturnType<typeof createDatabase>;
type Incident = {
  id: string;
  projectId: string;
  title: string;
  reference: string | null;
  context: string;
  ticketId: string | null;
  diagnosis: InputClarification | null;
};

export function createMonitoringWorker(
  database: Database,
  input: {
    mcp: ReturnType<typeof createMCPConnections>;
    code: Pick<ReturnType<typeof createKnowledgeController>, "codePaths" | "code">;
    changes: Pick<ReturnType<typeof createChangeController>, "start">;
    agent: Pick<ReturnType<typeof createAgentController>, "admitStartIn">;
    delivery: Pick<ReturnType<typeof createDeliveryController>, "get" | "approve">;
    signingKey: string;
    // Controlled controller tests replace inference, never production engines.
    diagnose?: typeof diagnoseMonitoringIncident;
    prepare?: typeof clarifyProjectInput;
  },
) {
  const models = createModelSettingsController(database);
  const skills = createSkillController(database);
  const connections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    input.signingKey,
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [],
  );
  const running = new Map<string, AbortController>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let sweeping = false;
  const usageId = (id: string) => `monitoring:${id}`;

  async function block(
    id: string,
    reason: string,
    state: "blocked" | "uncertain" = "blocked",
    token?: string,
  ) {
    await database.client`UPDATE factory.monitoring_incident SET state=${state},reason=${reason.slice(0, 2_000)},
      owner_token=NULL,owner_expires_at=NULL,settled_at=now()
      WHERE id=${id} AND state IN ('queued','diagnosing','implementing')
        AND (${token ?? null}::uuid IS NULL OR owner_token=${token ?? null})`;
  }

  async function commission(incident: Incident) {
    if (!incident.ticketId || !incident.diagnosis) return;
    const authority = await database.client.begin((sql) =>
      monitoringAuthorityIn(database, sql, incident.id),
    );
    const [revision] = await database.client<{ id: string }[]>`
      SELECT requirement_revision_id AS id FROM factory.requirement_approval
      WHERE ticket_id=${incident.ticketId} AND monitoring_incident_id=${incident.id} AND monitoring_policy_id=${authority.policyId}`;
    if (!revision) throw new CommandError("conflict", "Autofix requirements are no longer current");
    const baseSha = incident.diagnosis.code[0]?.commitSha;
    if (!baseSha)
      throw new CommandError("conflict", "Autofix diagnosis has no exact application source");
    await input.changes.start(incident.ticketId, authority.userId, {
      commandID: incident.id,
      revisionID: revision.id,
      expectedBaseSHA: baseSha,
      admitBuild: (sql, changeId) =>
        input.agent.admitStartIn(sql, changeId, authority.userId, incident.id),
    });
  }

  async function diagnose(incident: Incident, controller: AbortController) {
    const token = crypto.randomUUID();
    let admitted: {
      modelId: string;
      reference: Awaited<ReturnType<typeof connections.reference>>;
      skillAssignment: z.infer<typeof inputSkillAssignment>;
    } | null;
    try {
      admitted = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-project:${incident.projectId}`}))`;
        const [queued] =
          await sql`SELECT id FROM factory.monitoring_incident WHERE id=${incident.id} AND state='queued'`;
        if (!queued) return null;
        const [busy] =
          await sql`SELECT id FROM factory.monitoring_incident WHERE project_id=${incident.projectId}
          AND state IN ('diagnosing','implementing') LIMIT 1`;
        if (busy) return null;
        const authority = await monitoringAuthorityIn(database, sql, incident.id);
        // Intake locks Hook before Incident when counting duplicate deliveries.
        // Keep that order here and in every lease/result transaction.
        const [locked] = await sql`SELECT id FROM factory.monitoring_incident
          WHERE id=${incident.id} AND state='queued' FOR UPDATE`;
        if (!locked) return null;
        const modelId = await models.resolve("planning", sql, {
          projectID: incident.projectId,
          userID: authority.userId,
          personal: false,
        });
        const reference = await connections.reference("planning", sql);
        const assigned = await skills.resolveAssignment("planning", sql, {
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
        const [claimed] =
          await sql`UPDATE factory.monitoring_incident SET state='diagnosing',started_at=now(),
          model_id=${modelId},model_connection=${reference ? JSON.stringify(reference) : null}::jsonb,
          owner_token=${token},owner_expires_at=now()+interval '2 minutes',skill_assignment=${JSON.stringify(skillAssignment)}::jsonb
          WHERE id=${incident.id} AND state='queued' RETURNING id`;
        if (!claimed)
          throw new CommandError("conflict", "Monitoring diagnosis already has an owner");
        return { modelId, reference, skillAssignment };
      });
    } catch (cause) {
      if (cause instanceof CommandError)
        await database.client`UPDATE factory.monitoring_incident SET state='blocked',reason=${cause.message.slice(0, 2_000)},settled_at=now()
          WHERE id=${incident.id} AND state='queued'`;
      throw cause;
    }
    if (!admitted) return;
    const authorize = async () => {
      controller.signal.throwIfAborted();
      return database.client.begin(async (sql) => {
        const authority = await monitoringAuthorityIn(database, sql, incident.id);
        const [owned] = await sql`SELECT id FROM factory.monitoring_incident WHERE id=${incident.id}
          AND state='diagnosing' AND owner_token=${token} AND owner_expires_at > now() FOR UPDATE`;
        if (!owned)
          throw new CommandError("conflict", "Monitoring diagnosis lost execution ownership");
        await sql`UPDATE factory.monitoring_incident SET owner_expires_at=now()+interval '2 minutes'
          WHERE id=${incident.id} AND owner_token=${token}`;
        return authority;
      });
    };
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void authorize()
        .catch(() => controller.abort())
        .finally(() => {
          renewing = false;
        });
    }, 15_000);
    renewal.unref();
    try {
      const authority = await authorize();
      const connection = admitted.reference
        ? await connections.resolve(admitted.reference.connectionID, admitted.reference.version)
        : projectModelConnection();
      const common = {
        ...authority,
        title: incident.title,
        reference: incident.reference,
        context: incident.context,
        modelId: admitted.modelId,
        connection,
        code: input.code,
        mcp: input.mcp,
        signal: controller.signal,
        authorize: async () => {
          await authorize();
        },
        usage: recordedMastraUsage(database, {
          id: usageId(incident.id),
          projectID: incident.projectId,
          userID: authority.userId,
          purpose: "research",
          engine: "mastra",
          provider: connection.provider ?? "openai",
          model: admitted.modelId,
        }),
        observe: (value: { kind: string; digest: string; path?: string; commitSha?: string }) =>
          database.client.begin(async (sql) => {
            await monitoringAuthorityIn(database, sql, incident.id);
            const [owned] =
              await sql`SELECT id FROM factory.monitoring_incident WHERE id=${incident.id}
            AND state='diagnosing' AND owner_token=${token} AND owner_expires_at > now() FOR UPDATE`;
            if (!owned)
              throw new CommandError("conflict", "Monitoring observation lost execution ownership");
            await sql`INSERT INTO factory.monitoring_evidence(id,incident_id,kind,digest,path,commit_sha)
            VALUES(${crypto.randomUUID()},${incident.id},${value.kind},${value.digest},${value.path ?? null},${value.commitSha ?? null})`;
          }),
      };
      const result = inputClarification.parse(
        authority.delegation === "application-fix-and-delivery"
          ? await (input.diagnose ?? diagnoseMonitoringIncident)({
              ...common,
              assignment: authority.assignments[0]!,
              assignments: authority.assignments,
            })
          : await (input.prepare ?? clarifyProjectInput)({
              ...common,
              database,
              skills: await skills.load(admitted.skillAssignment.revisionIds),
              skillAssignment: admitted.skillAssignment,
            }),
      );
      await authorize();
      await database.client.begin(async (sql) => {
        const current = await monitoringAuthorityIn(database, sql, incident.id);
        const [owned] = await sql`SELECT id FROM factory.monitoring_incident WHERE id=${incident.id}
          AND state='diagnosing' AND owner_token=${token} AND owner_expires_at > now() FOR UPDATE`;
        if (!owned)
          throw new CommandError("conflict", "Monitoring result lost execution ownership");
        if (result.outcome !== "fix" && result.outcome !== "ticket") {
          await sql`UPDATE factory.monitoring_incident SET state=${result.outcome},reason=${result.explanation},
            diagnosis=${JSON.stringify(result)}::jsonb,owner_token=NULL,owner_expires_at=NULL,settled_at=now()
            WHERE id=${incident.id}`;
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
        await sql`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
          VALUES(${ticketId},${incident.projectId},${result.title},${description},'ready',${current.userId})`;
        await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          VALUES(${revision.id},${ticketId},1,${revision.canonicalContent},${revision.contentDigest},${current.userId})`;
        if (automatic)
          await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by,
          monitoring_incident_id,monitoring_policy_id)
          VALUES(${crypto.randomUUID()},${ticketId},${revision.id},${current.userId},${incident.id},${current.policyId})`;
        await sql`INSERT INTO factory.ticket_document_revision(id,ticket_id,ordinal,title,description,
          canonical_content,content_digest,requirement_revision_id,input_digest,created_by,author_kind)
          VALUES(${crypto.randomUUID()},${ticketId},1,${result.title},${description},${revision.canonicalContent},
            ${revision.contentDigest},${revision.id},${revision.contentDigest},${current.userId},'ai')`;
        await sql`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
          VALUES(${crypto.randomUUID()},${incident.projectId},${ticketId},${automatic ? "build" : "plan"},${current.userId})`;
        await sql`UPDATE factory.monitoring_incident SET state=${automatic ? "implementing" : "prepared"},ticket_id=${ticketId},
          diagnosis=${JSON.stringify(result)}::jsonb,reason=NULL,owner_token=NULL,owner_expires_at=NULL,
          settled_at=CASE WHEN ${automatic} THEN NULL ELSE now() END
          WHERE id=${incident.id}`;
      });
    } catch (cause) {
      const known =
        cause instanceof CommandError ||
        cause instanceof MonitoringDiagnosisError ||
        cause instanceof ProjectAgentOutputError ||
        cause instanceof ProjectContextLimitError ||
        cause instanceof z.ZodError ||
        knownModelRejection(cause);
      await block(
        incident.id,
        cause instanceof CommandError || cause instanceof MonitoringDiagnosisError
          ? cause.message
          : known
            ? "Input preparation was rejected. No automatic retry was started."
            : "Input preparation outcome is uncertain. No automatic retry was started.",
        known ? "blocked" : "uncertain",
        token,
      );
    } finally {
      clearInterval(renewal);
    }
  }

  async function implementation(incident: Incident) {
    const [change] = await database.client<{ id: string; state: string; humanWork: boolean }[]>`
      SELECT change.id,change.state,EXISTS(SELECT 1 FROM factory.agent_turn turn WHERE turn.change_id=change.id
        AND input->>'kind'='change-prompt') AS "humanWork" FROM factory.change change WHERE change.ticket_id=${incident.ticketId}`;
    if (!change) {
      await commission(incident);
      return;
    }
    const delivery = await input.delivery.get(change.id);
    if (change.state === "delivered") {
      await database.client`UPDATE factory.monitoring_incident SET state='delivered',reason=NULL,settled_at=now()
        WHERE id=${incident.id} AND state='implementing'`;
      return;
    }
    // An accepted merge is irreversible. Revocation does not abandon its
    // recorded promotion/cleanup or pretend that the default branch did not move.
    if (delivery?.["mergedCommitSha"]) return;
    if (delivery?.["mergeState"] === "failed") {
      await block(
        incident.id,
        "Automatic merge was not confirmed. The retained Change requires a human decision.",
      );
      return;
    }
    try {
      await database.client.begin((sql) => monitoringAuthorityIn(database, sql, incident.id));
    } catch (cause) {
      if (!(cause instanceof CommandError)) throw cause;
      await block(incident.id, cause.message);
      // Native execution observes the revoked turn authority and stops its
      // exact owner. A stale worker must not stop a newer human's Change turn.
      return;
    }
    if (change.humanWork || ["failed", "cancelled", "cancelling"].includes(change.state)) {
      await block(
        incident.id,
        change.humanWork
          ? "A human took over this Change. Automatic Delivery is disabled."
          : "Autofix stopped. The retained Ticket and source require a human decision.",
      );
      return;
    }
    if (change.state === "branch-pending" || change.state === "starting") return;
    if (
      delivery?.["verificationState"] === "succeeded" &&
      delivery["reviewState"] === "passed" &&
      !delivery["approvedAt"] &&
      !Number(delivery["openReviewThreads"])
    )
      await input.delivery.approve(
        change.id,
        (await database.client.begin((sql) => monitoringAuthorityIn(database, sql, incident.id)))
          .userId,
        incident.id,
      );
  }

  async function project(projectId: string) {
    if (closed || running.has(projectId)) return;
    const controller = new AbortController();
    running.set(projectId, controller);
    try {
      const active = await database.client<
        Incident[]
      >`SELECT id,project_id AS "projectId",title,reference,context,
        ticket_id AS "ticketId",diagnosis FROM factory.monitoring_incident WHERE project_id=${projectId}
        AND state='implementing' ORDER BY received_at,id LIMIT 1`;
      if (active[0]) {
        try {
          await implementation(active[0]);
        } catch (cause) {
          if (cause instanceof CommandError) await block(active[0].id, cause.message);
          else throw cause;
        }
        return;
      }
      const incident = await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-project:${projectId}`}))`;
        const [busy] =
          await sql`SELECT id FROM factory.monitoring_incident WHERE project_id=${projectId}
          AND state IN ('diagnosing','implementing')`;
        if (busy) return;
        const [next] = await sql<
          Incident[]
        >`SELECT id,project_id AS "projectId",title,reference,context,
          ticket_id AS "ticketId",diagnosis FROM factory.monitoring_incident WHERE project_id=${projectId}
          AND state='queued' ORDER BY received_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        // Claim is persisted in diagnose before the first provider request.
        return next;
      });
      if (incident) await diagnose(incident, controller);
    } finally {
      running.delete(projectId);
    }
  }
  async function sweep() {
    if (closed || sweeping) return;
    sweeping = true;
    try {
      const expired = await database.client<
        { id: string }[]
      >`UPDATE factory.monitoring_incident SET state='uncertain',
        reason='Diagnosis ownership expired. The provider outcome is unknown; no automatic retry was started.',
        owner_token=NULL,owner_expires_at=NULL,settled_at=now()
        WHERE state='diagnosing' AND owner_expires_at < now() RETURNING id`;
      for (const item of expired) await createUsageJournal(database).abandon(usageId(item.id));
      const projects = await database.client<{ id: string }[]>`SELECT DISTINCT project_id AS id
        FROM factory.monitoring_incident WHERE state IN ('queued','implementing') ORDER BY project_id LIMIT 50`;
      for (const row of projects) void project(row.id).catch(() => {});
    } finally {
      sweeping = false;
    }
  }
  return {
    project,
    sweep,
    async recover() {
      await sweep();
      interval = setInterval(() => void sweep().catch(() => {}), 2_000);
      interval.unref();
    },
    close() {
      closed = true;
      clearInterval(interval);
      for (const controller of running.values()) controller.abort();
    },
  };
}
