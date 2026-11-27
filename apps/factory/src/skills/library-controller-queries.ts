import { and, desc, eq, exists, sql as expression, inArray, ne, or } from "drizzle-orm";
import {
  type SkillLibraryView,
  skillChoiceView,
  skillLibraryView,
} from "#conversation-domain/skill-library";
import { type SkillRevision, skillRevisionInput } from "#conversation-domain/skills";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation, skillLibrary, skillRevision } from "#db/schema";
import { requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";
import { libraryCoversIn } from "../library-covers/api";
import { checkSkillSourceUpdate, previewRepositorySkill, previewSkillImport } from "./import";
import {
  listSkillLibrariesIn,
  NIL_UUID,
  proposalManagerVisibility,
  sharedTurnSkillExists,
  skillCapabilitiesIn,
  skillRevisionColumns,
} from "./library-controller-store";

export async function viewSkillLibraryIn(
  sql: DatabaseTransaction,
  userId: string,
  projectId?: string,
): Promise<SkillLibraryView> {
  const access = await skillCapabilitiesIn(sql, userId, projectId);
  const all = await listSkillLibrariesIn(sql);
  const visible = all.filter(
    (item) =>
      item.scope === "system" ||
      item.ownerId === userId ||
      (item.scope === "project" && item.projectId === projectId),
  );
  const covers = await libraryCoversIn(
    sql,
    "skill",
    visible.map((item) => item.id),
  );
  const db = drizzleTransaction(sql);
  const rows = visible.length
    ? await db
        .select({ libraryId: skillRevision.libraryId, ...skillRevisionColumns })
        .from(skillRevision)
        .where(
          inArray(
            skillRevision.libraryId,
            visible.map((item) => item.id),
          ),
        )
        .orderBy(desc(skillRevision.revision))
    : [];
  const choices = (
    await db
      .select({
        libraryId: expression<string>`${operation.payload}->>'libraryId'`,
        scope: operation.scopeType,
        role: expression<string>`${operation.payload}->>'role'`,
        state: operation.state,
        revisionId: expression<string>`${operation.payload}->>'revisionId'`,
        version: expression<number>`(${operation.payload}->>'version')::bigint::float8`,
      })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "skills.choice"),
          or(
            eq(operation.scopeType, "system"),
            and(
              eq(operation.scopeId, projectId ?? NIL_UUID),
              or(
                eq(operation.scopeType, "project"),
                and(
                  eq(operation.scopeType, "personal"),
                  eq(expression<string>`${operation.payload}->>'userId'`, userId),
                ),
              ),
            ),
          ),
        ),
      )
  ).map((row) => skillChoiceView.parse(row));
  const proposals = skillLibraryView.shape.proposals.parse(
    await db
      .select({
        id: operation.id,
        revisionId: expression<string>`${operation.payload}->>'revisionId'`,
        target: expression<"system" | "project">`${operation.payload}->>'target'`,
        projectId: expression<string | null>`${operation.payload}->>'projectId'`,
        name: expression<string>`${skillRevision.content}->>'name'`,
      })
      .from(operation)
      .innerJoin(
        skillRevision,
        eq(expression<string>`${skillRevision.id}::text`, operation.scopeId),
      )
      .where(
        and(
          eq(operation.kind, "skills.share_proposal"),
          eq(operation.scopeType, "skill_revision"),
          eq(operation.state, "proposed"),
          or(
            eq(expression<string>`${operation.payload}->>'proposedBy'`, userId),
            proposalManagerVisibility(access, projectId),
          ),
        ),
      ),
  );
  const sharedVersions = (
    await db
      .selectDistinct(skillRevisionColumns)
      .from(skillRevision)
      .innerJoin(skillLibrary, eq(skillLibrary.id, skillRevision.libraryId))
      .where(
        and(
          eq(skillLibrary.scope, "personal"),
          ne(skillLibrary.ownerId, userId),
          sharedTurnSkillExists(db, projectId),
        ),
      )
      .limit(100)
  ).map((row) => skillRevisionInput.parse(row));
  return {
    ...access,
    sharedVersions,
    proposals,
    choices: choices.filter((choice) => visible.some((item) => item.id === choice.libraryId)),
    entries: visible.map((library) => ({
      ...library,
      cover: covers.get(library.id) ?? null,
      editable:
        library.ownerId === userId ||
        (library.scope === "system" && access.canManageSystem) ||
        (library.scope === "project" && access.canManageProject),
      revisions: rows
        .filter((row) => row.libraryId === library.id)
        .map((row) => skillRevisionInput.parse(row)),
    })),
  };
}

export async function inspectSkillRevisionIn(
  sql: DatabaseTransaction,
  revisionId: string,
  userId: string,
  projectId?: string,
): Promise<SkillRevision> {
  const access = await skillCapabilitiesIn(sql, userId, projectId);
  const db = drizzleTransaction(sql);
  const [row] = await db
    .select(skillRevisionColumns)
    .from(skillRevision)
    .innerJoin(skillLibrary, eq(skillLibrary.id, skillRevision.libraryId))
    .where(
      and(
        eq(skillRevision.id, revisionId),
        or(
          eq(skillLibrary.scope, "system"),
          eq(skillLibrary.ownerId, userId),
          eq(skillLibrary.projectId, projectId ?? NIL_UUID),
          sharedTurnSkillExists(db, projectId),
          exists(
            db
              .select({ id: operation.id })
              .from(operation)
              .where(
                and(
                  eq(operation.kind, "skills.share_proposal"),
                  eq(operation.scopeType, "skill_revision"),
                  eq(operation.scopeId, expression<string>`${skillRevision.id}::text`),
                  proposalManagerVisibility(access, projectId),
                ),
              ),
          ),
        ),
      ),
    );
  if (!row) throw new CommandError("not-found", "Skill version not found");
  return skillRevisionInput.parse(row);
}

export async function checkSkillSourceForUser(
  database: ReturnType<typeof createDatabase>,
  revisionId: string,
  userId: string,
  projectId?: string,
) {
  const revision = await database.client.begin((sql) =>
    inspectSkillRevisionIn(sql, revisionId, userId, projectId),
  );
  if (!revision.content.origin)
    throw new CommandError("conflict", "This skill has no repository source");
  const { repository, commit, path } = revision.content.origin;
  return checkSkillSourceUpdate({ repository, commit, path });
}

export async function previewSkillForUser(
  database: ReturnType<typeof createDatabase>,
  value: unknown,
  userId: string,
  repository = false,
) {
  await database.client.begin((sql) => requireActiveAccountIn(sql, userId));
  return repository ? previewRepositorySkill(value) : previewSkillImport(value);
}
