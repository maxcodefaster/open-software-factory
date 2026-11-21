import { createHash } from "node:crypto";
import { and, asc, eq, sql as expression, inArray } from "drizzle-orm";
import { agentTurnAuthorityInput } from "../../../../packages/conversation-domain/src/agent-turn";
import {
  librarySkillAssignments,
  skillChoiceInput,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  type SkillContent,
  type SkillRevision,
  type SkillRole,
  skillContentInput,
  skillRevisionInput,
} from "../../../../packages/conversation-domain/src/skills";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  skillPublication,
  skillRevision,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn, requireSystemManagerIn } from "../access/authority";
import { CommandError } from "../command-error";
import { createSkillLibraryController } from "./library-controller";

function digest(content: SkillContent) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function createSkillController(database: ReturnType<typeof createDatabase>) {
  const library = createSkillLibraryController(database);
  async function lock(sql: DatabaseTransaction) {
    await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
  }
  function choice(value: unknown, projectID?: string) {
    const input = skillChoiceInput.parse(value);
    if (projectID && input.projectId !== projectID)
      throw new CommandError("conflict", "Skill choice Project does not match its context");
    return input;
  }
  return {
    async invocations(projectID: string, userID: string, role: SkillRole, changeID?: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
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
      return library.viewIn(sql, userID, projectID);
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
      return library.chooseIn(sql, choice(value, projectID), userID);
    },
    async chooseLibrary(value: unknown, userID: string, projectID?: string) {
      return library.choose(choice(value, projectID), userID);
    },
    async setPublication(revisionID: string, published: boolean, userID: string) {
      return database.client.begin(async (sql) => {
        await lock(sql);
        await requireSystemManagerIn(sql, userID);
        const [changed] = await drizzleTransaction(sql)
          .update(skillPublication)
          .set({ published, updatedBy: userID, updatedAt: expression`now()` })
          .where(eq(skillPublication.revisionId, revisionID))
          .returning({ revisionId: skillPublication.revisionId });
        if (!changed) throw new CommandError("not-found", "Skill revision not found");
        return { revisionId: changed.revisionId, published };
      });
    },
    async resolveAssignment(
      role: SkillRole,
      sql: DatabaseTransaction,
      context: { projectID: string; userID: string; personal?: boolean },
    ) {
      const view = await library.viewIn(sql, context.userID, context.projectID);
      try {
        const assignments = librarySkillAssignments(
          view.entries,
          view.choices,
          role,
          context.personal !== false,
        );
        return {
          revisionIds: assignments.map((item) => item.revisionId),
          requiredRevisionIds: assignments
            .filter((item) => item.required)
            .map((item) => item.revisionId),
        };
      } catch (error) {
        throw new CommandError(
          "unavailable",
          error instanceof Error ? error.message : "Skill choices are unavailable",
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
