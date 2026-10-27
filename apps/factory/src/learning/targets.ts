import type { createDatabase } from "../../../../packages/db/src/client";
import {
  applyLearningEdit,
  learningEdit,
  type LearningEdit,
  type LearningTarget,
} from "../../../../packages/conversation-domain/src/learning";
import {
  skillContentInput,
  type SkillContent,
} from "../../../../packages/conversation-domain/src/skills";
import type { LibraryChoice } from "../../../../packages/conversation-domain/src/skill-library";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";
import { createSkillController } from "../skills/controller";
import { editKnowledgeIn } from "../knowledge/edit";
import { manageMonitoringIn } from "../monitoring/authority";
import { editInputInstructionsIn } from "../monitoring/instructions";

type Database = ReturnType<typeof createDatabase>;
export const learningActivation = z.object({
  role: z.enum(["planning", "build"]),
  scope: z.enum(["personal", "project", "system"]),
  state: z.enum(["enable", "required"]),
  beforeVersion: z.number().int().nonnegative(),
  afterVersion: z.number().int().positive(),
});
export type LearningActivation = z.infer<typeof learningActivation>;
type Scope = { scope: "personal" | "project" | "system"; ownerId: string | null; label: string };
export const learningEditDigest = (value: LearningEdit) =>
  createHash("sha256")
    .update(JSON.stringify(learningEdit.parse(value)))
    .digest("hex");
