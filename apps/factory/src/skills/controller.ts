import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, notExists, sql as expression } from "drizzle-orm";
import { agentTurnAuthorityInput } from "../../../../packages/conversation-domain/src/agent-turn";
import {
  type InheritedSkillSettings,
  type PersonalSkillSettings,
  type ProjectSkillSettings,
  personalSkillSettingsInput,
  projectSkillSettingsInput,
  resolveRoleSkills,
} from "../../../../packages/conversation-domain/src/skill-inheritance";
import { librarySkillAssignments } from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillContent,
  type SkillPublish,
  type SkillRevision,
  type SkillRole,
  type SystemSkillSettings,
  skillContentInput,
  skillPublishInput,
  skillRevisionInput,
  systemSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skills";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  personalSkillSettings,
  projectSkillSettings,
  skillLibrary,
  skillLibraryRevision,
  skillPublication,
  skillRevision,
  systemSkillSettings,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn, requireSystemManagerIn } from "../access/controller";
import { CommandError } from "../command-error";
import { createSkillLibraryController } from "./library-controller";

function digest(content: SkillContent) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function createSkillController(database: ReturnType<typeof createDatabase>) {
  const library = createSkillLibraryController(database);
  async function lock(sql: DatabaseTransaction, write = false) {
    if (write) await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
    else await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-skills'))`;
  }

  async function manager(sql: DatabaseTransaction, userID: string) {
    await requireSystemManagerIn(sql, userID);
  }

  async function catalogue(sql: DatabaseTransaction) {
    const db = drizzleTransaction(sql);
    const rows = await db
      .select({
        id: skillRevision.id,
        revision: skillRevision.revision,
        content: skillRevision.content,
        digest: skillRevision.contentDigest,
        published: skillPublication.published,
      })
      .from(skillRevision)
      .innerJoin(skillPublication, eq(skillPublication.revisionId, skillRevision.id))
      .where(
        notExists(
          db
            .select({ id: skillLibraryRevision.revisionId })
            .from(skillLibraryRevision)
            .innerJoin(skillLibrary, eq(skillLibrary.id, skillLibraryRevision.libraryId))
            .where(
              and(
                eq(skillLibraryRevision.revisionId, skillRevision.id),
                ne(skillLibrary.scope, "system"),
              ),
            ),
        ),
      )
      .orderBy(skillRevision.skillKey, desc(skillRevision.revision));
    return rows.map((row) => skillRevisionInput.parse(row));
  }

  async function system(sql: DatabaseTransaction): Promise<SystemSkillSettings> {
    const [row] = await drizzleTransaction(sql)
      .select({
        version: systemSkillSettings.version,
        planning: systemSkillSettings.planning,
        build: systemSkillSettings.build,
      })
      .from(systemSkillSettings)
      .where(eq(systemSkillSettings.singleton, true));
    return systemSkillSettingsInput.parse(
      row ?? {
        version: 0,
        planning: { required: [], optional: [], selected: [] },
        build: { required: [], optional: [], selected: [] },
      },
    );
  }

  async function inherited(
    sql: DatabaseTransaction,
    projectID: string,
    userID: string,
  ): Promise<InheritedSkillSettings> {
    const canManageProject = await projectAuthorityIn(sql, userID, projectID);
    const global = await system(sql);
    const revisions = await catalogue(sql);
    const db = drizzleTransaction(sql);
    const [projectRow] = await db
      .select({
        version: projectSkillSettings.version,
        planning: projectSkillSettings.planning,
        build: projectSkillSettings.build,
      })
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.projectId, projectID));
    const project = projectSkillSettingsInput.parse(
      projectRow ?? {
        version: 0,
        planning: { required: [], optional: null, selected: null },
        build: { required: [], optional: null, selected: null },
      },
    );
    const [personalRow] = await db
      .select({
        version: personalSkillSettings.version,
        planning: personalSkillSettings.planning,
        build: personalSkillSettings.build,
      })
      .from(personalSkillSettings)
      .where(
        and(
          eq(personalSkillSettings.projectId, projectID),
          eq(personalSkillSettings.userId, userID),
        ),
      );
    const personal = personalSkillSettingsInput.parse(
      personalRow ?? { version: 0, planning: null, build: null },
    );
    const resolve = (role: SkillRole, own = true) =>
      resolveRoleSkills({
        role,
        system: global[role],
        project: project[role],
        personal: own ? personal[role] : null,
        revisions,
      });
    return {
      system: global,
      project,
      personal,
      revisions,
      canManageProject,
      effective: { planning: resolve("planning"), build: resolve("build") },
      projectEffective: { planning: resolve("planning", false), build: resolve("build", false) },
    };
  }

  function assertPublished(ids: string[], role: SkillRole, revisions: SkillRevision[]) {
    for (const id of ids) {
      const revision = revisions.find((revision) => revision.id === id);
      if (!revision?.published || !revision.content.roles.includes(role))
        throw new CommandError("conflict", "Assign only published, role-eligible Skill revisions");
    }
    const keys = ids.map((id) => revisions.find((revision) => revision.id === id)?.content.key);
    if (new Set(keys).size !== keys.length)
      throw new CommandError("conflict", "Assign only one revision of each Skill per role");
  }

  function changedElsewhere() {
    return new CommandError("conflict", "Skill settings changed elsewhere. Reload before saving.");
  }

  return {
    async invocations(projectID: string, userID: string, role: SkillRole, changeID?: string) {
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await projectAuthorityIn(sql, userID, projectID);
        let ids: string[] | undefined;
        if (changeID) {
          if (role !== "build")
            throw new CommandError("conflict", "A Change selects Coding guidance only");
          const db = drizzleTransaction(sql);
          const [row] = await db
            .select({ id: change.id })
            .from(change)
            .where(and(eq(change.id, changeID), eq(change.projectId, projectID)));
          if (!row) throw new CommandError("not-found", "Change not found");
          const [first] = await db
            .select({ authority: agentTurn.authority })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, changeID),
                expression`NOT (${agentTurn.authority} ? 'review')`,
              ),
            )
            .orderBy(asc(agentTurn.createdAt), asc(agentTurn.id))
            .limit(1);
          if (first) ids = agentTurnAuthorityInput.parse(first.authority).skillRevisionIds;
        }
        ids ??= (await this.resolveAssignment(role, sql, { projectID, userID })).revisionIds;
        const revisions = await this.load(ids, sql);
        const counts = new Map<string, number>();
        for (const revision of revisions)
          counts.set(revision.content.key, (counts.get(revision.content.key) ?? 0) + 1);
        return {
          skills: revisions
            .filter((revision) => counts.get(revision.content.key) === 1)
            .map(({ id, content }) => ({
              id,
              key: content.key,
              name: content.name,
              description: content.description,
            })),
          conflicts: [...counts].filter(([, count]) => count > 1).map(([key]) => key),
        };
      });
    },
    library,
    async getLibraryIn(sql: DatabaseTransaction, userID: string, projectID?: string) {
      await lock(sql, true);
      return library.viewIn(
        sql,
        userID,
        projectID,
        projectID
          ? await inherited(sql, projectID, userID)
          : {
              system: await system(sql),
              project: {
                version: 0,
                planning: { required: [], optional: null, selected: null },
                build: { required: [], optional: null, selected: null },
              },
              personal: { version: 0, planning: null, build: null },
            },
      );
    },
    async getLibrary(userID: string, projectID?: string) {
      return database.client.begin((sql) => this.getLibraryIn(sql, userID, projectID));
    },
    async chooseLibraryIn(
      sql: DatabaseTransaction,
      value: unknown,
      userID: string,
      projectID?: string,
    ) {
      return library.chooseIn(
        sql,
        value,
        userID,
        projectID ? (transaction) => inherited(transaction, projectID, userID) : undefined,
      );
    },
    async chooseLibrary(value: unknown, userID: string, projectID?: string) {
      return library.choose(
        value,
        userID,
        projectID ? (sql) => inherited(sql, projectID, userID) : undefined,
      );
    },
    async getInherited(projectID: string, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        return inherited(sql, projectID, userID);
      });
    },
    async getSystem(userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        await manager(sql, userID);
        return { settings: await system(sql), revisions: await catalogue(sql) };
      });
    },
    async publish(value: SkillPublish, userID: string) {
      const input = skillPublishInput.parse(value);
      const contentDigest = digest(input.content);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await manager(sql, userID);
        const db = drizzleTransaction(sql);
        const [existing] = await db
          .select({
            digest: skillRevision.contentDigest,
            createdBy: skillRevision.createdBy,
            revision: skillRevision.revision,
          })
          .from(skillRevision)
          .where(eq(skillRevision.id, input.revisionId));
        if (existing) {
          if (
            existing.digest !== contentDigest ||
            existing.createdBy !== userID ||
            existing.revision !== input.expectedRevision + 1
          )
            throw new CommandError(
              "conflict",
              "Skill publication identity was reused with different input",
            );
          return (await catalogue(sql)).find((revision) => revision.id === input.revisionId);
        }
        const [latest] = await db
          .select({
            revision: expression`COALESCE(max(${skillRevision.revision}), 0)`.mapWith(Number),
          })
          .from(skillRevision)
          .where(eq(skillRevision.skillKey, input.content.key));
        if (latest?.revision !== input.expectedRevision)
          throw new CommandError(
            "conflict",
            "The Skill changed elsewhere. Reload before publishing.",
          );
        await db.insert(skillRevision).values({
          id: input.revisionId,
          skillKey: input.content.key,
          revision: input.expectedRevision + 1,
          content: input.content,
          contentDigest,
          createdBy: userID,
        });
        await db.insert(skillPublication).values({
          revisionId: input.revisionId,
          published: true,
          updatedBy: userID,
        });
        const libraryID = createHash("md5")
          .update(`factory-legacy-skill:${input.content.key}`)
          .digest("hex");
        const identity = `${libraryID.slice(0, 8)}-${libraryID.slice(8, 12)}-4${libraryID.slice(13, 16)}-8${libraryID.slice(17, 20)}-${libraryID.slice(20)}`;
        await db
          .insert(skillLibrary)
          .values({ id: identity, storageKey: input.content.key, scope: "system" })
          .onConflictDoNothing();
        await db
          .insert(skillLibraryRevision)
          .values({ libraryId: identity, revisionId: input.revisionId });
        return (await catalogue(sql)).find((revision) => revision.id === input.revisionId);
      });
    },
    async setPublication(revisionID: string, published: boolean, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await manager(sql, userID);
        const [changed] = await drizzleTransaction(sql)
          .update(skillPublication)
          .set({ published, updatedBy: userID, updatedAt: expression`now()` })
          .where(eq(skillPublication.revisionId, revisionID))
          .returning({ revisionId: skillPublication.revisionId });
        if (!changed) throw new CommandError("not-found", "Skill revision not found");
        return { settings: await system(sql), revisions: await catalogue(sql) };
      });
    },
    async setSystem(value: SystemSkillSettings, userID: string) {
      const input = systemSkillSettingsInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await manager(sql, userID);
        const revisions = await catalogue(sql);
        for (const role of ["planning", "build"] as const) {
          const ids = [...input[role].required, ...input[role].optional];
          assertPublished(ids, role, revisions);
        }
        const db = drizzleTransaction(sql);
        const values = { planning: input.planning, build: input.build, updatedBy: userID };
        const [changed] =
          input.version === 0
            ? await db
                .insert(systemSkillSettings)
                .values({ ...values, singleton: true, version: 1 })
                .onConflictDoNothing()
                .returning({ version: systemSkillSettings.version })
            : await db
                .update(systemSkillSettings)
                .set({
                  ...values,
                  version: expression`${systemSkillSettings.version} + 1`,
                  updatedAt: expression`now()`,
                })
                .where(
                  and(
                    eq(systemSkillSettings.singleton, true),
                    eq(systemSkillSettings.version, input.version),
                  ),
                )
                .returning({ version: systemSkillSettings.version });
        if (!changed)
          throw new CommandError(
            "conflict",
            "Skill settings changed elsewhere. Reload before saving.",
          );
        return { settings: await system(sql), revisions };
      });
    },
    async resolveAssignment(
      role: SkillRole,
      sql: DatabaseTransaction,
      context: { projectID: string; userID: string; personal?: boolean },
    ) {
      await lock(sql, true);
      const legacy = await inherited(sql, context.projectID, context.userID);
      const view = await library.viewIn(sql, context.userID, context.projectID, legacy);
      try {
        const assignments = librarySkillAssignments(
          view.entries,
          context.personal === false
            ? view.choices.filter((choice) => choice.scope !== "personal")
            : view.choices,
          role,
        );
        const ids = assignments.map((item) => item.revisionId);
        if (ids.length > 16) throw new Error("At most 16 skills can be enabled per role");
        return {
          revisionIds: ids,
          requiredRevisionIds: assignments
            .filter((item) => item.required)
            .map((item) => item.revisionId),
        };
      } catch (error) {
        throw new CommandError(
          "unavailable",
          error instanceof Error ? error.message : "Skill settings are unavailable",
        );
      }
    },
    async resolve(
      role: SkillRole,
      sql: DatabaseTransaction,
      context: { projectID: string; userID: string },
    ) {
      return (await this.resolveAssignment(role, sql, context)).revisionIds;
    },
    async setProject(projectID: string, userID: string, value: ProjectSkillSettings) {
      const input = projectSkillSettingsInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await projectAuthorityIn(sql, userID, projectID, true);
        const current = await inherited(sql, projectID, userID);
        for (const role of ["planning", "build"] as const) {
          const rule = input[role];
          const parent = current.system[role];
          if (
            [...rule.required, ...(rule.optional ?? []), ...(rule.selected ?? [])].some(
              (id) => !parent.optional.includes(id),
            )
          )
            throw new CommandError(
              "conflict",
              "Project Skills cannot widen System permissions or replace required baselines",
            );
          const optional = (rule.optional ?? parent.optional).filter(
            (id) => !rule.required.includes(id),
          );
          if (rule.selected?.some((id) => !optional.includes(id)))
            throw new CommandError(
              "conflict",
              "Project defaults must select permitted optional Skills",
            );
          assertPublished(
            [...parent.required, ...rule.required, ...optional],
            role,
            current.revisions,
          );
        }
        const db = drizzleTransaction(sql);
        const values = { planning: input.planning, build: input.build, updatedBy: userID };
        const [changed] =
          input.version === 0
            ? await db
                .insert(projectSkillSettings)
                .values({ ...values, projectId: projectID, version: 1 })
                .onConflictDoNothing()
                .returning({ version: projectSkillSettings.version })
            : await db
                .update(projectSkillSettings)
                .set({
                  ...values,
                  version: expression`${projectSkillSettings.version} + 1`,
                  updatedAt: expression`now()`,
                })
                .where(
                  and(
                    eq(projectSkillSettings.projectId, projectID),
                    eq(projectSkillSettings.version, input.version),
                  ),
                )
                .returning({ version: projectSkillSettings.version });
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async setPersonal(projectID: string, userID: string, value: PersonalSkillSettings) {
      const input = personalSkillSettingsInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        const current = await inherited(sql, projectID, userID);
        for (const role of ["planning", "build"] as const) {
          const ids = input[role];
          if (ids?.some((id) => !current.effective[role].optional.includes(id)))
            throw new CommandError(
              "conflict",
              "Personal choices must use permitted optional Skills",
            );
          if (ids) assertPublished(ids, role, current.revisions);
        }
        const db = drizzleTransaction(sql);
        const values = { planning: input.planning, build: input.build };
        const [changed] =
          input.version === 0
            ? await db
                .insert(personalSkillSettings)
                .values({ ...values, projectId: projectID, userId: userID, version: 1 })
                .onConflictDoNothing()
                .returning({ version: personalSkillSettings.version })
            : await db
                .update(personalSkillSettings)
                .set({
                  ...values,
                  version: expression`${personalSkillSettings.version} + 1`,
                  updatedAt: expression`now()`,
                })
                .where(
                  and(
                    eq(personalSkillSettings.projectId, projectID),
                    eq(personalSkillSettings.userId, userID),
                    eq(personalSkillSettings.version, input.version),
                  ),
                )
                .returning({ version: personalSkillSettings.version });
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async load(ids: string[], transaction?: DatabaseTransaction): Promise<SkillRevision[]> {
      if (!ids.length) return [];
      const rows = await drizzleTransaction(transaction ?? database.client)
        .select({
          id: skillRevision.id,
          revision: skillRevision.revision,
          content: skillRevision.content,
          digest: skillRevision.contentDigest,
          published: skillPublication.published,
        })
        .from(skillRevision)
        .innerJoin(skillPublication, eq(skillPublication.revisionId, skillRevision.id))
        .where(inArray(skillRevision.id, ids));
      const revisions = rows.map((row) =>
        skillRevisionInput.parse({ ...row, content: skillContentInput.parse(row.content) }),
      );
      return ids.map((id) => {
        const revision = revisions.find((revision) => revision.id === id);
        if (!revision || digest(revision.content) !== revision.digest)
          throw new CommandError(
            "unavailable",
            "The exact admitted Skill content could not be loaded",
          );
        // Retraction affects fresh admission, not the content frozen for an admitted turn.
        return revision;
      });
    },
  };
}
