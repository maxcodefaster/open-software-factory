import { z } from "zod";
import { requirementContentInput } from "./content";

export const ticketDocumentInput = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    expectedDocumentId: z.uuid().nullable(),
    requirementRevisionId: z.uuid().nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000),
    requirement: requirementContentInput
      .extend({
        summary: z.string().trim().max(10_000),
        acceptanceCriteria: z.array(z.string().trim().max(2_000)).max(100),
        nonGoals: z.array(z.string().trim().max(2_000)).max(100),
      })
      .nullable(),
    proposalEntryId: z.uuid().optional(),
  })
  .strict();
export type TicketDocumentInput = z.infer<typeof ticketDocumentInput>;
export const ticketFollowUpInput = z
  .object({
    commandId: z.uuid(),
    expectedDocumentId: z.uuid().nullable(),
    requirementRevisionId: z.uuid(),
  })
  .strict();
export type TicketFollowUpInput = z.infer<typeof ticketFollowUpInput>;
