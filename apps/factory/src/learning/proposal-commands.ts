import { and, eq, isNotNull, sql as typedSQL } from "drizzle-orm";
import { z } from "zod";
import {
  learningCase,
  learningDecisionCommand,
  learningProposal,
  learningRollbackCommand,
  learningTarget,
  validateLearningResult,
} from "#conversation-domain/learning";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { learningProposal as proposalRecord, ticketConversation } from "#db/schema";
import { canonicalRequirementContent, requirementDigest } from "#requirement-domain/requirement";
import { insertInitialTicketIn } from "#ticket-authoring/authoring";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { learningAuthorityIn } from "./authority";
import {
  advisoryLock,
  type LearningDatabase,
  type LearningTargets,
  lockProposalWithReview,
  recordLearningCommand,
  replayLearningCommand,
} from "./command-ledger";
import { learningActivation, learningEditDigest } from "./targets";

type DecisionInput = typeof learningDecisionCommand._output;
type ProposalContent = typeof learningProposal._output;

async function applyProposalEdit(
  sql: DatabaseTransaction,
  db: ReturnType<typeof drizzleTransaction>,
  targets: LearningTargets,
  proposal: { projectId: string; ownerId: string | null; cases: unknown },
  content: ProposalContent,
  scope: { scope: "personal" | "project" | "system"; label: string } | null,
  input: DecisionInput,
  userId: string,
) {
  if (!content.edit || !scope || input.editDigest !== learningEditDigest(content.edit))
    throw new CommandError("conflict", "Confirm the exact proposed edit before applying it.");
  if (proposal.ownerId && scope.scope !== "personal" && !input.releasePrivate)
    throw new CommandError(
      "forbidden",
      "Explicitly release this exact private edit before changing shared guidance.",
    );
  const cases = z.array(learningCase).parse(proposal.cases);
  validateLearningResult(
    {
      cases: cases.map((item) => ({
        caseId: item.id,
        fulfillment: "unknown",
        rework: "unknown",
        verification: "unknown",
        explanation: "Checking the proposed edit against retained evidence.",
        evidenceIds: [],
      })),
      findings: [],
      proposals: [content],
    },
    cases,
  );
  const [reverted] = await db
    .select({ id: proposalRecord.id })
    .from(proposalRecord)
    .where(
      and(
        isNotNull(proposalRecord.application),
        eq(typedSQL<string>`${proposalRecord.application}->>'state'`, "reverted"),
        eq(
          typedSQL<string>`${proposalRecord.application}->'target'->>'kind'`,
          content.edit.target.kind,
        ),
        eq(
          typedSQL<string>`${proposalRecord.application}->'target'->>'id'`,
          content.edit.target.id,
        ),
        eq(
          typedSQL<string>`${proposalRecord.application}->'target'->>'field'`,
          content.edit.target.field,
        ),
        eq(typedSQL<string>`${proposalRecord.content}->'edit'->>'after'`, content.edit.after),
      ),
    )
    .limit(1);
  if (reverted)
    throw new CommandError(
      "conflict",
      "This edit was already rolled back. Reassess its cause rather than applying it again.",
    );
  const id = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const saved = await targets.apply(sql, {
    edit: content.edit,
    userId,
    projectId: proposal.projectId,
    revisionId,
  });
  await db
    .update(proposalRecord)
    .set({
      state: "applied",
      decisionId: input.commandId,
      decidedBy: userId,
      decidedAt: typedSQL`now()`,
      application: {
        id,
        proposalId: input.proposalId,
        target: content.edit.target,
        editDigest: input.editDigest,
        activation: saved.activation,
        appliedRevisionId: saved.revisionId,
        appliedVersion: saved.version,
        appliedBy: userId,
        comparisonId: null,
        createdAt: new Date().toISOString(),
        state: "applied",
        revertedRevisionId: null,
        revertedVersion: null,
        revertedBy: null,
        revertedComparisonId: null,
        revertedAt: null,
      },
    })
    .where(eq(proposalRecord.id, input.proposalId));
  const result = { applicationId: id, revisionId: saved.revisionId };
  await recordLearningCommand(db, input.commandId, proposal.projectId, userId, input, result);
  return result;
}

