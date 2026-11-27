import { createHash } from "node:crypto";
import { and, eq, sql as expression } from "drizzle-orm";
import { defaultLibraryCover, libraryCoverInput } from "#conversation-domain/library-covers";
import {
  resolveLibraryChoice,
  skillChoiceInput,
  skillLibrarySaveInput,
  skillScopeInput,
} from "#conversation-domain/skill-library";
import { skillContentInput } from "#conversation-domain/skills";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation, skillLibrary, skillRevision } from "#db/schema";
import { CommandError } from "../command-error";
import {
  initializeLibraryCoverIn,
  libraryCoversIn,
  saveLibraryCoverIn,
} from "../library-covers/api";
import { viewSkillLibraryIn } from "./library-controller-queries";
import {
  authorizeSkillScopeIn,
  listSkillLibrariesIn,
  lockSkillsIn,
  NIL_UUID,
  type SkillLibraryRecord,
  skillCapabilitiesIn,
  writeSkillRevisionIn,
} from "./library-controller-store";

export async function saveSkillIn(sql: DatabaseTransaction, value: unknown, userId: string) {
  const input = skillLibrarySaveInput.parse(value);
  await lockSkillsIn(sql);
  await authorizeSkillScopeIn(sql, userId, input.scope, input.projectId);
  let library = (await listSkillLibrariesIn(sql)).find((item) => item.id === input.libraryId);
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
  await writeSkillRevisionIn(
    sql,
    library,
    input.revisionId,
    input.expectedRevision,
    input.content,
    userId,
  );
  return { libraryId: library.id, revisionId: input.revisionId };
}

export async function saveSkillCoverIn(sql: DatabaseTransaction, value: unknown, userId: string) {
  const input = libraryCoverInput.parse(value);
  await lockSkillsIn(sql);
  const library = (await listSkillLibrariesIn(sql)).find((item) => item.id === input.libraryId);
  if (!library || (library.scope === "personal" && library.ownerId !== userId))
    throw new CommandError("not-found", "Skill not found");
  await authorizeSkillScopeIn(sql, userId, library.scope, library.projectId ?? undefined);
  return saveLibraryCoverIn(sql, "skill", input, userId);
}

export async function chooseSkillIn(sql: DatabaseTransaction, value: unknown, userId: string) {
  const input = skillChoiceInput.parse(value);
  await lockSkillsIn(sql);
  await authorizeSkillScopeIn(sql, userId, input.scope, input.projectId);
  if (input.scope !== "system" && !input.projectId)
    throw new CommandError("conflict", "Select a Project for skill choices");
  if (input.state === "required" && input.scope === "personal")
    throw new CommandError("conflict", "Only managers can require a skill");
  const view = await viewSkillLibraryIn(sql, userId, input.projectId);
  const entry = view.entries.find((item) => item.id === input.libraryId);
  if (
    !entry ||
    (input.scope === "system" && entry.scope !== "system") ||
    (input.scope === "project" && entry.scope === "personal")
  )
    throw new CommandError("not-found", "Skill is unavailable at this scope");
  const parents = view.choices.filter(
    (item) => item.scope !== input.scope && (input.scope === "personal" || item.scope === "system"),
  );
  const required = resolveLibraryChoice(parents, entry.id, input.role);
  if (required?.state === "required")
    throw new CommandError("conflict", "This skill is required by an inherited rule");
  const revisionId = input.revisionId ?? entry.revisions[0]?.id;
  const revision = entry.revisions.find((item) => item.id === revisionId);
  if (!revision?.published || !revision.content.roles.includes(input.role))
    throw new CommandError("conflict", "Select an available version for this role");
  const context = input.scope === "system" ? NIL_UUID : (input.projectId ?? NIL_UUID);
  const owner = input.scope === "personal" ? userId : NIL_UUID;
  const db = drizzleTransaction(sql);
  const choiceKey = `skills.choice:${entry.id}:${input.scope}:${context}:${owner}:${input.role}`;
  const [current] = await db
    .select({
      version: expression<number>`(${operation.payload}->>'version')::bigint::float8`,
    })
    .from(operation)
    .where(and(eq(operation.kind, "skills.choice"), eq(operation.idempotencyKey, choiceKey)));
  if ((current?.version ?? 0) !== input.expectedVersion)
    throw new CommandError("conflict", "Skill choices changed elsewhere. Reload before saving.");
  const payload = {
    libraryId: entry.id,
    scope: input.scope,
    contextId: context,
    userId: owner,
    role: input.role,
    state: input.state,
    revisionId: revision.id,
    version: (current?.version ?? 0) + 1,
  };
  await db
    .insert(operation)
    .values({
      id: crypto.randomUUID(),
      kind: "skills.choice",
      scopeType: input.scope,
      scopeId: context,
      idempotencyKey: choiceKey,
      activeKey: null,
      state: input.state,
      payload,
    })
    .onConflictDoUpdate({
      target: operation.idempotencyKey,
      set: {
        state: input.state,
        payload,
        updatedAt: expression`now()`,
      },
    });
  return { saved: true };
}

