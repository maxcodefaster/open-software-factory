import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, sql as expression, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  change,
  developmentWorkspace,
  operation,
  project,
  runtimeAttempt,
  substrateSource,
  ticket,
} from "#db/schema";
import { personalWorkspaceIdentity, ticketWorkspaceIdentity } from "#workspace-domain/workspace";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import { initializeSourceCheckout, resolveRepositoryRevision } from "../runtime/source-api";

export const initialSourceSeed = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  workspaceID: z.uuid(),
  projectID: z.uuid(),
  repositoryURL: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  branch: z.string().min(1),
});
export type InitialSourceSeed = z.infer<typeof initialSourceSeed>;
type Database = ReturnType<typeof createDatabase>;

/** The caller holds runtime authority and its Workspace lock; this admits no execution. */
export async function admitInitialSourceSeedIn(
  sql: DatabaseTransaction,
  input: Omit<InitialSourceSeed, "version" | "id">,
) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`source:${input.workspaceID}`}))`;
  const db = drizzleTransaction(sql);
  if (
    (
      await db
        .select({ id: substrateSource.workspaceId })
        .from(substrateSource)
        .where(eq(substrateSource.workspaceId, input.workspaceID))
    ).length
  )
    return;
  if (
    (
      await db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.workspaceId, input.workspaceID))
        .limit(1)
    ).length
  )
    throw new CommandError("unavailable", "Retained Source is missing; reinitialization refused");
  const seed = initialSourceSeed.parse({ ...input, version: 1, id: crypto.randomUUID() });
  // The native constraint rechecks the exact existing Workspace and repository.
  await db.insert(substrateSource).values({
    workspaceId: seed.workspaceID,
    actorUid: null,
    owner: "service",
    serviceBase: seed.id,
    seed,
  });
}

// Filesystem publication is an external fact. Commit it before exposing a
// process, even when the file operation that requested Source later rolls back.
// The caller holds the Source owner lock; this short connection must not reacquire
// it or occupy the application pool behind the requesting transaction.
export async function confirmInitialSourcePublication(
  database: Database,
  workspaceID: string,
  seedID: string,
) {
  const sql = database.coordination();
  try {
    const confirmed = await drizzleTransaction(sql)
      .update(substrateSource)
      .set({
        seedConfirmedAt: expression`now()`,
      })
      .where(
        and(
          eq(substrateSource.workspaceId, workspaceID),
          isNull(substrateSource.actorUid),
          eq(substrateSource.owner, "service"),
          eq(substrateSource.serviceBase, seedID),
          isNull(substrateSource.seedConfirmedAt),
        ),
      )
      .returning({ workspaceID: substrateSource.workspaceId });
    if (confirmed.length !== 1)
      throw new CommandError("conflict", "Initial Source confirmation lost its owner");
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Bind a seed only to its first recipient, after any ungranted v2 Actors were deleted. */
export async function initialSourceActorIn(
  sql: Database["client"] | DatabaseTransaction,
  seed: InitialSourceSeed,
  actorUID: string,
): Promise<readonly { id: string }[]> {
  return [
    ...(await sql<{ id: string }[]>`
    SELECT current.id FROM factory.runtime_attempt current
    JOIN factory.substrate_provision p ON p.owner_id=current.workspace_id AND p.kind='workspace' AND p.generation=current.generation
    WHERE current.workspace_id=${seed.workspaceID}
      AND current.project_id=${seed.projectID} AND current.revision=${seed.revision}
      AND (current.state='create-intended'
        OR (current.state='starting' AND current.binding_intent->>'sourceRestoreProtocol'='2'))
      AND current.stop_intended_at IS NULL
      AND current.actor_uid=${actorUID} AND NOT current.create_rejected
      AND current.create_attempted_at IS NOT NULL
      AND current.delete_intended_at IS NULL AND current.deleted_at IS NULL
      AND current.observation#>>'{metadata,uid}'=${actorUID}
      AND current.observation#>>'{metadata,name}'=current.actor_name
      AND current.observation#>>'{metadata,atespace}'=current.atespace
      AND current.binding_intent->>'projectID'=${seed.projectID}
      AND current.binding_intent->>'workspaceID'=${seed.workspaceID}
      AND current.binding_intent->>'generation'=current.generation::text
      AND current.binding_intent->>'atespaceUID'=p.resources#>>'{atespace,value,metadata,uid}'
      AND current.binding_intent->>'templateUID'=p.resources#>>'{template,value,metadata,uid}'
      AND current.binding_intent->>'templateVersion'=p.resources#>>'{template,value,metadata,version}'
      AND current.binding_intent->>'templateSHA256'=p.intent->>'templateSHA256'
      AND jsonb_typeof(p.resources->'atespace'->'value')='object'
      AND jsonb_typeof(p.resources->'policy'->'value')='object'
      AND jsonb_typeof(p.resources->'template'->'value')='object'
      AND NOT COALESCE((p.resources#>>'{atespace,rejected}')::boolean,false)
      AND NOT COALESCE((p.resources#>>'{policy,rejected}')::boolean,false)
      AND NOT COALESCE((p.resources#>>'{template,rejected}')::boolean,false)
      AND p.intent->>'revision'=${seed.revision}
      AND p.intent->>'branch'=${seed.branch}
      AND p.intent->>'repositoryURL'=${seed.repositoryURL}
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt other
        WHERE other.workspace_id=current.workspace_id AND other.id<>current.id AND (
          other.generation<current.generation AND other.state='stopped'
          AND other.deleted_at IS NOT NULL AND other.binding_intent->>'sourceRestoreProtocol'='2'
          AND other.binding_intent->>'projectID'=${seed.projectID}
          AND other.binding_intent->>'workspaceID'=${seed.workspaceID}
          AND other.binding_intent->>'generation'=other.generation::text) IS NOT TRUE)`),
  ];
}

/** New seeds take runtime then Source locks; an existing authorized owner needs neither. */
export async function admitInitialSource(
  database: Database,
  userID: string,
  selection: { projectID: string } | { changeID: string },
): Promise<string> {
  const personal = "projectID" in selection;
  const workspaceID = personal
    ? personalWorkspaceIdentity(selection.projectID, userID).workspaceID
    : ticketWorkspaceIdentity(selection.changeID).workspaceID;
  const sql = database.coordination();
  let locked = false;
  try {
    const readIn = async (tx: DatabaseTransaction) => {
      const db = drizzleTransaction(tx);
      // PostgreSQL's OF lock target must be an unqualified relation alias.
      const sourceChange = alias(change, "source_change");
      const [approved] = personal
        ? []
        : await db
            .select({
              projectID: sourceChange.projectId,
              ticketID: sourceChange.ticketId,
              revision: sourceChange.baseSha,
              branch: sourceChange.branchName,
            })
            .from(sourceChange)
            .innerJoin(ticket, eq(ticket.id, sourceChange.ticketId))
            .innerJoin(
              operation,
              and(
                eq(operation.kind, "delivery.branch_create"),
                eq(operation.scopeType, "change"),
                eq(operation.scopeId, expression<string>`${sourceChange.id}::text`),
              ),
            )
            .where(
              and(
                eq(sourceChange.id, selection.changeID),
                expression`${sourceChange.state} IN ('starting','active','failed')`,
                expression`${sourceChange.cancelRequestedAt} IS NULL`,
                expression`${ticket.trashedAt} IS NULL`,
                eq(operation.state, "succeeded"),
                eq(
                  expression<string | null>`${operation.result}->>'observedHeadSha'`,
                  sourceChange.baseSha,
                ),
              ),
            )
            .for("share", { of: sourceChange });
      if (!personal && !approved)
        throw new CommandError("unavailable", "Approved Ticket source is not ready");
      const projectID = personal ? selection.projectID : approved?.projectID;
      if (!projectID) throw new CommandError("not-found", "Project not found");
      await projectDevelopmentAuthorityIn(tx, userID, projectID);
      const [repository] = await db
        .select({
          repositoryURL: project.repositoryUrl,
          branch: project.defaultBranch,
        })
        .from(project)
        .where(eq(project.id, projectID))
        .for("share");
      if (!repository) throw new CommandError("not-found", "Project not found");
      const [workspace] = await db
        .select({
          projectID: developmentWorkspace.projectId,
          branch: developmentWorkspace.sourceBranch,
          revision: developmentWorkspace.sourceRevision,
        })
        .from(developmentWorkspace)
        .where(eq(developmentWorkspace.id, workspaceID));
      if (workspace) await workspaceAuthorityIn(tx, workspaceID, userID);
      return { projectID, repository, approved, workspace };
    };
    const read = () => sql.begin(readIn);
    const db = drizzleTransaction(sql);
    const retained = async () =>
      Boolean(
        (
          await db
            .select({ id: substrateSource.workspaceId })
            .from(substrateSource)
            .where(eq(substrateSource.workspaceId, workspaceID))
        ).length,
      );
    let current = await read();
    if (await retained()) return workspaceID;
    await sql`SELECT pg_advisory_lock(hashtext(${`runtime:${workspaceID}`}))`;
    locked = true;
    current = await read();
    if (await retained()) return workspaceID;
    // Missing retained Actor Source is never permission to clone over its history.
    if (
      (
        await db
          .select({ id: runtimeAttempt.id })
          .from(runtimeAttempt)
          .where(eq(runtimeAttempt.workspaceId, workspaceID))
      ).length
    )
      throw new CommandError("unavailable", "Retained Source is missing; reinitialization refused");
    const revision =
      current.workspace?.revision ??
      current.approved?.revision ??
      (await resolveRepositoryRevision(
        current.repository.repositoryURL,
        current.repository.branch,
      ));
    const branch =
      current.workspace?.branch ?? current.approved?.branch ?? current.repository.branch;
    await sql.begin(async (tx) => {
      if (JSON.stringify(await readIn(tx)) !== JSON.stringify(current))
        throw new CommandError("conflict", "Project source changed before initialization");
      const transaction = drizzleTransaction(tx);
      if (!current.workspace)
        await transaction.insert(developmentWorkspace).values({
          id: workspaceID,
          projectId: current.projectID,
          kind: personal ? "personal" : "ticket",
          ownerUserId: personal ? userID : null,
          ticketId: current.approved?.ticketID ?? null,
          changeId: personal ? null : selection.changeID,
          sourceBranch: branch,
          sourceRevision: revision,
          createdBy: userID,
        });
      await workspaceAuthorityIn(tx, workspaceID, userID);
      // The seed identity is durable before clone or process creation. It is
      // not an Actor, Runtime Attempt, ROOTFS snapshot or inference admission.
      await admitInitialSourceSeedIn(tx, {
        workspaceID,
        projectID: current.projectID,
        repositoryURL: current.repository.repositoryURL,
        revision,
        branch,
      });
    });
    return workspaceID;
  } finally {
    try {
      if (locked) await sql`SELECT pg_advisory_unlock(hashtext(${`runtime:${workspaceID}`}))`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}

/** Publish only a pinned, initialized Git tree; never reclone a confirmed missing tree. */
export async function materializeInitialSource(
  binary: string,
  root: string,
  seed: InitialSourceSeed,
  confirmed: boolean,
) {
  const base = join(root, seed.workspaceID, seed.id);
  const identity = JSON.stringify(seed);
  try {
    if (
      (await readFile(join(base, "initial-source.json"), "utf8")) !== identity ||
      !(await lstat(join(base, "project"))).isDirectory()
    )
      throw new Error("Initial Source identity changed");
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    if (confirmed)
      throw new CommandError("unavailable", "Retained Source is missing; reinitialization refused");
  }
  try {
    await lstat(base);
    throw new CommandError("unavailable", "Unconfirmed existing Source was preserved");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await mkdir(dirname(base), { recursive: true, mode: 0o700 });
  const staging = `${base}.initializing`;
  await mkdir(staging, { mode: 0o700 }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  const marker = join(staging, "initial-source.json");
  const info = await lstat(staging);
  if (!info.isDirectory() || info.mode & 0o077)
    throw new CommandError("unavailable", "Initial Source staging identity is unsafe");
  try {
    const file = await open(marker, "wx", 0o600);
    try {
      await file.writeFile(identity);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (
      (cause as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(marker, "utf8")) !== identity
    )
      throw cause;
  }
  await initializeSourceCheckout(binary, staging, seed);
  const directory = await open(staging, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await rename(staging, base);
  const parent = await open(dirname(base), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
