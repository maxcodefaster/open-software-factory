import { z } from "zod";

export const inboxItemSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  projectId: z.uuid(),
  projectName: z.string(),
  ticketId: z.uuid().nullable(),
  ticketTitle: z.string(),
  title: z.string(),
  preview: z.string(),
  createdAt: z.string(),
  needsAction: z.boolean(),
  unread: z.boolean(),
  archived: z.boolean(),
  updates: z.number().int().positive(),
  target: z.enum(["ticket", "conversation", "coding", "review", "inputs"]),
  targetId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .nullable(),
  contextId: z.uuid().nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxViewSchema = z.object({
  items: z.array(inboxItemSchema),
  count: z.number().int().nonnegative(),
});
export type InboxView = z.infer<typeof inboxViewSchema>;
export const attentionPersonSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  develop: z.boolean(),
  manage: z.boolean(),
});
export type AttentionPerson = z.infer<typeof attentionPersonSchema>;
export const ticketAttentionSchema = z.object({
  responsibleId: z.uuid().nullable(),
  version: z.number().int().nonnegative(),
  following: z.boolean(),
  people: z.array(attentionPersonSchema),
});
export type TicketAttention = z.infer<typeof ticketAttentionSchema>;
export const responsibilityInput = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    responsibleId: z.uuid().nullable(),
  })
  .strict();
export const inboxReceiptInput = z
  .object({
    itemId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    action: z.enum(["read", "unread", "archive"]),
  })
  .strict();
