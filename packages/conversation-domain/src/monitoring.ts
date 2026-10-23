import { z } from "zod";

export const defaultInputInstructions =
  "Understand incoming requests for this Project. Consult the connected sources and relevant Project knowledge, check existing Tickets, and prepare a clear Ticket with grounded requirements and testable acceptance criteria. Do not invent missing context or start implementation.";
export const defaultAutofixInstructions =
  "Investigate incoming application errors. Verify the reported incident against the connected sources and application code, then prepare a minimal regression fix. Do not turn operational alerts into code changes.";
export const inputInstructions = z.string().trim().min(1).max(6000);
export const inputDelegation = z.enum(["prepare-ticket", "application-fix-and-delivery"]);

export const monitoringSave = z
  .object({
    commandId: z.uuid(),
    id: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(100),
    instructions: inputInstructions.default(defaultInputInstructions),
    connectionIds: z
      .array(z.uuid())
      .max(12)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
    enabled: z.boolean(),
    delegation: inputDelegation.default("prepare-ticket"),
  })
  .strict();

export const monitoringChange = z
  .object({ commandId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();

export const monitoringIncidentState = z.enum([
  "queued",
  "diagnosing",
  "insufficient-context",
  "not-application-defect",
  "prepared",
  "implementing",
  "delivered",
  "blocked",
  "uncertain",
]);

export const monitoringView = z.object({
  canManage: z.boolean(),
  canDelegate: z.boolean(),
  canDisable: z.boolean(),
  hooks: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      version: z.number(),
      enabled: z.boolean(),
      instructions: inputInstructions,
      connectionIds: z.array(z.uuid()),
      sourceIds: z.array(z.uuid()),
      delegation: inputDelegation,
      delegatedBy: z.uuid(),
      policyId: z.uuid(),
      delegationCurrent: z.boolean(),
    }),
  ),
  incidents: z.array(
    z.object({
      id: z.uuid(),
      hookId: z.uuid(),
      title: z.string(),
      state: monitoringIncidentState,
      occurrences: z.number(),
      reason: z.string().nullable(),
      ticketId: z.uuid().nullable(),
      receivedAt: z.string(),
      lastSeenAt: z.string(),
    }),
  ),
});

export const monitoringReceipt = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
});
