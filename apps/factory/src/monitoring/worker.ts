import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  notExists,
  notInArray,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  candidateReview,
  changeCommitOperation,
  change as changeTable,
  mergeOperation,
  monitoringEvidence,
  monitoringIncident,
  requirementApproval,
  requirementRevision,
  ticket,
  ticketConversation,
  ticketDocumentRevision,
} from "../../../../packages/db/src/schema";
import { createRequirementRevision } from "../../../../packages/requirement-domain/src/requirement";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import type { createAgentController } from "../agent/controller";
import type { createChangeController } from "../change/controller";
import { CommandError } from "../command-error";
import type { createDeliveryController } from "../delivery/controller";
import { reportFailure } from "../failure-log";
import type { createKnowledgeController } from "../knowledge/controller";
import type { createMCPConnections } from "../mcp/connections";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { knownModelRejection } from "../models/execution-policy";
import { installationPlanningConnection } from "../models/resolver";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { ProjectContextLimitError } from "../project-agent/context";
import {
  clarifyProjectInput,
  type InputClarification,
  inputClarification,
  type inputSkillAssignment,
} from "../project-agent/input";
import { ProjectAgentOutputError } from "../project-agent/structured-output";
import { admittedProjectContext } from "../project-agent/ticket-context";
import { createSkillController } from "../skills/controller";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import { monitoringAuthorityIn } from "./authority";
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
const incidentColumns = {
  id: monitoringIncident.id,
  projectId: monitoringIncident.projectId,
  title: monitoringIncident.title,
  reference: monitoringIncident.reference,
  context: monitoringIncident.context,
  ticketId: monitoringIncident.ticketId,
  diagnosis: query<InputClarification | null>`${monitoringIncident.diagnosis}`,
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
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let sweeping = false;
  let sweepCursor: string | undefined;
  const usageId = (id: string) => `monitoring:${id}`;

  async function block(
    id: string,
    reason: string,
    state: "blocked" | "uncertain" = "blocked",
    token?: string,
  ) {
    await database.db
      .update(monitoringIncident)
      .set({
        state,
        reason: reason.slice(0, 2_000),
        ownerToken: null,
        ownerExpiresAt: null,
        settledAt: query<Date>`now()`,
      })
      .where(
        and(
          eq(monitoringIncident.id, id),
          inArray(monitoringIncident.state, ["queued", "diagnosing", "implementing"]),
          token === undefined ? undefined : eq(monitoringIncident.ownerToken, token),
        ),
      );
  }

  async function commission(incident: Incident) {
    if (!incident.ticketId || !incident.diagnosis) return;
    const authority = await database.client.begin((sql) =>
      monitoringAuthorityIn(database, sql, incident.id),
    );
    const [revision] = await database.db
      .select({ id: requirementApproval.requirementRevisionId })
      .from(requirementApproval)
      .where(
        and(
          eq(requirementApproval.ticketId, incident.ticketId),
          eq(requirementApproval.monitoringIncidentId, incident.id),
          eq(requirementApproval.monitoringPolicyId, authority.policyId),
        ),
      );
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
        const db = drizzleTransaction(sql);
        await db.execute(
          query`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-project:${incident.projectId}`}))`,
        );
        const [queued] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.state, "queued")),
          );
        if (!queued) return null;
        const [busy] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(
              eq(monitoringIncident.projectId, incident.projectId),
              inArray(monitoringIncident.state, ["diagnosing", "implementing"]),
            ),
          )
          .limit(1);
        if (busy) return null;
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
      if (cause instanceof CommandError)
        await database.db
          .update(monitoringIncident)
          .set({
            state: "blocked",
            reason: cause.message.slice(0, 2_000),
            settledAt: query<Date>`now()`,
          })
          .where(
            and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.state, "queued")),
          );
      throw cause;
    }
    if (!admitted) return;
    const authorize = async () => {
      controller.signal.throwIfAborted();
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const authority = await monitoringAuthorityIn(database, sql, incident.id);
        const [owned] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(
              eq(monitoringIncident.id, incident.id),
              eq(monitoringIncident.state, "diagnosing"),
              eq(monitoringIncident.ownerToken, token),
              gt(monitoringIncident.ownerExpiresAt, query`now()`),
            ),
          )
          .for("update");
        if (!owned)
          throw new CommandError("conflict", "Monitoring diagnosis lost execution ownership");
        await db
          .update(monitoringIncident)
          .set({ ownerExpiresAt: query<Date>`now()+interval '2 minutes'` })
          .where(
            and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.ownerToken, token)),
          );
        return authority;
      });
    };
    let renewal: Promise<unknown> | undefined;
    const renewalTimer = setInterval(() => {
      if (renewal) return;
      renewal = authorize()
        .catch(() => controller.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, 15_000);
    renewalTimer.unref();
    try {
      const authority = await authorize();
      const connection = admitted.reference
        ? await connections.resolve(admitted.reference.connectionID, admitted.reference.version)
        : installationPlanningConnection();
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
            const db = drizzleTransaction(sql);
            await monitoringAuthorityIn(database, sql, incident.id);
            const [owned] = await db
              .select({ id: monitoringIncident.id })
              .from(monitoringIncident)
              .where(
                and(
                  eq(monitoringIncident.id, incident.id),
                  eq(monitoringIncident.state, "diagnosing"),
                  eq(monitoringIncident.ownerToken, token),
                  gt(monitoringIncident.ownerExpiresAt, query`now()`),
                ),
              )
              .for("update");
            if (!owned)
              throw new CommandError("conflict", "Monitoring observation lost execution ownership");
            await db.insert(monitoringEvidence).values({
              id: crypto.randomUUID(),
              incidentId: incident.id,
              kind: value.kind,
              digest: value.digest,
              path: value.path ?? null,
              commitSha: value.commitSha ?? null,
            });
          }),
      };
      const [assignment] = authority.assignments;
      if (authority.delegation === "application-fix-and-delivery" && !assignment)
        throw new CommandError("conflict", "Delegated Autofix requires an admitted source");
      const result = inputClarification.parse(
        authority.delegation === "application-fix-and-delivery" && assignment
          ? await (input.diagnose ?? diagnoseMonitoringIncident)({
              ...common,
              assignment,
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
        const db = drizzleTransaction(sql);
        const current = await monitoringAuthorityIn(database, sql, incident.id);
        const [owned] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(
              eq(monitoringIncident.id, incident.id),
              eq(monitoringIncident.state, "diagnosing"),
              eq(monitoringIncident.ownerToken, token),
              gt(monitoringIncident.ownerExpiresAt, query`now()`),
            ),
          )
          .for("update");
        if (!owned)
          throw new CommandError("conflict", "Monitoring result lost execution ownership");
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
        if (automatic)
          await db.insert(requirementApproval).values({
            id: crypto.randomUUID(),
            ticketId,
            requirementRevisionId: revision.id,
            approvedBy: current.userId,
            monitoringIncidentId: incident.id,
            monitoringPolicyId: current.policyId,
          });
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
      clearInterval(renewalTimer);
      await renewal;
    }
  }

  async function implementation(incident: Incident) {
    if (!incident.ticketId) return;
    const [change] = await database.db
      .select({
        id: changeTable.id,
        state: changeTable.state,
        humanWork: exists(
          database.db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, changeTable.id),
                eq(query<string>`${agentTurn.input}->>'kind'`, "change-prompt"),
              ),
            ),
        ),
      })
      .from(changeTable)
      .where(eq(changeTable.ticketId, incident.ticketId));
    if (!change) {
      await commission(incident);
      return;
    }
    const delivery = await input.delivery.get(change.id);
    if (change.state === "delivered") {
      await database.db
        .update(monitoringIncident)
        .set({ state: "delivered", reason: null, settledAt: query<Date>`now()` })
        .where(
          and(eq(monitoringIncident.id, incident.id), eq(monitoringIncident.state, "implementing")),
        );
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
    const reviewId = delivery?.["reviewId"];
    if (
      typeof reviewId === "string" &&
      delivery?.["reviewState"] === "incomplete" &&
      delivery["reviewCurrent"] === true
    ) {
      // Share admission's writer lock before rechecking the exact completed
      // review. A newer candidate or continuation keeps its own authority.
      await database.client.begin(async (sql) => {
        const writer = await lockChangeWriterIn(sql, change.id);
        if (!writer.available || writer.state === "human" || writer.state === "handoff") return;
        const db = drizzleTransaction(sql);
        const latestReview = alias(candidateReview, "latest_review");
        await db
          .update(monitoringIncident)
          .set({
            state: "blocked",
            reason:
              "Independent review is incomplete. The retained Change requires a human decision before retrying review or continuing Build.",
            ownerToken: null,
            ownerExpiresAt: null,
            settledAt: query<Date>`now()`,
          })
          .where(
            and(
              eq(monitoringIncident.id, incident.id),
              eq(monitoringIncident.state, "implementing"),
              exists(
                db
                  .select({ id: candidateReview.id })
                  .from(candidateReview)
                  .innerJoin(agentTurn, eq(agentTurn.id, candidateReview.turnId))
                  .where(
                    and(
                      eq(candidateReview.id, reviewId),
                      eq(candidateReview.changeId, change.id),
                      eq(candidateReview.state, "incomplete"),
                      eq(agentTurn.state, "completed"),
                      eq(
                        candidateReview.turnId,
                        db
                          .select({ id: agentTurn.id })
                          .from(agentTurn)
                          .where(eq(agentTurn.changeId, candidateReview.changeId))
                          .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
                          .limit(1),
                      ),
                      eq(
                        candidateReview.id,
                        db
                          .select({ id: latestReview.id })
                          .from(latestReview)
                          .where(eq(latestReview.verificationId, candidateReview.verificationId))
                          .orderBy(desc(latestReview.ordinal))
                          .limit(1),
                      ),
                      eq(
                        candidateReview.commitSha,
                        db
                          .select({ commitSha: changeCommitOperation.commitSha })
                          .from(changeCommitOperation)
                          .where(
                            and(
                              eq(changeCommitOperation.changeId, candidateReview.changeId),
                              eq(changeCommitOperation.state, "succeeded"),
                            ),
                          )
                          .orderBy(desc(changeCommitOperation.sequence))
                          .limit(1),
                      ),
                      notExists(
                        db
                          .select({ id: agentTurn.id })
                          .from(agentTurn)
                          .where(
                            and(
                              eq(agentTurn.changeId, candidateReview.changeId),
                              inArray(agentTurn.state, [
                                "pending",
                                "dispatching",
                                "running",
                                "uncertain",
                              ]),
                            ),
                          ),
                      ),
                      notExists(
                        db
                          .select({ id: changeCommitOperation.id })
                          .from(changeCommitOperation)
                          .where(
                            and(
                              eq(changeCommitOperation.changeId, candidateReview.changeId),
                              notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                            ),
                          ),
                      ),
                      notExists(
                        db
                          .select({ id: mergeOperation.id })
                          .from(mergeOperation)
                          .where(
                            and(
                              eq(mergeOperation.changeId, candidateReview.changeId),
                              isNotNull(mergeOperation.observedDefaultSha),
                            ),
                          ),
                      ),
                    ),
                  ),
              ),
            ),
          );
      });
      return;
    }
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

  function project(projectId: string): Promise<void> {
    if (closed) return Promise.resolve();
    const task = runProject(projectId);
    pending.add(task);
    const settled = () => {
      pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }

  async function runProject(projectId: string) {
    if (closed || running.has(projectId)) return;
    const controller = new AbortController();
    running.set(projectId, controller);
    try {
      const active = await database.db
        .select(incidentColumns)
        .from(monitoringIncident)
        .where(
          and(
            eq(monitoringIncident.projectId, projectId),
            eq(monitoringIncident.state, "implementing"),
          ),
        )
        .orderBy(asc(monitoringIncident.receivedAt), asc(monitoringIncident.id))
        .limit(1);
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
        const db = drizzleTransaction(sql);
        await db.execute(
          query`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-project:${projectId}`}))`,
        );
        const [busy] = await db
          .select({ id: monitoringIncident.id })
          .from(monitoringIncident)
          .where(
            and(
              eq(monitoringIncident.projectId, projectId),
              inArray(monitoringIncident.state, ["diagnosing", "implementing"]),
            ),
          );
        if (busy) return;
        const [next] = await db
          .select(incidentColumns)
          .from(monitoringIncident)
          .where(
            and(
              eq(monitoringIncident.projectId, projectId),
              eq(monitoringIncident.state, "queued"),
            ),
          )
          .orderBy(asc(monitoringIncident.receivedAt), asc(monitoringIncident.id))
          .limit(1)
          .for("update", { skipLocked: true });
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
      const expired = await database.db
        .update(monitoringIncident)
        .set({
          state: "uncertain",
          reason:
            "Diagnosis ownership expired. The provider outcome is unknown; no automatic retry was started.",
          ownerToken: null,
          ownerExpiresAt: null,
          settledAt: query<Date>`now()`,
        })
        .where(
          and(
            eq(monitoringIncident.state, "diagnosing"),
            lt(monitoringIncident.ownerExpiresAt, query`now()`),
          ),
        )
        .returning({ id: monitoringIncident.id });
      for (const item of expired) await createUsageJournal(database).abandon(usageId(item.id));
      const projects = await database.db
        .selectDistinct({ id: monitoringIncident.projectId })
        .from(monitoringIncident)
        .where(
          and(
            inArray(monitoringIncident.state, ["queued", "implementing"]),
            sweepCursor ? gt(monitoringIncident.projectId, sweepCursor) : undefined,
          ),
        )
        .orderBy(asc(monitoringIncident.projectId))
        .limit(50);
      if (sweepCursor && projects.length < 50)
        projects.push(
          ...(await database.db
            .selectDistinct({ id: monitoringIncident.projectId })
            .from(monitoringIncident)
            .where(
              and(
                inArray(monitoringIncident.state, ["queued", "implementing"]),
                lte(monitoringIncident.projectId, sweepCursor),
              ),
            )
            .orderBy(asc(monitoringIncident.projectId))
            .limit(50 - projects.length)),
        );
      // Advance past busy owners too, otherwise a persistent prefix starves the tail.
      sweepCursor = projects.at(-1)?.id;
      for (const row of projects)
        void project(row.id).catch(reportFailure("Monitoring project sweep"));
    } finally {
      sweeping = false;
    }
  }
  return {
    project,
    sweep,
    async recover() {
      await sweep();
    },
    close() {
      closed = true;
      for (const controller of running.values()) controller.abort();
      closing ??= Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}
