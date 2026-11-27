import { and, desc, eq, sql as expression, inArray } from "drizzle-orm";
import type { createDatabase, drizzleTransaction } from "#db/client";
import { auditEvent, operation } from "#db/schema";
import { type SetupInspectionOutput, setupInspectionView } from "#project-domain/setup";

export type Database = ReturnType<typeof createDatabase>;
export type InspectionDb = Database["db"] | ReturnType<typeof drizzleTransaction>;

export const SETUP_INSPECTION_KIND = "project.setup_inspection";
export const ACTIVE_INSPECTION_STATES = ["inspecting", "proposal", "confirming"] as const;

export type InspectionState =
  | "inspecting"
  | "complete"
  | "proposal"
  | "failed"
  | "confirming"
  | "confirmed"
  | "superseded";

export const INSPECTION_TRANSITIONS: Record<InspectionState, readonly InspectionState[]> = {
  inspecting: ["proposal", "failed", "superseded"],
  proposal: ["confirming", "superseded"],
  confirming: ["confirmed"],
  complete: [],
  failed: [],
  confirmed: [],
  superseded: [],
};

export function canTransitionInspectionState(from: InspectionState, to: InspectionState): boolean {
  return INSPECTION_TRANSITIONS[from].includes(to);
}

export function setupInspectionKey(id: string) {
  return `${SETUP_INSPECTION_KIND}:${id}`;
}

export function setupInspectionActiveKey(projectID: string, state: InspectionState) {
  return (ACTIVE_INSPECTION_STATES as readonly string[]).includes(state)
    ? `${SETUP_INSPECTION_KIND}:${projectID}`
    : null;
}

export const inspectionOperationFields = {
  id: operation.id,
  scopeId: operation.scopeId,
  state: operation.state,
  createdBy: operation.createdBy,
  payload: operation.payload,
};

export type InspectionRow = ReturnType<typeof toInspectionRow>;

export function toInspectionRow(op: {
  id: string;
  scopeId: string;
  state: string;
  createdBy: string | null;
  payload: Record<string, unknown>;
}) {
  const payload = op.payload;
  const projectID = typeof payload["projectId"] === "string" ? payload["projectId"] : op.scopeId;
  const sourceCommit = typeof payload["sourceCommit"] === "string" ? payload["sourceCommit"] : "";
  const output = payload["output"] ?? null;
  const failure = typeof payload["failure"] === "string" ? payload["failure"] : null;
  const modelID = typeof payload["modelId"] === "string" ? payload["modelId"] : null;
  const connectionID = typeof payload["connectionId"] === "string" ? payload["connectionId"] : null;
  const rawVersion = payload["connectionVersion"];
  const connectionVersion =
    typeof rawVersion === "number"
      ? rawVersion
      : typeof rawVersion === "string" && rawVersion.length > 0
        ? Number(rawVersion)
        : null;
  const parentID = typeof payload["parentId"] === "string" ? payload["parentId"] : null;
  const rawAnswers = payload["answers"];
  const answers =
    rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)
      ? (rawAnswers as Record<string, string>)
      : {};
  const userID =
    typeof payload["createdBy"] === "string" ? payload["createdBy"] : (op.createdBy ?? "");
  return {
    id: op.id,
    projectID,
    sourceCommit,
    state: op.state as InspectionState,
    output,
    failure,
    modelID,
    connectionID,
    connectionVersion,
    userID,
    parentID,
    answers,
  };
}

export function toInspectionView(mapped: InspectionRow) {
  return setupInspectionView.parse({
    id: mapped.id,
    projectID: mapped.projectID,
    sourceCommit: mapped.sourceCommit,
    state: mapped.state,
    output: mapped.output,
    failure: mapped.failure,
  });
}

export async function loadInspectionRow(
  db: InspectionDb,
  id: string,
  lock = false,
): Promise<InspectionRow | undefined> {
  const base = db
    .select(inspectionOperationFields)
    .from(operation)
    .where(and(eq(operation.id, id), eq(operation.kind, SETUP_INSPECTION_KIND)));
  const [value] = lock ? await base.for("update") : await base;
  return value ? toInspectionRow(value) : undefined;
}

export async function loadLatestInspection(db: InspectionDb, projectID: string) {
  const [value] = await db
    .select(inspectionOperationFields)
    .from(operation)
    .where(
      and(
        eq(operation.kind, SETUP_INSPECTION_KIND),
        eq(operation.scopeType, "project"),
        eq(operation.scopeId, projectID),
      ),
    )
    .orderBy(desc(operation.createdAt))
    .limit(1);
  return value ? toInspectionView(toInspectionRow(value)) : null;
}

