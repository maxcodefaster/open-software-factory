import { z } from "zod";
import { turnObservationInput } from "#conversation-domain/turn-observation";

export type ActivityEvent<T> = { type: "snapshot"; view: T } | { type: "heartbeat" };

import { optionalString } from "../optional-values";

export const agentMessageSchema = z.object({
  id: z.string(),
  commandId: z.uuid().optional(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  at: z.number(),
  truncated: z.boolean().optional(),
  activity: z
    .object({
      name: z.string(),
      status: z.enum(["pending", "streaming", "running", "completed", "error"]),
      detail: optionalString,
      truncated: z.boolean().optional(),
      navigation: z
        .object({
          path: z.string().min(1).max(1000),
          diff: z.string().max(64_000).optional(),
          truncated: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type AgentMessage = z.infer<typeof agentMessageSchema>;

const writerPersonSchema = z.object({ id: z.uuid(), name: z.string() });

export const writerViewSchema = z.object({
  state: z.enum(["unassigned", "human", "agent-preparing", "agent", "handoff"]),
  epoch: z.number().int().positive(),
  canWrite: z.boolean(),
  stopPending: z.boolean().optional(),
  yours: z.boolean(),
  commandID: z.uuid().nullable(),
  actor: z
    .object({
      kind: z.enum(["human", "agent"]),
      user: writerPersonSchema.nullable(),
      delegated: z.boolean(),
      workState: z.string().nullable(),
    })
    .nullable(),
  requester: writerPersonSchema.nullable(),
  presence: z
    .object({
      idle: z.boolean(),
      secondsSinceEdit: z.number().int().nonnegative().nullable(),
      connected: z.boolean(),
    })
    .nullable()
    .default(null),
  handoffKind: z.enum(["takeover", "release"]).default("takeover"),
  requests: z
    .array(
      z.object({
        id: z.uuid(),
        requester: writerPersonSchema,
        epoch: z.number().int().positive(),
      }),
    )
    .default([]),
});

export type WriterView = z.infer<typeof writerViewSchema>;

export const agentViewSchema = z.object({
  computeWait: optionalString,
  transcriptArchive: z
    .object({
      latest: z
        .object({
          turnID: z.uuid(),
          state: z.enum(["pending", "failed", "saved"]),
          attempts: z.number().int().nonnegative(),
          lastError: z.string().max(2000).nullable(),
        })
        .nullable(),
      lastSaved: z
        .object({
          turnID: z.uuid(),
          sessionID: z.string().max(200),
          runtimeAttemptID: z.uuid(),
          savedAt: z.string(),
          throughMessageID: z.string(),
        })
        .nullable(),
      recovery: z.string().max(2000),
    })
    .optional(),
  codingPause: z.object({ reason: z.string(), turnID: z.uuid() }).nullable().optional(),
  state: z.enum(["idle", "starting", "working", "waiting", "stopped", "failed", "committed"]),
  runtimeState: optionalString,
  lastError: optionalString,
  commitSHA: optionalString,
  commitOperation: z
    .object({
      id: z.uuid(),
      state: z.enum(["commit-intended", "committed", "push-intended"]),
      lastError: optionalString,
    })
    .optional(),
  messages: z.array(agentMessageSchema),
  admittedMessages: z.array(agentMessageSchema.extend({ role: z.literal("user") })).optional(),
  messagesAvailable: z.boolean(),
  sessionAvailable: z.boolean(),
  runtimeConnected: z.boolean(),
  stopPending: z.boolean(),
  stopId: z.uuid().nullable(),
  turn: turnObservationInput.optional(),
});

export type AgentView = z.infer<typeof agentViewSchema>;