export function createLearningTargets(database: Database) {
  const skills = createSkillController(database);
  async function authorize(
    sql: AgentTurnTransaction,
    target: LearningTarget,
    userId: string,
    projectId: string,
  ): Promise<Scope> {
    await projectAuthorityIn(sql, userId, projectId);
    if (target.kind === "skill") {
      const [entry] = await sql<
        { scope: Scope["scope"]; ownerId: string | null; projectId: string | null; label: string }[]
      >`
        SELECT library.scope,library.owner_id AS "ownerId",library.project_id AS "projectId",revision.content->>'name' AS label
        FROM factory.skill_library library
        JOIN factory.skill_library_revision link ON link.library_id=library.id AND link.revision_id=${target.revisionId}
        JOIN factory.skill_revision revision ON revision.id=link.revision_id WHERE library.id=${target.id}`;
      if (
        !entry ||
        (entry.scope === "personal" && entry.ownerId !== userId) ||
        (entry.scope === "project" && entry.projectId !== projectId)
      )
        throw new CommandError("not-found", "Improvement target not found");
      if (entry.scope === "system") {
        await requireActiveAccountIn(sql, userId);
        const [admin] =
          await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userId} FOR SHARE`;
        if (!admin)
          throw new CommandError(
            "forbidden",
            "Factory administrator access is required to change this inherited Skill.",
          );
      }
      if (entry.scope === "project") await projectAuthorityIn(sql, userId, projectId, true);
      return { scope: entry.scope, ownerId: entry.ownerId, label: entry.label };
    }
    if (target.kind === "knowledge") {
      const [page] = await sql<
        { title: string }[]
      >`SELECT title FROM factory.knowledge_page WHERE id=${target.id} AND project_id=${projectId} AND state='active'`;
      if (!page) throw new CommandError("not-found", "Improvement target not found");
      return { scope: "project", ownerId: null, label: page.title };
    }
    const [hook] = await sql<
      { delegation: "prepare-ticket" | "application-fix-and-delivery"; name: string }[]
    >`
      SELECT policy.delegation,hook.name FROM factory.monitoring_hook hook
      JOIN factory.monitoring_policy policy ON policy.id=hook.policy_id
      WHERE hook.id=${target.id} AND hook.project_id=${projectId}`;
    if (!hook) throw new CommandError("not-found", "Improvement target not found");
    await manageMonitoringIn(sql, userId, projectId, hook.delegation);
    return { scope: "project", ownerId: null, label: hook.name };
  }
  async function current(
    sql: AgentTurnTransaction,
    target: LearningTarget,
    userId: string,
    projectId: string,
  ) {
    const scope = await authorize(sql, target, userId, projectId);
    if (target.kind === "skill") {
      const view = await skills.getLibraryIn(sql, userId, projectId);
      const entry = view.entries.find((item) => item.id === target.id);
      const revision = entry?.revisions[0];
      if (
        !entry ||
        !revision?.published ||
        revision.id !== target.revisionId ||
        revision.revision !== target.version
      )
        throw new CommandError(
          "conflict",
          "This Skill has a newer or unavailable revision. No guidance was overwritten.",
        );
      const choices = view.choices.filter(
        (choice) =>
          choice.libraryId === target.id &&
          choice.scope === scope.scope &&
          choice.revisionId === target.revisionId &&
          (choice.state === "enable" || choice.state === "required"),
      );
      if (!choices.length)
        throw new CommandError(
          "conflict",
          "No owning-scope activation uses this Skill revision. Adopt its version explicitly in Skills.",
        );
      return {
        scope,
        text: revision.content[target.field],
        content: revision.content,
        choices,
        title: null,
      };
    }
    if (target.kind === "knowledge") {
      const [page] = await sql<
        { body: string; title: string; revisionId: string; version: number }[]
      >`
        SELECT current_body AS body,title,current_revision_id AS "revisionId",version::int AS version
        FROM factory.knowledge_page WHERE id=${target.id} AND state='active' FOR UPDATE`;
      if (!page || page.revisionId !== target.revisionId || page.version !== target.version)
        throw new CommandError(
          "conflict",
          "This Knowledge page changed. No newer writing was overwritten.",
        );
      return {
        scope,
        text: page.body,
        content: null,
        choices: [] as LibraryChoice[],
        title: page.title,
      };
    }
    const [hook] = await sql<
      { instructions: string | null; revisionId: string; version: number }[]
    >`
      SELECT policy.instructions,policy.id AS "revisionId",hook.version::int AS version
      FROM factory.monitoring_hook hook JOIN factory.monitoring_policy policy ON policy.id=hook.policy_id
      WHERE hook.id=${target.id} FOR UPDATE OF hook`;
    if (
      !hook ||
      hook.revisionId !== target.revisionId ||
      hook.version !== target.version ||
      !hook.instructions
    )
      throw new CommandError(
        "conflict",
        "This Input policy changed. No newer task was overwritten.",
      );
    return {
      scope,
      text: hook.instructions,
      content: null,
      choices: [] as LibraryChoice[],
      title: null,
    };
  }
  async function write(
    sql: AgentTurnTransaction,
    input: {
      target: LearningTarget;
      userId: string;
      projectId: string;
      revisionId: string;
      text: string;
      loaded: Awaited<ReturnType<typeof current>>;
    },
  ) {
    const { target, loaded } = input;
    if (target.kind === "skill") {
      const content = skillContentInput.parse({ ...loaded.content, [target.field]: input.text });
      if (content[target.field] === loaded.text)
        throw new CommandError("invalid", "The edit does not change saved guidance.");
      await skills.library.saveIn(
        sql,
        {
          libraryId: target.id,
          revisionId: input.revisionId,
          expectedRevision: target.version,
          scope: loaded.scope.scope,
          ...(loaded.scope.scope === "project" ? { projectId: input.projectId } : {}),
          content,
        },
        input.userId,
      );
      for (const choice of loaded.choices)
        await skills.chooseLibraryIn(
          sql,
          {
            libraryId: target.id,
            scope: choice.scope,
            projectId: input.projectId,
            role: choice.role,
            state: choice.state,
            revisionId: input.revisionId,
            expectedVersion: choice.version,
          },
          input.userId,
          input.projectId,
        );
      return {
        revisionId: input.revisionId,
        version: target.version + 1,
        activation: loaded.choices.map((choice) =>
          learningActivation.parse({
            role: choice.role,
            scope: choice.scope,
            state: choice.state,
            beforeVersion: choice.version,
            afterVersion: choice.version + 1,
          }),
        ),
      };
    }
    if (target.kind === "knowledge") {
      if (loaded.title === null)
        throw new CommandError("conflict", "The observed Knowledge title is no longer available");
      const saved = await editKnowledgeIn(
        sql,
        target.id,
        {
          expectedVersion: target.version,
          title: loaded.title,
          body: input.text,
        },
        input.userId,
        false,
        input.revisionId,
      );
      if (saved.revisionId !== input.revisionId)
        throw new CommandError("conflict", "The improvement did not create its exact revision.");
      return {
        revisionId: input.revisionId,
        version: saved.version,
        activation: [] as LearningActivation[],
      };
    }
    const saved = await editInputInstructionsIn(database, sql, {
      hookId: target.id,
      policyId: target.revisionId,
      version: target.version,
      instructions: input.text,
      revisionId: input.revisionId,
      userId: input.userId,
    });
    return { ...saved, activation: [] as LearningActivation[] };
  }
  return {
    authorize,
    current,
    async apply(
      sql: AgentTurnTransaction,
      input: { edit: LearningEdit; userId: string; projectId: string; revisionId: string },
    ) {
      const loaded = await current(sql, input.edit.target, input.userId, input.projectId);
      const text = applyLearningEdit(loaded.text, input.edit);
      return write(sql, { ...input, target: input.edit.target, loaded, text });
    },
    async revert(
      sql: AgentTurnTransaction,
      input: {
        target: LearningTarget;
        appliedRevisionId: string;
        appliedVersion: number;
        activation: LearningActivation[];
        userId: string;
        projectId: string;
        revisionId: string;
      },
    ) {
      const target = {
        ...input.target,
        revisionId: input.appliedRevisionId,
        version: input.appliedVersion,
      };
      const loaded = await current(sql, target, input.userId, input.projectId);
      if (target.kind === "skill") {
        if (
          loaded.choices.length !== input.activation.length ||
          input.activation.some(
            (old) =>
              !loaded.choices.some(
                (choice) =>
                  choice.scope === old.scope &&
                  choice.role === old.role &&
                  choice.state === old.state &&
                  choice.version === old.afterVersion,
              ),
          )
        )
          throw new CommandError(
            "conflict",
            "Skill choices changed after this improvement. Keep the newer choices.",
          );
      }
      let text: string;
      if (target.kind === "skill") {
        const [before] = await sql<
          { content: SkillContent }[]
        >`SELECT content FROM factory.skill_revision WHERE id=${input.target.revisionId}`;
        if (!before)
          throw new CommandError("not-found", "The original Skill revision is unavailable");
        text = skillContentInput.parse(before.content)[target.field];
      } else if (target.kind === "knowledge") {
        const [before] = await sql<
          { body: string }[]
        >`SELECT body FROM factory.knowledge_revision WHERE id=${input.target.revisionId} AND page_id=${target.id}`;
        if (!before)
          throw new CommandError("not-found", "The original Knowledge revision is unavailable");
        text = before.body;
      } else {
        const [before] = await sql<{ instructions: string | null }[]>`
          SELECT instructions FROM factory.monitoring_policy WHERE id=${input.target.revisionId} AND hook_id=${target.id}`;
        if (!before?.instructions)
          throw new CommandError("not-found", "The original Input task is unavailable");
        text = before.instructions;
      }
      return write(sql, { ...input, target, loaded, text });
    },
  };
}