export async function hasActiveInspection(db: InspectionDb, projectID: string): Promise<boolean> {
  const active = await db
    .select({ id: operation.id })
    .from(operation)
    .where(
      and(
        eq(operation.kind, SETUP_INSPECTION_KIND),
        eq(operation.scopeType, "project"),
        eq(operation.scopeId, projectID),
        inArray(operation.state, [...ACTIVE_INSPECTION_STATES]),
      ),
    );
  return active.length > 0;
}

export async function transitionInspectionToProposal(
  db: InspectionDb,
  id: string,
  projectID: string,
  output: SetupInspectionOutput,
) {
  await db
    .update(operation)
    .set({
      state: "proposal",
      activeKey: setupInspectionActiveKey(projectID, "proposal"),
      payload: expression`jsonb_set(${operation.payload}, '{output}', ${JSON.stringify(output)}::jsonb, true)`,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.id, id),
        eq(operation.kind, SETUP_INSPECTION_KIND),
        eq(operation.state, "inspecting"),
      ),
    );
}

export async function transitionInspectionToFailed(db: InspectionDb, id: string, failure: string) {
  await db
    .update(operation)
    .set({
      state: "failed",
      activeKey: null,
      error: failure,
      payload: expression`jsonb_set(${operation.payload}, '{failure}', to_jsonb(${failure}::text), true)`,
      completedAt: expression`now()`,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.id, id),
        eq(operation.kind, SETUP_INSPECTION_KIND),
        eq(operation.state, "inspecting"),
      ),
    );
}

export async function transitionInspectionToSuperseded(
  db: InspectionDb,
  id: string,
  fromStates: readonly ("inspecting" | "proposal")[],
  clearFailure = false,
) {
  await db
    .update(operation)
    .set({
      state: "superseded",
      activeKey: null,
      ...(clearFailure
        ? {
            error: null,
            payload: expression`jsonb_set(${operation.payload}, '{failure}', 'null'::jsonb, true)`,
          }
        : {}),
      completedAt: expression`now()`,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.id, id),
        eq(operation.kind, SETUP_INSPECTION_KIND),
        inArray(operation.state, [...fromStates]),
      ),
    );
}

export async function transitionInspectionToConfirmingIn(
  tx: InspectionDb,
  id: string,
  projectID: string,
  userID: string,
) {
  await tx
    .insert(auditEvent)
    .values({
      id: crypto.randomUUID(),
      kind: "projects.setup_confirmation",
      scopeType: "project",
      scopeId: projectID,
      dedupeKey: `projects.setup_confirmation:${id}`,
      actorId: userID,
      payload: { inspectionId: id },
    })
    .onConflictDoNothing({ target: auditEvent.dedupeKey });
  await tx
    .update(operation)
    .set({
      state: "confirming",
      activeKey: setupInspectionActiveKey(projectID, "confirming"),
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.id, id),
        eq(operation.kind, SETUP_INSPECTION_KIND),
        eq(operation.state, "proposal"),
      ),
    );
}

export async function transitionInspectionToConfirmed(db: InspectionDb, id: string) {
  await db
    .update(operation)
    .set({
      state: "confirmed",
      activeKey: null,
      error: null,
      payload: expression`jsonb_set(${operation.payload}, '{failure}', 'null'::jsonb, true)`,
      completedAt: expression`now()`,
      updatedAt: expression`now()`,
    })
    .where(
      and(
        eq(operation.id, id),
        eq(operation.kind, SETUP_INSPECTION_KIND),
        eq(operation.state, "confirming"),
      ),
    );
}

export async function listConfirmedOrCompleteInspections(
  db: InspectionDb,
): Promise<InspectionRow[]> {
  const rows = await db
    .select(inspectionOperationFields)
    .from(operation)
    .where(
      and(
        eq(operation.kind, SETUP_INSPECTION_KIND),
        inArray(operation.state, ["confirmed", "complete"]),
      ),
    );
  return rows.map(toInspectionRow);
}

export async function listPendingInspections(db: InspectionDb): Promise<{ id: string }[]> {
  return db
    .select({ id: operation.id })
    .from(operation)
    .where(and(eq(operation.kind, SETUP_INSPECTION_KIND), eq(operation.state, "inspecting")));
}