export async function proposeSkillSharingIn(
  sql: DatabaseTransaction,
  id: string,
  revisionId: string,
  target: "project" | "system",
  projectId: string | undefined,
  userId: string,
) {
  await lockSkillsIn(sql);
  await skillCapabilitiesIn(sql, userId, projectId);
  if (target === "project" && !projectId)
    throw new CommandError("conflict", "Select a Project to share with");
  const db = drizzleTransaction(sql);
  const [owned] = await db
    .select({ revisionId: skillRevision.id })
    .from(skillRevision)
    .innerJoin(skillLibrary, eq(skillLibrary.id, skillRevision.libraryId))
    .where(and(eq(skillRevision.id, revisionId), eq(skillLibrary.ownerId, userId)));
  if (!owned) throw new CommandError("not-found", "Personal skill version not found");
  const [existing] = await db
    .select({
      kind: operation.kind,
      payload: operation.payload,
    })
    .from(operation)
    .where(eq(operation.id, id));
  if (existing) {
    const payload = existing.payload;
    if (
      existing.kind !== "skills.share_proposal" ||
      payload["revisionId"] !== revisionId ||
      payload["proposedBy"] !== userId ||
      payload["target"] !== target ||
      (payload["projectId"] ?? null) !== (target === "project" ? (projectId ?? null) : null)
    )
      throw new CommandError("conflict", "Sharing identity reused with different input");
    return { id };
  }
  await db
    .insert(operation)
    .values({
      id,
      kind: "skills.share_proposal",
      scopeType: "skill_revision",
      scopeId: revisionId,
      idempotencyKey: `skills.share_proposal:${id}`,
      state: "proposed",
      createdBy: userId,
      payload: {
        revisionId,
        proposedBy: userId,
        target,
        projectId: target === "project" ? (projectId ?? null) : null,
        acceptedLibraryId: null,
      },
    })
    .onConflictDoNothing();
  return { id };
}

export async function acceptSkillSharingIn(
  sql: DatabaseTransaction,
  proposalId: string,
  userId: string,
) {
  await lockSkillsIn(sql);
  const db = drizzleTransaction(sql);
  const [proposalRow] = await db
    .select({
      payload: operation.payload,
      content: skillRevision.content,
      sourceLibraryId: skillRevision.libraryId,
    })
    .from(operation)
    .innerJoin(skillRevision, eq(expression<string>`${skillRevision.id}::text`, operation.scopeId))
    .where(
      and(
        eq(operation.id, proposalId),
        eq(operation.kind, "skills.share_proposal"),
        eq(operation.scopeType, "skill_revision"),
      ),
    );
  if (!proposalRow) throw new CommandError("not-found", "Sharing proposal not found");
  const payload = proposalRow.payload;
  const proposal = {
    revisionId: String(payload["revisionId"]),
    target: payload["target"],
    projectId: (payload["projectId"] as string | null) ?? null,
    accepted: (payload["acceptedLibraryId"] as string | null) ?? null,
    content: proposalRow.content,
    sourceLibraryId: proposalRow.sourceLibraryId,
  };
  const target = skillScopeInput.extract(["system", "project"]).parse(proposal.target);
  await authorizeSkillScopeIn(sql, userId, target, proposal.projectId ?? undefined);
  if (proposal.accepted) return { libraryId: proposal.accepted };
  const library: SkillLibraryRecord = {
    id: proposalId,
    storageKey: `shared-${proposalId}`,
    scope: target,
    ownerId: null,
    projectId: proposal.projectId,
  };
  await db.insert(skillLibrary).values(library);
  const cover = proposal.sourceLibraryId
    ? (await libraryCoversIn(sql, "skill", [proposal.sourceLibraryId])).get(
        proposal.sourceLibraryId,
      )
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
  await writeSkillRevisionIn(
    sql,
    library,
    revisionId,
    0,
    skillContentInput.parse(proposal.content),
    userId,
    proposal.revisionId,
  );
  await db
    .update(operation)
    .set({
      state: "accepted",
      payload: { ...payload, acceptedLibraryId: library.id },
      updatedAt: expression<Date>`now()`,
      completedAt: expression<Date>`now()`,
    })
    .where(eq(operation.id, proposalId));
  return { libraryId: library.id };
}
