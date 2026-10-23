import { createHash } from "node:crypto";
import {
  type InheritedSkillSettings,
  type PersonalSkillSettings,
  type ProjectSkillSettings,
  personalSkillSettingsInput,
  projectSkillSettingsInput,
  resolveRoleSkills,
} from "../../../../packages/conversation-domain/src/skill-inheritance";
import { librarySkillAssignments } from "../../../../packages/conversation-domain/src/skill-library";
import { agentTurnAuthorityInput } from "../../../../packages/conversation-domain/src/agent-turn";
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
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { createSkillLibraryController } from "./library-controller";

function digest(content: SkillContent) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function createSkillController(database: ReturnType<typeof createDatabase>) {
  const library = createSkillLibraryController(database);
  async function lock(sql: AgentTurnTransaction, write = false) {
    if (write) await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
    else await sql`SELECT pg_advisory_xact_lock_shared(hashtext('factory-skills'))`;
  }

  async function manager(sql: AgentTurnTransaction, userID: string) {
    const [allowed] =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id = ${userID} FOR SHARE`;
    if (!allowed) throw new CommandError("forbidden", "System Manager access required");
  }

  async function catalogue(sql: AgentTurnTransaction) {
    const rows = await sql<
      Array<{ id: string; revision: number; content: unknown; digest: string; published: boolean }>
    >`
      SELECT revision.id, revision.revision::float8 AS revision, revision.content,
        revision.content_digest AS digest, publication.published
      FROM factory.skill_revision revision JOIN factory.skill_publication publication ON publication.revision_id = revision.id
      WHERE NOT EXISTS (SELECT 1 FROM factory.skill_library_revision link JOIN factory.skill_library library ON library.id = link.library_id
        WHERE link.revision_id = revision.id AND library.scope != 'system')
      ORDER BY revision.skill_key, revision.revision DESC
    `;
    return rows.map((row) => skillRevisionInput.parse(row));
  }

  async function system(sql: AgentTurnTransaction): Promise<SystemSkillSettings> {
    const [row] = await sql<Array<{ version: number; planning: unknown; build: unknown }>>`
      SELECT version::float8 AS version, planning, build FROM factory.system_skill_settings WHERE singleton
    `;
    return systemSkillSettingsInput.parse(
      row ?? {
        version: 0,
        planning: { required: [], optional: [], selected: [] },
        build: { required: [], optional: [], selected: [] },
      },
    );
  }

  async function inherited(
    sql: AgentTurnTransaction,
    projectID: string,
    userID: string,
  ): Promise<InheritedSkillSettings> {
    const canManageProject = await projectAuthorityIn(sql, userID, projectID);
    const global = await system(sql);
    const revisions = await catalogue(sql);
    const [projectRow] = await sql<Array<{ version: number; planning: unknown; build: unknown }>>`
      SELECT version::float8 AS version, planning, build FROM factory.project_skill_settings WHERE project_id = ${projectID}
    `;
    const project = projectSkillSettingsInput.parse(
      projectRow ?? {
        version: 0,
        planning: { required: [], optional: null, selected: null },
        build: { required: [], optional: null, selected: null },
      },
    );
    const [personalRow] = await sql<Array<{ version: number; planning: unknown; build: unknown }>>`
      SELECT version::float8 AS version, planning, build FROM factory.personal_skill_settings WHERE project_id = ${projectID} AND user_id = ${userID}
    `;
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
          const [change] = await sql`SELECT id FROM factory.change
            WHERE id=${changeID} AND project_id=${projectID}`;
          if (!change) throw new CommandError("not-found", "Change not found");
          const [first] = await sql<{ authority: unknown }[]>`
            SELECT authority FROM factory.agent_turn
            WHERE change_id=${changeID} AND NOT (authority ? 'review')
            ORDER BY created_at,id LIMIT 1`;
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
    async getLibrary(userID: string, projectID?: string) {
      return database.client.begin(async (sql) => {
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
      });
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
        const [existing] = await sql<
          Array<{ digest: string; createdBy: string; revision: number }>
        >`
          SELECT content_digest AS digest, created_by AS "createdBy", revision::float8 AS revision
          FROM factory.skill_revision WHERE id = ${input.revisionId}
        `;
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
        const [latest] = await sql<Array<{ revision: number }>>`
          SELECT COALESCE(max(revision), 0)::float8 AS revision FROM factory.skill_revision WHERE skill_key = ${input.content.key}
        `;
        if (latest?.revision !== input.expectedRevision)
          throw new CommandError(
            "conflict",
            "The Skill changed elsewhere. Reload before publishing.",
          );
        await sql`INSERT INTO factory.skill_revision(id, skill_key, revision, content, content_digest, created_by)
          VALUES (${input.revisionId}, ${input.content.key}, ${input.expectedRevision + 1}, ${JSON.stringify(input.content)}::jsonb, ${contentDigest}, ${userID})`;
        await sql`INSERT INTO factory.skill_publication(revision_id, published, updated_by) VALUES (${input.revisionId}, true, ${userID})`;
        const libraryID = createHash("md5")
          .update(`factory-legacy-skill:${input.content.key}`)
          .digest("hex");
        const identity = `${libraryID.slice(0, 8)}-${libraryID.slice(8, 12)}-4${libraryID.slice(13, 16)}-8${libraryID.slice(17, 20)}-${libraryID.slice(20)}`;
        await sql`INSERT INTO factory.skill_library(id, storage_key, scope) VALUES (${identity}, ${input.content.key}, 'system') ON CONFLICT DO NOTHING`;
        await sql`INSERT INTO factory.skill_library_revision(library_id, revision_id) VALUES (${identity}, ${input.revisionId})`;
        return (await catalogue(sql)).find((revision) => revision.id === input.revisionId);
      });
    },
    async setPublication(revisionID: string, published: boolean, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql, true);
        await manager(sql, userID);
        const [changed] =
          await sql`UPDATE factory.skill_publication SET published = ${published}, updated_by = ${userID}, updated_at = now()
          WHERE revision_id = ${revisionID} RETURNING revision_id`;
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
        const [changed] =
          input.version === 0
            ? await sql`INSERT INTO factory.system_skill_settings(singleton, version, planning, build, updated_by)
              VALUES (true, 1, ${JSON.stringify(input.planning)}::jsonb, ${JSON.stringify(input.build)}::jsonb, ${userID}) ON CONFLICT DO NOTHING RETURNING version`
            : await sql`UPDATE factory.system_skill_settings SET version = version + 1,
              planning = ${JSON.stringify(input.planning)}::jsonb, build = ${JSON.stringify(input.build)}::jsonb, updated_by = ${userID}, updated_at = now()
              WHERE singleton AND version = ${input.version} RETURNING version`;
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
      sql: AgentTurnTransaction,
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
      sql: AgentTurnTransaction,
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
        const [changed] =
          input.version === 0
            ? await sql`INSERT INTO factory.project_skill_settings(project_id, version, planning, build, updated_by)
              VALUES (${projectID}, 1, ${JSON.stringify(input.planning)}::jsonb, ${JSON.stringify(input.build)}::jsonb, ${userID}) ON CONFLICT DO NOTHING RETURNING version`
            : await sql`UPDATE factory.project_skill_settings SET version = version + 1,
              planning = ${JSON.stringify(input.planning)}::jsonb, build = ${JSON.stringify(input.build)}::jsonb, updated_by = ${userID}, updated_at = now()
              WHERE project_id = ${projectID} AND version = ${input.version} RETURNING version`;
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
        const [changed] =
          input.version === 0
            ? await sql`INSERT INTO factory.personal_skill_settings(project_id, user_id, version, planning, build)
              VALUES (${projectID}, ${userID}, 1, ${input.planning === null ? null : JSON.stringify(input.planning)}::jsonb, ${input.build === null ? null : JSON.stringify(input.build)}::jsonb) ON CONFLICT DO NOTHING RETURNING version`
            : await sql`UPDATE factory.personal_skill_settings SET version = version + 1,
              planning = ${input.planning === null ? null : JSON.stringify(input.planning)}::jsonb, build = ${input.build === null ? null : JSON.stringify(input.build)}::jsonb, updated_at = now()
              WHERE project_id = ${projectID} AND user_id = ${userID} AND version = ${input.version} RETURNING version`;
        if (!changed) throw changedElsewhere();
        return inherited(sql, projectID, userID);
      });
    },
    async load(ids: string[], transaction?: AgentTurnTransaction): Promise<SkillRevision[]> {
      if (!ids.length) return [];
      const sql = transaction ?? database.client;
      const rows = await sql<
        Array<{
          id: string;
          revision: number;
          content: unknown;
          digest: string;
          published: boolean;
        }>
      >`
        SELECT revision.id, revision.revision::float8 AS revision, revision.content,
          revision.content_digest AS digest, publication.published
        FROM factory.skill_revision revision JOIN factory.skill_publication publication ON publication.revision_id = revision.id
        WHERE revision.id = ANY(${ids}::uuid[])
      `;
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
