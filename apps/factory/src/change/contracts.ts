import type { PullRow } from "@rocicorp/zero";
import { z } from "zod";
import { sourceCitationInput } from "#conversation-domain/conversation";
import { type RequirementContent, requirementContentInput } from "#requirement-domain/content";
import { technicalDesignContentInput } from "#requirement-domain/technical-design";
import type { FactoryZeroSchema } from "#zero-schema";
import { optionalString } from "../optional-values";

export const requirementProposalSchema = z.object({
  id: z.uuid(),
  ticket: z.object({ title: z.string(), description: z.string() }),
  requirement: requirementContentInput,
  fullPlanning: z.boolean().optional(),
  base: z.object({
    version: z.number(),
    documentId: z.uuid().nullable(),
    revisionId: z.uuid().nullable(),
  }),
});

export type RequirementProposal = z.infer<typeof requirementProposalSchema>;

export type TicketEdit = { title: string; description: string };

export type TicketDraft = TicketEdit & {
  requirement: RequirementContent;
  expectedVersion?: number;
  expectedDocumentId?: string | null;
  requirementRevisionId?: string | null;
  proposalEntryId?: string | undefined;
};

export const personalTicketDraftSchema = z.object({
  id: z.uuid(),
  title: z.string().max(200),
  description: z.string().max(10_000),
  stage: z.enum(["inbox", "ready"]).optional(),
  attachmentSequence: z.number().int().nonnegative().optional(),
});
export type PersonalTicketDraft = z.infer<typeof personalTicketDraftSchema>;

export type Ticket = Pick<
  PullRow<"ticket", FactoryZeroSchema>,
  "id" | "projectId" | "epicId" | "title" | "description" | "state" | "version"
> & {
  trashedAt?: string | number | null | undefined;
  trashStopPending?: boolean | null | undefined;
  trashError?: string | null | undefined;
  convertedToEpicId?: string | null | undefined;
};

export const requirementRevisionSchema = z.object({
  id: z.string(),
  ordinal: z.coerce.number(),
  canonicalContent: z.string(),
  contentDigest: z.string(),
  createdAt: z.string().optional(),
  approvalId: optionalString,
  approvedAt: optionalString,
  monitoringIncidentId: optionalString,
  author: optionalString,
  authorKind: z.enum(["human", "ai"]).optional(),
});

export type RequirementRevision = z.infer<typeof requirementRevisionSchema>;

export const ticketDocumentRevisionSchema = requirementRevisionSchema.extend({
  title: z.string(),
  description: z.string(),
  requirementRevisionId: z.uuid().nullable(),
  proposalEntryId: z.uuid().nullable().optional(),
});

export type TicketDocumentRevision = z.infer<typeof ticketDocumentRevisionSchema>;

// Exact base for the next write, independent of delayed read projections.
export const ticketDocumentSaveSchema = z.object({
  id: z.uuid(),
  ticketVersion: z.number().int().positive(),
  requirementRevisionId: z.uuid().nullable(),
});

export type TicketDocumentSave = z.infer<typeof ticketDocumentSaveSchema>;

export const changeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ticketId: z.string(),
  requirementApprovalId: optionalString,
  branchName: z.string(),
  baseSha: z.string(),
  state: z.string(),
  version: z.coerce.number().int().positive().optional(),
  branchState: z.string(),
  branchHeadSha: optionalString,
  runtimeAttemptId: optionalString,
  runtimeState: optionalString,
  verificationState: optionalString,
  buildTurnState: optionalString,
  buildTurnPurpose: optionalString,
  implementationState: optionalString,
  deliveryApprovedAt: optionalString,
  mergeState: optionalString,
  promotionState: optionalString,
  failure: optionalString,
});

export type Change = z.infer<typeof changeSchema>;

export const ticketDetailSchema = z.object({
  implementationOrder: z
    .object({
      commandId: z.uuid(),
      state: z.enum(["waiting", "started", "blocked", "cancelled"]),
      reason: z.string().nullable(),
      canCancel: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  ticket: z.object({
    id: z.string(),
    projectId: z.string(),
    epicId: z.uuid().nullable().default(null),
    convertedToEpicId: z.uuid().nullable().default(null),
    title: z.string(),
    description: z.string(),
    state: z.enum(["inbox", "backlog", "ready", "in-progress", "cancelled", "done"]),
    version: z.coerce.number(),
    trashedAt: optionalString,
    trashStopPending: z.boolean().optional(),
    trashError: optionalString,
  }),
  revisions: z.array(requirementRevisionSchema),
  documentRevisions: z.array(ticketDocumentRevisionSchema).default([]),
  proposal: requirementProposalSchema.nullable().default(null),
  origin: z.object({ id: z.uuid(), title: z.string() }).nullable().default(null),
  followUps: z.array(z.object({ id: z.uuid(), title: z.string() })).default([]),
  technicalDesigns: z
    .array(
      z.object({
        id: z.uuid(),
        ordinal: z.number().int().positive(),
        requirementRevisionId: z.uuid(),
        sourceCommit: z.string(),
        content: technicalDesignContentInput,
        citations: z.array(sourceCitationInput),
        diagramRenders: z.array(z.string().nullable()),
        rendererVersion: z.string(),
        authorKind: z.enum(["human", "ai"]),
        createdAt: z.string(),
        approved: z.boolean(),
      }),
    )
    .optional(),
  technicalDesignPresent: z.boolean().optional(),
  technicalPlanningPending: z.boolean().optional(),
});

export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export type TechnicalDesignRevision = NonNullable<TicketDetail["technicalDesigns"]>[number];

export const changesResponseSchema = z.object({ changes: z.array(changeSchema) });
