import { createHash } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  skillContentInput,
  skillRevisionInput,
  type SkillContent,
  type SkillRevision,
} from "../../../../packages/conversation-domain/src/skills";
import {
  librarySkillIds,
  resolveLibraryChoice,
  skillLibrarySaveInput,
  skillChoiceInput,
  type SkillLibraryView,
  type LibraryChoice,
} from "../../../../packages/conversation-domain/src/skill-library";
import type { InheritedSkillSettings } from "../../../../packages/conversation-domain/src/skill-inheritance";
type RetainedSettings = Pick<InheritedSkillSettings, "system" | "project" | "personal">;
import { projectAuthorityIn, requireActiveAccountIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { starterSkills } from "./starters";
import { previewSkillImport, previewRepositorySkill, checkSkillSourceUpdate } from "./import";
import {
  defaultLibraryCover,
  libraryCoverInput,
} from "../../../../packages/conversation-domain/src/library-covers";
import {
  initializeLibraryCoverIn,
  libraryCoversIn,
  saveLibraryCoverIn,
} from "../library-covers/store";

const nil = "00000000-0000-0000-0000-000000000000";
const hash = (content: SkillContent) =>
  createHash("sha256").update(JSON.stringify(content)).digest("hex");
type Library = {
  id: string;
  storageKey: string;
  scope: "system" | "project" | "personal";
  ownerId: string | null;
  projectId: string | null;
};

export function createSkillLibraryController(database: ReturnType<typeof createDatabase>) {
  async function capabilities(sql: AgentTurnTransaction, userId: string, projectId?: string) {
    await requireActiveAccountIn(sql, userId);
    const [admin] =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id = ${userId} FOR SHARE`;
    return {
      canManageSystem: Boolean(admin),
      canManageProject: projectId ? await projectAuthorityIn(sql, userId, projectId) : false,
    };
  }
  async function authority(
    sql: AgentTurnTransaction,
    userId: string,
    scope: Library["scope"],
    projectId?: string,
  ) {
    const access = await capabilities(sql, userId, projectId);
    if (scope === "system" && !access.canManageSystem)
      throw new CommandError("forbidden", "Factory administrator access required");
    if (scope === "project" && (!projectId || !access.canManageProject))
      throw new CommandError("forbidden", "Project manager access required");
  }
  async function lock(sql: AgentTurnTransaction) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
  }
  async function libraries(sql: AgentTurnTransaction) {
    return sql<
      Library[]
    >`SELECT id, storage_key AS "storageKey", scope, owner_id AS "ownerId", project_id AS "projectId" FROM factory.skill_library ORDER BY scope, storage_key`;
  }
  async function writeRevision(
    sql: AgentTurnTransaction,
    library: Library,
    revisionId: string,
    expected: number,
    content: SkillContent,
    userId: string,
    copiedFrom?: string,
  ) {
    const digest = hash(content);
    const [existing] = await sql<
      Array<{ digest: string; revision: number; createdBy: string; libraryId: string }>
    >`
      SELECT r.content_digest AS digest, r.revision::float8 AS revision, r.created_by AS "createdBy", link.library_id AS "libraryId"
      FROM factory.skill_revision r JOIN factory.skill_library_revision link ON link.revision_id = r.id WHERE r.id = ${revisionId}`;
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
    const [latest] = await sql<
      Array<{ revision: number }>
    >`SELECT COALESCE(max(revision), 0)::float8 AS revision FROM factory.skill_revision WHERE skill_key = ${library.storageKey}`;
    if (latest?.revision !== expected)
      throw new CommandError("conflict", "This skill changed elsewhere. Reload before saving.");
    await sql`INSERT INTO factory.skill_revision(id, skill_key, revision, content, content_digest, created_by)
      VALUES (${revisionId}, ${library.storageKey}, ${expected + 1}, ${JSON.stringify(content)}::jsonb, ${digest}, ${userId})`;
    await sql`INSERT INTO factory.skill_publication(revision_id, published, updated_by) VALUES (${revisionId}, true, ${userId})`;
    await sql`INSERT INTO factory.skill_library_revision(library_id, revision_id, copied_from) VALUES (${library.id}, ${revisionId}, ${copiedFrom ?? null})`;
  }
  async function seed(sql: AgentTurnTransaction, userId: string) {
    const [administrator] = await sql<
      Array<{ id: string }>
    >`SELECT user_id AS id FROM factory.administrator ORDER BY user_id LIMIT 1`;
    const [oldSettings] =
      await sql`SELECT singleton FROM factory.system_skill_settings WHERE singleton`;
    for (const starter of starterSkills) {
      const [existing] = await sql`SELECT id FROM factory.skill_library WHERE id = ${starter.id}`;
      if (existing) continue;
      const library: Library = {
        id: starter.id,
        storageKey: `library-${starter.id}`,
        scope: "system",
        ownerId: null,
        projectId: null,
      };
      await sql`INSERT INTO factory.skill_library(id, storage_key, scope) VALUES (${library.id}, ${library.storageKey}, 'system')`;
      await writeRevision(
        sql,
        library,
        starter.revisionId,
        0,
        skillContentInput.parse(starter.content),
        administrator?.id ?? userId,
      );
      if (starter.enabled && !oldSettings)
        for (const role of starter.content.roles)
          await sql`INSERT INTO factory.skill_library_choice(library_id, scope, context_id, user_id, role, state, revision_id, version)
          VALUES (${library.id}, 'system', ${nil}, ${nil}, ${role}, 'enable', ${starter.revisionId}, 1)`;
    }
  }
  async function viewIn(
    sql: AgentTurnTransaction,
    userId: string,
    projectId?: string,
    legacy?: RetainedSettings,
  ): Promise<SkillLibraryView> {
    const access = await capabilities(sql, userId, projectId);
    const all = await libraries(sql);
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
    const rows = await sql<
      Array<{
        libraryId: string;
        id: string;
        revision: number;
        content: unknown;
        digest: string;
        published: boolean;
      }>
    >`
      SELECT link.library_id AS "libraryId", revision.id, revision.revision::float8 AS revision, revision.content, revision.content_digest AS digest, publication.published
      FROM factory.skill_library_revision link JOIN factory.skill_revision revision ON revision.id = link.revision_id
      JOIN factory.skill_publication publication ON publication.revision_id = revision.id
      WHERE link.library_id = ANY(${visible.map((item) => item.id)}::uuid[]) ORDER BY revision.revision DESC`;
    const choices = await sql<
      LibraryChoice[]
    >`SELECT library_id AS "libraryId", scope, role, state, revision_id AS "revisionId", version::float8 AS version FROM factory.skill_library_choice
      WHERE scope = 'system' OR (context_id = ${projectId ?? nil} AND (scope = 'project' OR (scope = 'personal' AND user_id = ${userId})))`;
    // Translate retained whole-list settings into per-skill choices without rewriting history.
    if (legacy)
      for (const role of ["planning", "build"] as const)
        for (const library of visible) {
          const ids = rows.filter((row) => row.libraryId === library.id).map((row) => row.id);
          const global = legacy.system[role];
          const base = [...global.required, ...global.optional].find((id) => ids.includes(id));
          if (!base) continue;
          const add = (
            scope: LibraryChoice["scope"],
            state: LibraryChoice["state"],
            revisionId: string,
          ) => {
            if (
              !choices.some(
                (item) =>
                  item.libraryId === library.id && item.role === role && item.scope === scope,
              )
            )
              choices.push({ libraryId: library.id, scope, role, state, revisionId, version: 0 });
          };
          add(
            "system",
            global.required.includes(base)
              ? "required"
              : global.selected.includes(base)
                ? "enable"
                : "disable",
            base,
          );
          const project = legacy.project[role];
          if (project.required.includes(base)) add("project", "required", base);
          else if (
            (project.optional !== null && !project.optional.includes(base)) ||
            (project.selected !== null && !project.selected.includes(base))
          )
            add("project", "disable", base);
          else if (project.selected?.includes(base)) add("project", "enable", base);
          const personal = legacy.personal[role];
          if (personal !== null)
            add("personal", personal.includes(base) ? "enable" : "disable", base);
        }
    const proposals = await sql<
      SkillLibraryView["proposals"]
    >`SELECT proposal.id, proposal.revision_id AS "revisionId", proposal.target, proposal.project_id AS "projectId", revision.content->>'name' AS name
      FROM factory.skill_share_proposal proposal JOIN factory.skill_revision revision ON revision.id = proposal.revision_id
      WHERE proposal.accepted_library_id IS NULL AND (proposal.proposed_by = ${userId} OR (proposal.target = 'system' AND ${access.canManageSystem}) OR (proposal.project_id = ${projectId ?? nil} AND ${access.canManageProject}))`;
    return {
      ...access,
      sharedVersions: (
        await sql<
          Array<{
            id: string;
            revision: number;
            content: unknown;
            digest: string;
            published: boolean;
          }>
        >`
        SELECT DISTINCT revision.id, revision.revision::float8 AS revision, revision.content, revision.content_digest AS digest, publication.published
        FROM factory.skill_revision revision JOIN factory.skill_publication publication ON publication.revision_id = revision.id
        JOIN factory.skill_library_revision link ON link.revision_id = revision.id JOIN factory.skill_library library ON library.id = link.library_id
        WHERE library.scope = 'personal' AND library.owner_id != ${userId}
          AND EXISTS (SELECT 1 FROM factory.agent_turn turn WHERE turn.project_id = ${projectId ?? nil} AND turn.authority->'skillRevisionIds' ? revision.id::text)
        LIMIT 100`
      ).map((row) => skillRevisionInput.parse(row)),
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
  return {
    async checkSource(revisionId: string, userId: string, projectId?: string) {
      const revision = await this.inspect(revisionId, userId, projectId);
      if (!revision.content.origin)
        throw new CommandError("conflict", "This skill has no repository source");
      const { repository, commit, path } = revision.content.origin;
      return checkSkillSourceUpdate({ repository, commit, path });
    },
    async preview(value: unknown, userId: string, repository = false) {
      await database.client.begin((sql) => requireActiveAccountIn(sql, userId));
      return repository ? previewRepositorySkill(value) : previewSkillImport(value);
    },
    async viewIn(
      sql: AgentTurnTransaction,
      userId: string,
      projectId?: string,
      legacy?: RetainedSettings,
    ) {
      await lock(sql);
      await capabilities(sql, userId, projectId);
      await seed(sql, userId);
      return viewIn(sql, userId, projectId, legacy);
    },
    async saveIn(sql: AgentTurnTransaction, value: unknown, userId: string) {
      const input = skillLibrarySaveInput.parse(value);
      await lock(sql);
      await authority(sql, userId, input.scope, input.projectId);
      let library = (await libraries(sql)).find((item) => item.id === input.libraryId);
      if (library) {
        if (
          library.scope !== input.scope ||
          (library.scope === "personal" && library.ownerId !== userId) ||
          (library.scope === "project" && library.projectId !== input.projectId)
        )
          throw new CommandError("not-found", "Skill not found");
      } else {
        if (input.expectedRevision !== 0)
          throw new CommandError("conflict", "The previous skill version is unavailable");
        library = {
          id: input.libraryId,
          storageKey: `library-${input.libraryId}`,
          scope: input.scope,
          ownerId: input.scope === "personal" ? userId : null,
          projectId: input.scope === "project" ? (input.projectId ?? null) : null,
        };
        await sql`INSERT INTO factory.skill_library(id, storage_key, scope, owner_id, project_id) VALUES (${library.id}, ${library.storageKey}, ${library.scope}, ${library.ownerId}, ${library.projectId})`;
        await initializeLibraryCoverIn(
          sql,
          "skill",
          library.id,
          defaultLibraryCover(library.id),
          userId,
        );
      }
      await writeRevision(
        sql,
        library,
        input.revisionId,
        input.expectedRevision,
        input.content,
        userId,
      );
      return { libraryId: library.id, revisionId: input.revisionId };
    },
    async save(value: unknown, userId: string) {
      return database.client.begin((sql) => this.saveIn(sql, value, userId));
    },
    async cover(value: unknown, userId: string) {
      const input = libraryCoverInput.parse(value);
      return database.client.begin(async (sql) => {
        await lock(sql);
        const library = (await libraries(sql)).find((item) => item.id === input.libraryId);
        if (!library || (library.scope === "personal" && library.ownerId !== userId))
          throw new CommandError("not-found", "Skill not found");
        await authority(sql, userId, library.scope, library.projectId ?? undefined);
        return saveLibraryCoverIn(sql, "skill", input, userId);
      });
    },
    async chooseIn(
      sql: AgentTurnTransaction,
      value: unknown,
      userId: string,
      legacy?: (sql: AgentTurnTransaction) => Promise<RetainedSettings>,
    ) {
      const input = skillChoiceInput.parse(value);
      await lock(sql);
      await authority(sql, userId, input.scope, input.projectId);
      if (input.scope !== "system" && !input.projectId)
        throw new CommandError("conflict", "Select a Project for skill choices");
      if (input.state === "required" && input.scope === "personal")
        throw new CommandError("conflict", "Only managers can require a skill");
      const view = await viewIn(sql, userId, input.projectId, await legacy?.(sql));
      const entry = view.entries.find((item) => item.id === input.libraryId);
      if (
        !entry ||
        (input.scope === "system" && entry.scope !== "system") ||
        (input.scope === "project" && entry.scope === "personal")
      )
        throw new CommandError("not-found", "Skill is unavailable at this scope");
      const parents = view.choices.filter(
        (item) =>
          item.scope !== input.scope && (input.scope === "personal" || item.scope === "system"),
      );
      const required = resolveLibraryChoice(parents, entry.id, input.role);
      if (required?.state === "required")
        throw new CommandError("conflict", "This skill is required by an inherited rule");
      const revisionId = input.revisionId ?? entry.revisions[0]?.id;
      const revision = entry.revisions.find((item) => item.id === revisionId);
      if (!revision?.published || !revision.content.roles.includes(input.role))
        throw new CommandError("conflict", "Select an available version for this role");
      const context = input.scope === "system" ? nil : (input.projectId ?? nil);
      const owner = input.scope === "personal" ? userId : nil;
      const [current] = await sql<
        Array<{ version: number }>
      >`SELECT version::float8 AS version FROM factory.skill_library_choice WHERE library_id = ${entry.id} AND scope = ${input.scope} AND context_id = ${context} AND user_id = ${owner} AND role = ${input.role}`;
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new CommandError(
          "conflict",
          "Skill choices changed elsewhere. Reload before saving.",
        );
      await sql`INSERT INTO factory.skill_library_choice(library_id, scope, context_id, user_id, role, state, revision_id, version)
          VALUES (${entry.id}, ${input.scope}, ${context}, ${owner}, ${input.role}, ${input.state}, ${revision.id}, ${(current?.version ?? 0) + 1})
          ON CONFLICT (library_id, scope, context_id, user_id, role) DO UPDATE SET state = EXCLUDED.state, revision_id = EXCLUDED.revision_id, version = EXCLUDED.version`;
      return { saved: true };
    },
    async choose(
      value: unknown,
      userId: string,
      legacy?: (sql: AgentTurnTransaction) => Promise<RetainedSettings>,
    ) {
      return database.client.begin((sql) => this.chooseIn(sql, value, userId, legacy));
    },
    async propose(
      id: string,
      revisionId: string,
      target: "project" | "system",
      projectId: string | undefined,
      userId: string,
    ) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        await capabilities(sql, userId, projectId);
        if (target === "project" && !projectId)
          throw new CommandError("conflict", "Select a Project to share with");
        const [owned] =
          await sql`SELECT link.revision_id FROM factory.skill_library_revision link JOIN factory.skill_library library ON library.id = link.library_id WHERE link.revision_id = ${revisionId} AND library.owner_id = ${userId}`;
        if (!owned) throw new CommandError("not-found", "Personal skill version not found");
        const [existing] = await sql<
          Array<{
            revisionId: string;
            proposedBy: string;
            target: string;
            projectId: string | null;
          }>
        >`SELECT revision_id AS "revisionId", proposed_by AS "proposedBy", target, project_id AS "projectId" FROM factory.skill_share_proposal WHERE id = ${id}`;
        if (
          existing &&
          (existing.revisionId !== revisionId ||
            existing.proposedBy !== userId ||
            existing.target !== target ||
            existing.projectId !== (target === "project" ? projectId : null))
        )
          throw new CommandError("conflict", "Sharing identity reused with different input");
        await sql`INSERT INTO factory.skill_share_proposal(id, revision_id, proposed_by, target, project_id) VALUES (${id}, ${revisionId}, ${userId}, ${target}, ${target === "project" ? (projectId ?? null) : null}) ON CONFLICT DO NOTHING`;
        return { id };
      });
    },
    async accept(proposalId: string, userId: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        const [proposal] = await sql<
          Array<{
            revisionId: string;
            target: "project" | "system";
            projectId: string | null;
            accepted: string | null;
            content: unknown;
          }>
        >`SELECT proposal.revision_id AS "revisionId", proposal.target, proposal.project_id AS "projectId", proposal.accepted_library_id AS accepted, revision.content FROM factory.skill_share_proposal proposal JOIN factory.skill_revision revision ON revision.id = proposal.revision_id WHERE proposal.id = ${proposalId}`;
        if (!proposal) throw new CommandError("not-found", "Sharing proposal not found");
        await authority(sql, userId, proposal.target, proposal.projectId ?? undefined);
        if (proposal.accepted) return { libraryId: proposal.accepted };
        const library: Library = {
          id: proposalId,
          storageKey: `shared-${proposalId}`,
          scope: proposal.target,
          ownerId: null,
          projectId: proposal.projectId,
        };
        await sql`INSERT INTO factory.skill_library(id, storage_key, scope, project_id) VALUES (${library.id}, ${library.storageKey}, ${library.scope}, ${library.projectId})`;
        const [source] = await sql<Array<{ libraryId: string }>>`
          SELECT library_id AS "libraryId" FROM factory.skill_library_revision
          WHERE revision_id = ${proposal.revisionId}`;
        const cover = source
          ? (await libraryCoversIn(sql, "skill", [source.libraryId])).get(source.libraryId)
          : undefined;
        await initializeLibraryCoverIn(
          sql,
          "skill",
          library.id,
          cover?.key ?? defaultLibraryCover(library.id),
          userId,
        );
        // Deterministic copy identity, isolated from the author's mutable future versions.
        const identity = createHash("md5").update(`shared-revision:${proposalId}`).digest("hex");
        const revisionId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20)}`;
        await writeRevision(
          sql,
          library,
          revisionId,
          0,
          skillContentInput.parse(proposal.content),
          userId,
          proposal.revisionId,
        );
        await sql`UPDATE factory.skill_share_proposal SET accepted_library_id = ${library.id} WHERE id = ${proposalId}`;
        return { libraryId: library.id };
      });
    },
    async inspect(revisionId: string, userId: string, projectId?: string): Promise<SkillRevision> {
      return database.client.begin(async (sql) => {
        const access = await capabilities(sql, userId, projectId);
        const [row] = await sql<
          Array<{
            id: string;
            revision: number;
            content: unknown;
            digest: string;
            published: boolean;
          }>
        >`
          SELECT revision.id, revision.revision::float8 AS revision, revision.content, revision.content_digest AS digest, publication.published
          FROM factory.skill_revision revision JOIN factory.skill_publication publication ON publication.revision_id = revision.id
          JOIN factory.skill_library_revision link ON link.revision_id = revision.id JOIN factory.skill_library library ON library.id = link.library_id
          WHERE revision.id = ${revisionId} AND (library.scope = 'system' OR library.owner_id = ${userId} OR library.project_id = ${projectId ?? nil}
            OR EXISTS (SELECT 1 FROM factory.agent_turn turn WHERE turn.project_id = ${projectId ?? nil} AND turn.authority->'skillRevisionIds' ? revision.id::text)
            OR EXISTS (SELECT 1 FROM factory.skill_share_proposal proposal WHERE proposal.revision_id = revision.id AND ((proposal.target = 'system' AND ${access.canManageSystem}) OR (proposal.project_id = ${projectId ?? nil} AND ${access.canManageProject}))))`;
        if (!row) throw new CommandError("not-found", "Skill version not found");
        return skillRevisionInput.parse(row);
      });
    },
    resolveIds: librarySkillIds,
  };
}
