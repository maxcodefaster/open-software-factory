import { createHash } from "node:crypto";
import { and, eq, sql as typedSQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  applyLearningEdit,
  type LearningEdit,
  type LearningTarget,
  learningEdit,
} from "#conversation-domain/learning";
import type { LibraryChoice } from "#conversation-domain/skill-library";
import { skillContentInput } from "#conversation-domain/skills";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  administrator,
  knowledgePage,
  knowledgeRevision,
  monitoringHook,
  monitoringPolicy,
  skillLibrary,
  skillRevision,
} from "#db/schema";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";
import { editKnowledgeIn } from "../knowledge/edit";
import { manageMonitoringIn } from "../monitoring/authority";
import { editInputInstructionsIn } from "../monitoring/instructions";
import { createSkillController } from "../skills/api";

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
    sql: DatabaseTransaction,
    target: LearningTarget,
    userId: string,
    projectId: string,
  ): Promise<Scope> {
    const db = drizzleTransaction(sql);
    await projectAuthorityIn(sql, userId, projectId);
    if (target.kind === "skill") {
      const [entry] = await db
        .select({
          scope: skillLibrary.scope,
          ownerId: skillLibrary.ownerId,
          projectId: skillLibrary.projectId,
          label: typedSQL<string>`${skillRevision.content}->>'name'`,
        })
        .from(skillLibrary)
        .innerJoin(
          skillRevision,
          and(
            eq(skillRevision.libraryId, skillLibrary.id),
            eq(skillRevision.id, target.revisionId),
          ),
        )
        .where(eq(skillLibrary.id, target.id));
      if (
        !entry ||
        (entry.scope === "personal" && entry.ownerId !== userId) ||
        (entry.scope === "project" && entry.projectId !== projectId)
      )
        throw new CommandError("not-found", "Improvement target not found");
      if (entry.scope === "system") {
        await requireActiveAccountIn(sql, userId);
        const [admin] = await db
          .select({ userId: administrator.userId })
          .from(administrator)
          .where(eq(administrator.userId, userId))
          .for("share");
        if (!admin)
          throw new CommandError(
            "forbidden",
            "Factory administrator access is required to change this inherited Skill.",
          );
      }
      if (entry.scope === "project") await projectAuthorityIn(sql, userId, projectId, true);
      return {
        scope: z.enum(["personal", "project", "system"]).parse(entry.scope),
        ownerId: entry.ownerId,
        label: entry.label,
      };
    }
    if (target.kind === "knowledge") {
      const [page] = await db
        .select({ title: knowledgePage.title })
        .from(knowledgePage)
        .where(
          and(
            eq(knowledgePage.id, target.id),
            eq(knowledgePage.projectId, projectId),
            eq(knowledgePage.state, "active"),
          ),
        );
      if (!page) throw new CommandError("not-found", "Improvement target not found");
      return { scope: "project", ownerId: null, label: page.title };
    }
    const [hook] = await db
      .select({ delegation: monitoringPolicy.delegation, name: monitoringHook.name })
      .from(monitoringHook)
      .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, monitoringHook.policyId))
      .where(and(eq(monitoringHook.id, target.id), eq(monitoringHook.projectId, projectId)));
    if (!hook) throw new CommandError("not-found", "Improvement target not found");
    await manageMonitoringIn(
      sql,
      userId,
      projectId,
      z.enum(["prepare-ticket", "application-fix-and-delivery"]).parse(hook.delegation),
    );
    return { scope: "project", ownerId: null, label: hook.name };
  }
  async function current(
    sql: DatabaseTransaction,
    target: LearningTarget,
    userId: string,
    projectId: string,
  ) {
    const db = drizzleTransaction(sql);
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
      const [page] = await db
        .select({
          body: knowledgePage.currentBody,
          title: knowledgePage.title,
          revisionId: knowledgePage.currentRevisionId,
          version: knowledgePage.version,
        })
        .from(knowledgePage)
        .where(and(eq(knowledgePage.id, target.id), eq(knowledgePage.state, "active")))
        .for("update");
      if (!page || page.revisionId !== target.revisionId || page.version !== target.version)
        throw new CommandError(
          "conflict",
          "This Wiki page changed. No newer writing was overwritten.",
        );
      return {
        scope,
        text: page.body,
        content: null,
        choices: [] as LibraryChoice[],
        title: page.title,
      };
    }
    const hookRecord = alias(monitoringHook, "hook");
    const [hook] = await db
      .select({
        instructions: monitoringPolicy.instructions,
        revisionId: monitoringPolicy.id,
        version: hookRecord.version,
      })
      .from(hookRecord)
      .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, hookRecord.policyId))
      .where(eq(hookRecord.id, target.id))
      .for("update", { of: hookRecord });
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
    sql: DatabaseTransaction,
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
        throw new CommandError("conflict", "The observed Wiki title is no longer available");
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
      sql: DatabaseTransaction,
      input: { edit: LearningEdit; userId: string; projectId: string; revisionId: string },
    ) {
      const loaded = await current(sql, input.edit.target, input.userId, input.projectId);
      const text = applyLearningEdit(loaded.text, input.edit);
      return write(sql, { ...input, target: input.edit.target, loaded, text });
    },
    async revert(
      sql: DatabaseTransaction,
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
      const db = drizzleTransaction(sql);
      if (target.kind === "skill") {
        const [before] = await db
          .select({ content: skillRevision.content })
          .from(skillRevision)
          .where(eq(skillRevision.id, input.target.revisionId));
        if (!before)
          throw new CommandError("not-found", "The original Skill revision is unavailable");
        text = skillContentInput.parse(before.content)[target.field];
      } else if (target.kind === "knowledge") {
        const [before] = await db
          .select({ body: knowledgeRevision.body })
          .from(knowledgeRevision)
          .where(
            and(
              eq(knowledgeRevision.id, input.target.revisionId),
              eq(knowledgeRevision.pageId, target.id),
            ),
          );
        if (!before)
          throw new CommandError("not-found", "The original Wiki revision is unavailable");
        text = before.body;
      } else {
        const [before] = await db
          .select({ instructions: monitoringPolicy.instructions })
          .from(monitoringPolicy)
          .where(
            and(
              eq(monitoringPolicy.id, input.target.revisionId),
              eq(monitoringPolicy.hookId, target.id),
            ),
          );
        if (!before?.instructions)
          throw new CommandError("not-found", "The original Input task is unavailable");
        text = before.instructions;
      }
      return write(sql, { ...input, target, loaded, text });
    },
  };
}
