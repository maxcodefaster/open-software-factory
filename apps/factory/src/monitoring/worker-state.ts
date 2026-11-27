import { and, eq, gt, inArray, lt, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { monitoringIncident } from "#db/schema";
import { CommandError } from "../command-error";
import type { InputClarification } from "../project-agent/api";
import { monitoringAuthorityIn } from "./authority";

export type Database = ReturnType<typeof createDatabase>;
export type TransactionDb = ReturnType<typeof drizzleTransaction>;

export type IncidentState =
  | "queued"
  | "diagnosing"
  | "insufficient-context"
  | "not-application-defect"
  | "prepared"
  | "implementing"
  | "delivered"
  | "blocked"
  | "uncertain";

export const ACTIVE_INCIDENT_STATES = ["queued", "diagnosing", "implementing"] as const;
export const BUSY_INCIDENT_STATES = ["diagnosing", "implementing"] as const;
export const SWEEPABLE_INCIDENT_STATES = ["queued", "implementing"] as const;

export const INCIDENT_TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  queued: ["diagnosing", "blocked", "uncertain"],
  diagnosing: [
    "insufficient-context",
    "not-application-defect",
    "prepared",
    "implementing",
    "blocked",
    "uncertain",
  ],
  implementing: ["delivered", "blocked", "uncertain"],
  "insufficient-context": [],
  "not-application-defect": [],
  prepared: [],
  delivered: [],
  blocked: [],
  uncertain: [],
};

export function canTransitionIncidentState(from: IncidentState, to: IncidentState): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export type Incident = {
  id: string;
  projectId: string;
  title: string;
  reference: string | null;
  context: string;
  ticketId: string | null;
  diagnosis: InputClarification | null;
};

export const incidentColumns = {
  id: monitoringIncident.id,
  projectId: monitoringIncident.projectId,
  title: monitoringIncident.title,
  reference: monitoringIncident.reference,
  context: monitoringIncident.context,
  ticketId: monitoringIncident.ticketId,
  diagnosis: query<InputClarification | null>`${monitoringIncident.diagnosis}`,
};

export const monitoringUsageId = (id: string) => `monitoring:${id}`;

export async function lockMonitoringProjectIn(db: TransactionDb, projectId: string): Promise<void> {
  await db.execute(
    query`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-project:${projectId}`}))`,
  );
}

export async function hasBusyProjectIncidentIn(
  db: TransactionDb,
  projectId: string,
): Promise<boolean> {
  const [busy] = await db
    .select({ id: monitoringIncident.id })
    .from(monitoringIncident)
    .where(
      and(
        eq(monitoringIncident.projectId, projectId),
        inArray(monitoringIncident.state, [...BUSY_INCIDENT_STATES]),
      ),
    )
    .limit(1);
  return Boolean(busy);
}

export async function requireOwnedDiagnosingIncidentIn(
  db: TransactionDb,
  incidentId: string,
  token: string,
  lostMessage: string,
): Promise<void> {
  const [owned] = await db
    .select({ id: monitoringIncident.id })
    .from(monitoringIncident)
    .where(
      and(
        eq(monitoringIncident.id, incidentId),
        eq(monitoringIncident.state, "diagnosing"),
        eq(monitoringIncident.ownerToken, token),
        gt(monitoringIncident.ownerExpiresAt, query`now()`),
      ),
    )
    .for("update");
  if (!owned) throw new CommandError("conflict", lostMessage);
}

export async function settleIncidentFailure(
  database: Database,
  id: string,
  reason: string,
  state: "blocked" | "uncertain" = "blocked",
  options: { token?: string; allowedFrom?: readonly IncidentState[] } = {},
): Promise<void> {
  const allowedFrom = options.allowedFrom ?? ACTIVE_INCIDENT_STATES;
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
        inArray(monitoringIncident.state, [...allowedFrom]),
        options.token === undefined ? undefined : eq(monitoringIncident.ownerToken, options.token),
      ),
    );
}

export async function markIncidentDelivered(database: Database, id: string): Promise<void> {
  await database.db
    .update(monitoringIncident)
    .set({ state: "delivered", reason: null, settledAt: query<Date>`now()` })
    .where(and(eq(monitoringIncident.id, id), eq(monitoringIncident.state, "implementing")));
}

export async function expireStaleDiagnoses(database: Database): Promise<{ id: string }[]> {
  return database.db
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
}

export function createIncidentLease(
  database: Database,
  incidentId: string,
  token: string,
  controller: AbortController,
) {
  const authorize = async () => {
    controller.signal.throwIfAborted();
    return database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const authority = await monitoringAuthorityIn(database, sql, incidentId);
      await requireOwnedDiagnosingIncidentIn(
        db,
        incidentId,
        token,
        "Monitoring diagnosis lost execution ownership",
      );
      await db
        .update(monitoringIncident)
        .set({ ownerExpiresAt: query<Date>`now()+interval '2 minutes'` })
        .where(
          and(eq(monitoringIncident.id, incidentId), eq(monitoringIncident.ownerToken, token)),
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
  return {
    authorize,
    async stop() {
      clearInterval(renewalTimer);
      await renewal;
    },
  };
}
