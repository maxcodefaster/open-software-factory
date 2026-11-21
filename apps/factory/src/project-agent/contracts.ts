import { z } from "zod";
import {
  conversationModeInput,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import { turnObservationInput } from "../../../../packages/conversation-domain/src/turn-observation";
import { agentMessageSchema } from "../agent/contracts";
import { optionalString } from "../optional-values";

export const conversationEntrySchema = z.object({
  id: z.string(),
  ordinal: z.coerce.number(),
  kind: z.enum([
    "user-message",
    "agent-message",
    "question",
    "answer",
    "requirement",
    "mode-change",
  ]),
  actor: z.enum(["user", "project-agent", "change-agent", "system"]),
  mode: conversationModeInput,
  body: z.string(),
  payload: z.record(z.string(), z.unknown()),
  citations: z.array(sourceCitationInput),
  inReplyToEntryId: optionalString,
  requirementRevisionId: optionalString,
  createdAt: z.string(),
});

export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

export const conversationViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ticketId: optionalString,
  mode: conversationModeInput,
  version: z.coerce.number(),
  contextId: z.uuid().nullable().default(null),
  activeCodingContextId: z.uuid().nullable().default(null),
  isActiveCoding: z.boolean().default(true),
  contexts: z
    .array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["research", "coding"]),
        title: z.string(),
        ordinal: z.number().int().positive(),
        original: z.boolean(),
        createdAt: z.string(),
      }),
    )
    .default([]),
  codingHistory: z
    .object({
      messages: z.array(agentMessageSchema),
      admittedMessages: z.array(agentMessageSchema),
      messagesAvailable: z.boolean(),
      turn: turnObservationInput.nullable(),
    })
    .nullable()
    .default(null),
  entries: z.array(conversationEntrySchema),
  turn: turnObservationInput.optional(),
});

export type ConversationView = z.infer<typeof conversationViewSchema>;

export const conversationStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("admitted"), turnId: z.uuid() }),
  z.object({ type: z.literal("answer"), turnId: z.uuid(), text: z.string().max(12_000) }),
  z.object({ type: z.literal("complete"), conversation: conversationViewSchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export type ConversationStreamEvent = z.infer<typeof conversationStreamEventSchema>;
