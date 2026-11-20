import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql as expression,
} from "drizzle-orm";
import {
  defaultLibraryCover,
  libraryCoverInput,
} from "../../../../packages/conversation-domain/src/library-covers";
import {
  resolveLibraryChoice,
  type SkillLibraryView,
  skillChoiceInput,
  skillChoiceView,
  skillLibrarySaveInput,
  skillLibraryView,
  skillScopeInput,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillContent,
  type SkillRevision,
  skillContentInput,
  skillRevisionInput,
} from "../../../../packages/conversation-domain/src/skills";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  administrator,
  agentTurn,
  skillLibrary,
  skillLibraryChoice,
  skillLibraryRevision,
  skillPublication,
  skillRevision,
  skillShareProposal,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  initializeLibraryCoverIn,
  libraryCoversIn,
  saveLibraryCoverIn,
} from "../library-covers/store";
import { checkSkillSourceUpdate, previewRepositorySkill, previewSkillImport } from "./import";
import { starterSkills } from "./starters";

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
  async function capabilities(sql: DatabaseTransaction, userId: string, projectId?: string) {
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
  async function authority(
    sql: DatabaseTransaction,
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
  async function lock(sql: DatabaseTransaction) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
  }
  async function libraries(sql: DatabaseTransaction) {
    const rows = await drizzleTransaction(sql)
      .select()
      .from(skillLibrary)
      .orderBy(skillLibrary.scope, skillLibrary.storageKey);
    return rows.map((row): Library => ({ ...row, scope: skillScopeInput.parse(row.scope) }));
  }
  async function writeRevision(
    sql: DatabaseTransaction,
    library: Library,
    revisionId: string,
    expected: number,
    content: SkillContent,
    userId: string,
    copiedFrom?: string,
  ) {
    const digest = hash(content);
    const db = drizzleTransaction(sql);
    const [existing] = await db
      .select({
        digest: skillRevision.contentDigest,
        revision: skillRevision.revision,
        createdBy: skillRevision.createdBy,
        libraryId: skillLibraryRevision.libraryId,
      })
      .from(skillRevision)
      .innerJoin(skillLibraryRevision, eq(skillLibraryRevision.revisionId, skillRevision.id))
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
    });
    await db.insert(skillPublication).values({ revisionId, published: true, updatedBy: userId });
    await db.insert(skillLibraryRevision).values({
      libraryId: library.id,
      revisionId,
      copiedFrom: copiedFrom ?? null,
    });
  }
  async function seed(sql: DatabaseTransaction, userId: string) {
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
      const library: Library = {
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
      await writeRevision(
        sql,
        library,
        starter.revisionId,
        0,
        skillContentInput.parse(starter.content),
        admin?.id ?? userId,
      );
      if (starter.enabled)
        for (const role of starter.content.roles)
          await db.insert(skillLibraryChoice).values({
            libraryId: library.id,
            scope: "system",
            contextId: nil,
            userId: nil,
            role,
            state: "enable",
            revisionId: starter.revisionId,
            version: 1,
          });
    }
  }
  async function viewIn(
    sql: DatabaseTransaction,
    userId: string,
    projectId?: string,
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
    const db = drizzleTransaction(sql);
    const rows = await db
      .select({
        libraryId: skillLibraryRevision.libraryId,
        id: skillRevision.id,
        revision: skillRevision.revision,
        content: skillRevision.content,
        digest: skillRevision.contentDigest,
        published: skillPublication.published,
      })
      .from(skillLibraryRevision)
      .innerJoin(skillRevision, eq(skillRevision.id, skillLibraryRevision.revisionId))
      .innerJoin(skillPublication, eq(skillPublication.revisionId, skillRevision.id))
      .where(
        inArray(
          skillLibraryRevision.libraryId,
          visible.map((item) => item.id),
        ),
      )
      .orderBy(desc(skillRevision.revision));
    const choices = (
      await db
        .select({
          libraryId: skillLibraryChoice.libraryId,
          scope: skillLibraryChoice.scope,
          role: skillLibraryChoice.role,
          state: skillLibraryChoice.state,
          revisionId: skillLibraryChoice.revisionId,
          version: skillLibraryChoice.version,
        })
        .from(skillLibraryChoice)
        .where(
          or(
            eq(skillLibraryChoice.scope, "system"),
            and(
              eq(skillLibraryChoice.contextId, projectId ?? nil),
              or(
                eq(skillLibraryChoice.scope, "project"),
                and(
                  eq(skillLibraryChoice.scope, "personal"),
                  eq(skillLibraryChoice.userId, userId),
                ),
              ),
            ),
          ),
        )
    ).map((row) => skillChoiceView.parse(row));
    const proposals = skillLibraryView.shape.proposals.parse(
      await db
        .select({
          id: skillShareProposal.id,
          revisionId: skillShareProposal.revisionId,
          target: skillShareProposal.target,
          projectId: skillShareProposal.projectId,
          name: expression<string>`${skillRevision.content}->>'name'`,
        })
        .from(skillShareProposal)
        .innerJoin(skillRevision, eq(skillRevision.id, skillShareProposal.revisionId))
        .where(
          and(
            isNull(skillShareProposal.acceptedLibraryId),
            or(
              eq(skillShareProposal.proposedBy, userId),
              and(eq(skillShareProposal.target, "system"), expression`${access.canManageSystem}`),
              and(
                eq(skillShareProposal.projectId, projectId ?? nil),
                expression`${access.canManageProject}`,
              ),
            ),
          ),
        ),
    );
    return {
      ...access,
      sharedVersions: (
        await db
          .selectDistinct({
            id: skillRevision.id,
            revision: skillRevision.revision,
            content: skillRevision.content,
            digest: skillRevision.contentDigest,
            published: skillPublication.published,
          })
          .from(skillRevision)
          .innerJoin(skillPublication, eq(skillPublication.revisionId, skillRevision.id))
          .innerJoin(skillLibraryRevision, eq(skillLibraryRevision.revisionId, skillRevision.id))
          .innerJoin(skillLibrary, eq(skillLibrary.id, skillLibraryRevision.libraryId))
          .where(
            and(
              eq(skillLibrary.scope, "personal"),
              ne(skillLibrary.ownerId, userId),
              exists(
                db
                  .select({ id: agentTurn.id })
                  .from(agentTurn)
                  .where(
                    and(
                      eq(agentTurn.projectId, projectId ?? nil),
                      isNotNull(agentTurn.ticketId),
                      expression`${agentTurn.authority}->'skillRevisionIds' ? ${skillRevision.id}::text`,
                    ),
                  ),
              ),
            ),
          )
          .limit(100)
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
    async viewIn(sql: DatabaseTransaction, userId: string, projectId?: string) {
      await lock(sql);
      await capabilities(sql, userId, projectId);
      await seed(sql, userId);
      return viewIn(sql, userId, projectId);
    },
    async saveIn(sql: DatabaseTransaction, value: unknown, userId: string) {
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
        await drizzleTransaction(sql).insert(skillLibrary).values(library);
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
    async chooseIn(sql: DatabaseTransaction, value: unknown, userId: string) {
      const input = skillChoiceInput.parse(value);
      await lock(sql);
      await authority(sql, userId, input.scope, input.projectId);
      if (input.scope !== "system" && !input.projectId)
        throw new CommandError("conflict", "Select a Project for skill choices");
      if (input.state === "required" && input.scope === "personal")
        throw new CommandError("conflict", "Only managers can require a skill");
      const view = await viewIn(sql, userId, input.projectId);
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
      const db = drizzleTransaction(sql);
      const [current] = await db
        .select({ version: skillLibraryChoice.version })
        .from(skillLibraryChoice)
        .where(
          and(
            eq(skillLibraryChoice.libraryId, entry.id),
            eq(skillLibraryChoice.scope, input.scope),
            eq(skillLibraryChoice.contextId, context),
            eq(skillLibraryChoice.userId, owner),
            eq(skillLibraryChoice.role, input.role),
          ),
        );
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new CommandError(
          "conflict",
          "Skill choices changed elsewhere. Reload before saving.",
        );
      const values = {
        state: input.state,
        revisionId: revision.id,
        version: (current?.version ?? 0) + 1,
      };
      await db
        .insert(skillLibraryChoice)
        .values({
          ...values,
          libraryId: entry.id,
          scope: input.scope,
          contextId: context,
          userId: owner,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: [
            skillLibraryChoice.libraryId,
            skillLibraryChoice.scope,
            skillLibraryChoice.contextId,
            skillLibraryChoice.userId,
            skillLibraryChoice.role,
          ],
          set: values,
        });
      return { saved: true };
    },
    async choose(value: unknown, userId: string) {
      return database.client.begin((sql) => this.chooseIn(sql, value, userId));
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
        const db = drizzleTransaction(sql);
        const [owned] = await db
          .select({ revisionId: skillLibraryRevision.revisionId })
          .from(skillLibraryRevision)
          .innerJoin(skillLibrary, eq(skillLibrary.id, skillLibraryRevision.libraryId))
          .where(
            and(eq(skillLibraryRevision.revisionId, revisionId), eq(skillLibrary.ownerId, userId)),
          );
        if (!owned) throw new CommandError("not-found", "Personal skill version not found");
        const [existing] = await db
          .select({
            revisionId: skillShareProposal.revisionId,
            proposedBy: skillShareProposal.proposedBy,
            target: skillShareProposal.target,
            projectId: skillShareProposal.projectId,
          })
          .from(skillShareProposal)
          .where(eq(skillShareProposal.id, id));
        if (
          existing &&
          (existing.revisionId !== revisionId ||
            existing.proposedBy !== userId ||
            existing.target !== target ||
            existing.projectId !== (target === "project" ? projectId : null))
        )
          throw new CommandError("conflict", "Sharing identity reused with different input");
        await db
          .insert(skillShareProposal)
          .values({
            id,
            revisionId,
            proposedBy: userId,
            target,
            projectId: target === "project" ? (projectId ?? null) : null,
          })
          .onConflictDoNothing();
        return { id };
      });
    },
    async accept(proposalId: string, userId: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        const db = drizzleTransaction(sql);
        const [proposal] = await db
          .select({
            revisionId: skillShareProposal.revisionId,
            target: skillShareProposal.target,
            projectId: skillShareProposal.projectId,
            accepted: skillShareProposal.acceptedLibraryId,
            content: skillRevision.content,
          })
          .from(skillShareProposal)
          .innerJoin(skillRevision, eq(skillRevision.id, skillShareProposal.revisionId))
          .where(eq(skillShareProposal.id, proposalId));
        if (!proposal) throw new CommandError("not-found", "Sharing proposal not found");
        const target = skillScopeInput.extract(["system", "project"]).parse(proposal.target);
        await authority(sql, userId, target, proposal.projectId ?? undefined);
        if (proposal.accepted) return { libraryId: proposal.accepted };
        const library: Library = {
          id: proposalId,
          storageKey: `shared-${proposalId}`,
          scope: target,
          ownerId: null,
          projectId: proposal.projectId,
        };
        await db.insert(skillLibrary).values(library);
        const [source] = await db
          .select({ libraryId: skillLibraryRevision.libraryId })
          .from(skillLibraryRevision)
          .where(eq(skillLibraryRevision.revisionId, proposal.revisionId));
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
        await db
          .update(skillShareProposal)
          .set({ acceptedLibraryId: library.id })
          .where(eq(skillShareProposal.id, proposalId));
        return { libraryId: library.id };
      });
    },
    async inspect(revisionId: string, userId: string, projectId?: string): Promise<SkillRevision> {
      return database.client.begin(async (sql) => {
        const access = await capabilities(sql, userId, projectId);
        const db = drizzleTransaction(sql);
        const [row] = await db
          .select({
            id: skillRevision.id,
            revision: skillRevision.revision,
            content: skillRevision.content,
            digest: skillRevision.contentDigest,
            published: skillPublication.published,
          })
          .from(skillRevision)
          .innerJoin(skillPublication, eq(skillPublication.revisionId, skillRevision.id))
          .innerJoin(skillLibraryRevision, eq(skillLibraryRevision.revisionId, skillRevision.id))
          .innerJoin(skillLibrary, eq(skillLibrary.id, skillLibraryRevision.libraryId))
          .where(
            and(
              eq(skillRevision.id, revisionId),
              or(
                eq(skillLibrary.scope, "system"),
                eq(skillLibrary.ownerId, userId),
                eq(skillLibrary.projectId, projectId ?? nil),
                exists(
                  db
                    .select({ id: agentTurn.id })
                    .from(agentTurn)
                    .where(
                      and(
                        eq(agentTurn.projectId, projectId ?? nil),
                        isNotNull(agentTurn.ticketId),
                        expression`${agentTurn.authority}->'skillRevisionIds' ? ${skillRevision.id}::text`,
                      ),
                    ),
                ),
                exists(
                  db
                    .select({ id: skillShareProposal.id })
                    .from(skillShareProposal)
                    .where(
                      and(
                        eq(skillShareProposal.revisionId, skillRevision.id),
                        or(
                          and(
                            eq(skillShareProposal.target, "system"),
                            expression`${access.canManageSystem}`,
                          ),
                          and(
                            eq(skillShareProposal.projectId, projectId ?? nil),
                            expression`${access.canManageProject}`,
                          ),
                        ),
                      ),
                    ),
                ),
              ),
            ),
          );
        if (!row) throw new CommandError("not-found", "Skill version not found");
        return skillRevisionInput.parse(row);
      });
    },
  };
}