async function createProposalTicket(
  db: ReturnType<typeof drizzleTransaction>,
  projectId: string,
  content: ProposalContent,
  userId: string,
) {
  const ticketId = crypto.randomUUID();
  // Only this explicitly displayed proposal is shared, not its private
  // source packet, transcript, findings or personal configuration.
  const description = `AI work-review proposal. No implementation or Delivery is approved.\n\n${content.change}\n\nExpected effect\n${content.expectedEffect}\n\nValidation\n${content.validation}${
    content.edit
      ? `\n\nExact Settings edit request. Review it in the owning settings; this is not a repository implementation task.\nTarget ${JSON.stringify(content.edit.target)}\n\nBefore\n${content.edit.before}\n\nAfter\n${content.edit.after}`
      : ""
  }`;
  const canonical = canonicalRequirementContent({
    summary: content.change,
    acceptanceCriteria: [content.validation],
    nonGoals: [
      "Do not weaken security, confirmed requirements, independent review or protected Verification gates.",
      "Keep .forgejo/workflows/factory-verification.yml unchanged. Optimize project checks, tests or auxiliary CI instead.",
    ],
  });
  await insertInitialTicketIn(db, {
    id: ticketId,
    projectId,
    title: content.title,
    description,
    state: "ready",
    createdBy: userId,
    authoring: {
      requirement: { id: crypto.randomUUID(), canonicalContent: canonical },
      document: {
        id: crypto.randomUUID(),
        inputDigest: requirementDigest(canonical),
        authorKind: "ai",
      },
    },
  });
  await db.insert(ticketConversation).values({
    id: crypto.randomUUID(),
    projectId,
    ticketId,
    mode: "plan",
    createdBy: userId,
  });
  return ticketId;
}

export async function decideLearningProposal(
  database: LearningDatabase,
  targets: LearningTargets,
  userId: string,
  raw: unknown,
) {
  const input = learningDecisionCommand.parse(raw);
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const proposal = await lockProposalWithReview(db, (row) => eq(row.id, input.proposalId));
    if (!proposal) throw new CommandError("not-found", "Improvement not found");
    const content = learningProposal.parse(proposal.content);
    if (input.decision === "apply" && content.edit?.target.kind === "skill")
      await advisoryLock(db, "factory-skills");
    await learningAuthorityIn(sql, userId, proposal);
    if (!proposal.ownerId && input.decision !== "apply")
      await projectAuthorityIn(sql, userId, proposal.projectId, true);
    const scope =
      input.decision === "apply" && content.edit
        ? await targets.authorize(sql, content.edit.target, userId, proposal.projectId)
        : null;
    const existing = await replayLearningCommand(sql, input.commandId, userId, input);
    if (existing) return existing.result;
    if (proposal.state !== "proposed")
      throw new CommandError("conflict", "This improvement already has a decision");
    if (proposal.ownerId && input.decision === "create-ticket" && !input.releasePrivate)
      throw new CommandError(
        "forbidden",
        "Explicitly share the displayed private proposal before creating a shared Ticket",
      );
    if (
      input.decision === "create-ticket" &&
      content.edit &&
      input.editDigest !== learningEditDigest(content.edit)
    )
      throw new CommandError(
        "conflict",
        "Confirm the exact proposed edit before sharing it as a Ticket.",
      );
    if (input.decision === "apply")
      return applyProposalEdit(sql, db, targets, proposal, content, scope, input, userId);
    const ticketId =
      input.decision === "create-ticket"
        ? await createProposalTicket(db, proposal.projectId, content, userId)
        : null;
    await db
      .update(proposalRecord)
      .set({
        state: ticketId ? "ticket-created" : "dismissed",
        decisionId: input.commandId,
        decidedBy: userId,
        decidedAt: typedSQL`now()`,
        ticketId,
      })
      .where(eq(proposalRecord.id, input.proposalId));
    const result = { ticketId };
    await recordLearningCommand(db, input.commandId, proposal.projectId, userId, input, result);
    return result;
  });
}

export async function rollbackLearningApplication(
  database: LearningDatabase,
  targets: LearningTargets,
  userId: string,
  raw: unknown,
) {
  const input = learningRollbackCommand.parse(raw);
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const source = await lockProposalWithReview(db, (row) =>
      and(
        isNotNull(row.application),
        eq(typedSQL<string>`${row.application}->>'id'`, input.applicationId),
      ),
    );
    if (!source?.application) throw new CommandError("not-found", "Applied improvement not found");
    const application = source.application;
    const target = learningTarget.parse(application.target);
    if (target.kind === "skill") await advisoryLock(db, "factory-skills");
    await learningAuthorityIn(sql, userId, source);
    await targets.authorize(sql, target, userId, source.projectId);
    const old = await replayLearningCommand(sql, input.commandId, userId, input);
    if (old) return old.result;
    if (
      application.state !== "applied" ||
      application.appliedRevisionId !== input.expectedRevisionId
    )
      throw new CommandError("conflict", "This is not the current applied improvement.");
    const saved = await targets.revert(sql, {
      target,
      appliedRevisionId: application.appliedRevisionId,
      appliedVersion: application.appliedVersion,
      activation: z.array(learningActivation).parse(application.activation),
      userId,
      projectId: source.projectId,
      revisionId: crypto.randomUUID(),
    });
    await db
      .update(proposalRecord)
      .set({
        application: {
          ...application,
          state: "reverted",
          revertedRevisionId: saved.revisionId,
          revertedVersion: saved.version,
          revertedBy: userId,
          revertedAt: new Date().toISOString(),
        },
      })
      .where(eq(proposalRecord.id, source.proposalId));
    const result = { revisionId: saved.revisionId, version: saved.version };
    await recordLearningCommand(db, input.commandId, source.projectId, userId, input, result);
    return result;
  });
}
