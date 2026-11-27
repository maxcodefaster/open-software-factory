import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { monitoringIncident } from "#db/schema";
import type { createAgentController } from "../agent/api";
import type { createChangeController } from "../change/api";
import { CommandError } from "../command-error";
import type { createDeliveryController } from "../delivery/api";
import { reportFailure } from "../failure-log";
import type { createKnowledgeController } from "../knowledge/api";
import type { createMCPConnections } from "../mcp/library-api";
import {
  createModelConnections,
  createModelSettingsController,
  createOpenBaoModelSecrets,
} from "../models/api";
import type { clarifyProjectInput } from "../project-agent/api";
import { createSkillController } from "../skills/api";
import { createUsageJournal } from "../usage/journal-api";
import type { diagnoseMonitoringIncident } from "./diagnosis";
import { createIncidentAutofix } from "./worker-autofix";
import { createIncidentDiagnoser } from "./worker-diagnose";
import {
  type Database,
  expireStaleDiagnoses,
  hasBusyProjectIncidentIn,
  incidentColumns,
  lockMonitoringProjectIn,
  monitoringUsageId,
  SWEEPABLE_INCIDENT_STATES,
  settleIncidentFailure,
} from "./worker-state";

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
  const diagnose = createIncidentDiagnoser(database, {
    mcp: input.mcp,
    code: input.code,
    models,
    skills,
    connections,
    ...(input.diagnose ? { diagnose: input.diagnose } : {}),
    ...(input.prepare ? { prepare: input.prepare } : {}),
  });
  const advanceImplementation = createIncidentAutofix(database, {
    changes: input.changes,
    agent: input.agent,
    delivery: input.delivery,
  });

  const running = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let sweeping = false;
  let sweepCursor: string | undefined;

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
      const [active] = await database.db
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
      if (active) {
        try {
          await advanceImplementation(active);
        } catch (cause) {
          if (cause instanceof CommandError)
            await settleIncidentFailure(database, active.id, cause.message);
          else throw cause;
        }
        return;
      }
      const incident = await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await lockMonitoringProjectIn(db, projectId);
        if (await hasBusyProjectIncidentIn(db, projectId)) return;
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
      const expired = await expireStaleDiagnoses(database);
      for (const item of expired)
        await createUsageJournal(database).abandon(monitoringUsageId(item.id));
      const projects = await database.db
        .selectDistinct({ id: monitoringIncident.projectId })
        .from(monitoringIncident)
        .where(
          and(
            inArray(monitoringIncident.state, [...SWEEPABLE_INCIDENT_STATES]),
            sweepCursor ? gt(monitoringIncident.projectId, sweepCursor) : undefined,
          ),
        )
        .orderBy(asc(monitoringIncident.projectId))
        .limit(50);
      if (sweepCursor && projects.length < 50) {
        projects.push(
          ...(await database.db
            .selectDistinct({ id: monitoringIncident.projectId })
            .from(monitoringIncident)
            .where(
              and(
                inArray(monitoringIncident.state, [...SWEEPABLE_INCIDENT_STATES]),
                lte(monitoringIncident.projectId, sweepCursor),
              ),
            )
            .orderBy(asc(monitoringIncident.projectId))
            .limit(50 - projects.length)),
        );
      }
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
