import { createHash } from "node:crypto";
import { and, eq, exists, sql as expression, isNotNull, or } from "drizzle-orm";
import { skillScopeInput } from "#conversation-domain/skill-library";
import { type SkillContent, skillContentInput } from "#conversation-domain/skills";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { administrator, agentTurn, operation, skillLibrary, skillRevision } from "#db/schema";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";
import { starterSkills } from "./starters";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type SkillLibraryRecord = {
  id: string;
  storageKey: string;
  scope: "system" | "project" | "personal";
  ownerId: string | null;
  projectId: string | null;
};

export type SkillCapabilities = {
  canManageSystem: boolean;
  canManageProject: boolean;
};

export const skillRevisionColumns = {
  id: skillRevision.id,
  revision: skillRevision.revision,
  content: skillRevision.content,
  digest: skillRevision.contentDigest,
  published: skillRevision.published,
};

export function hashSkillContent(content: SkillContent) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export async function lockSkillsIn(sql: DatabaseTransaction) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
}

export async function skillCapabilitiesIn(
  sql: DatabaseTransaction,
  userId: string,
  projectId?: string,
): Promise<SkillCapabilities> {
  await requireActiveAccountIn(sql, userId);
  const [admin] = await drizzleTransaction(sql)
    .select({ userId: administrator.userId })
    .from(administrator)
    .where(eq(administrator.userId, userId))
    .for("share");
  return {
    canManageSystem: Boolean(admin),
    canManageProject: projectId ? await projectAuthorityIn(sql, userId, projectId) : false,
  };
}

export async function authorizeSkillScopeIn(
  sql: DatabaseTransaction,
  userId: string,
  scope: SkillLibraryRecord["scope"],
  projectId?: string,
) {
  const access = await skillCapabilitiesIn(sql, userId, projectId);
  if (scope === "system" && !access.canManageSystem)
    throw new CommandError("forbidden", "Factory administrator access required");
  if (scope === "project" && (!projectId || !access.canManageProject))
    throw new CommandError("forbidden", "Project manager access required");
}

export async function listSkillLibrariesIn(sql: DatabaseTransaction) {
  const rows = await drizzleTransaction(sql)
    .select({
      id: skillLibrary.id,
      storageKey: skillLibrary.storageKey,
      scope: skillLibrary.scope,
      ownerId: skillLibrary.ownerId,
      projectId: skillLibrary.projectId,
    })
    .from(skillLibrary)
    .orderBy(skillLibrary.scope, skillLibrary.storageKey);
  return rows.map(
    (row): SkillLibraryRecord => ({ ...row, scope: skillScopeInput.parse(row.scope) }),
  );
}

export function sharedTurnSkillExists(
  db: ReturnType<typeof drizzleTransaction>,
  projectId: string | undefined,
) {
  return exists(
    db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.projectId, projectId ?? NIL_UUID),
          isNotNull(agentTurn.ticketId),
          expression`${agentTurn.authority}->'skillRevisionIds' ? ${skillRevision.id}::text`,
        ),
      ),
  );
}

export function proposalManagerVisibility(
  access: SkillCapabilities,
  projectId: string | undefined,
) {
  return or(
    and(
      eq(expression<string>`${operation.payload}->>'target'`, "system"),
      expression`${access.canManageSystem}`,
    ),
    and(
      eq(expression<string>`${operation.payload}->>'projectId'`, projectId ?? NIL_UUID),
      expression`${access.canManageProject}`,
    ),
  );
}

export async function writeSkillRevisionIn(
  sql: DatabaseTransaction,
  library: SkillLibraryRecord,
  revisionId: string,
  expected: number,
  content: SkillContent,
  userId: string,
  copiedFrom?: string,
) {
  const digest = hashSkillContent(content);
  const db = drizzleTransaction(sql);
  const [existing] = await db
    .select({
      digest: skillRevision.contentDigest,
      revision: skillRevision.revision,
      createdBy: skillRevision.createdBy,
      libraryId: skillRevision.libraryId,
    })
    .from(skillRevision)
    .where(eq(skillRevision.id, revisionId));
  if (existing) {
    if (
      existing.digest !== digest ||
      existing.revision !== expected + 1 ||
      existing.createdBy !== userId ||
      existing.libraryId !== library.id
    )
      throw new CommandError("conflict", "Skill save identity was reused with different input");
    return;
  }
  const [latest] = await db
    .select({ revision: expression`COALESCE(max(${skillRevision.revision}), 0)`.mapWith(Number) })
    .from(skillRevision)
    .where(eq(skillRevision.skillKey, library.storageKey));
  if (latest?.revision !== expected)
    throw new CommandError("conflict", "This skill changed elsewhere. Reload before saving.");
  await db.insert(skillRevision).values({
    id: revisionId,
    skillKey: library.storageKey,
    revision: expected + 1,
    content,
    contentDigest: digest,
    createdBy: userId,
    libraryId: library.id,
    copiedFrom: copiedFrom ?? null,
    published: true,
    publishedUpdatedBy: userId,
    publishedUpdatedAt: expression`now()`,
  });
}

export async function seedStarterSkillsIn(sql: DatabaseTransaction, userId: string) {
  const db = drizzleTransaction(sql);
  const [admin] = await db
    .select({ id: administrator.userId })
    .from(administrator)
    .orderBy(administrator.userId)
    .limit(1);
  for (const starter of starterSkills) {
    const [existing] = await db
      .select({ id: skillLibrary.id })
      .from(skillLibrary)
      .where(eq(skillLibrary.id, starter.id));
    if (existing) continue;
    const library: SkillLibraryRecord = {
      id: starter.id,
      storageKey: `library-${starter.id}`,
      scope: "system",
      ownerId: null,
      projectId: null,
    };
    await db.insert(skillLibrary).values({
      id: library.id,
      storageKey: library.storageKey,
      scope: "system",
    });
    await writeSkillRevisionIn(
      sql,
      library,
      starter.revisionId,
      0,
      skillContentInput.parse(starter.content),
      admin?.id ?? userId,
    );
    if (starter.enabled)
      for (const role of starter.content.roles)
        await db.insert(operation).values({
          id: crypto.randomUUID(),
          kind: "skills.choice",
          scopeType: "system",
          scopeId: NIL_UUID,
          idempotencyKey: `skills.choice:${library.id}:system:${NIL_UUID}:${NIL_UUID}:${role}`,
          activeKey: null,
          state: "enable",
          payload: {
            libraryId: library.id,
            scope: "system",
            contextId: NIL_UUID,
            userId: NIL_UUID,
            role,
            state: "enable",
            revisionId: starter.revisionId,
            version: 1,
          },
        });
  }
}
