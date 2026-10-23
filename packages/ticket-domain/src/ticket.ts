import { z } from "zod";

export const ticketStates = [
  "inbox",
  "backlog",
  "ready",
  "in-progress",
  "cancelled",
  "done",
] as const;
export type TicketState = (typeof ticketStates)[number];

export const createTicketInput = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(""),
    state: z.enum(["inbox", "ready"]).optional(),
  })
  .strict();

export const updateTicketInput = z
  .object({
    projectId: z.uuid(),
    ticketId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: "A Ticket update must change a planning field",
  });

export const moveTicketInput = z
  .object({
    projectId: z.uuid(),
    ticketId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    state: z.enum(["inbox", "backlog", "ready", "cancelled"]),
  })
  .strict();

export function canPlanTicket(current: TicketState, next: TicketState) {
  if (current === "in-progress") return false;
  if (current === "cancelled") return next === "inbox";
  return next !== "in-progress";
}
