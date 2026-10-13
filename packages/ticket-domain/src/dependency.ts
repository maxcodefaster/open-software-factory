import { z } from "zod";

export const ticketDependencyInput = z
  .object({
    projectId: z.uuid(),
    ticketId: z.uuid(),
    prerequisiteId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.ticketId !== value.prerequisiteId, "A Ticket cannot depend on itself");

export type TicketDependency = { ticketId: string; prerequisiteId: string };

export type PrerequisiteView = {
  id: string;
  title: string;
  state: "inbox" | "backlog" | "ready" | "in-progress" | "cancelled" | "done";
  delivered: boolean;
};

export function prerequisiteIsDelivered(input: {
  ticketState: string;
  changeState?: string | undefined;
  verificationState?: string | undefined;
  mergeState?: string | undefined;
  promotionState?: string | undefined;
}) {
  return (
    input.ticketState === "done" &&
    input.changeState === "delivered" &&
    input.verificationState === "succeeded" &&
    input.mergeState === "succeeded" &&
    input.promotionState === "succeeded"
  );
}

export function dependencyWouldCycle(
  dependencies: readonly TicketDependency[],
  ticketId: string,
  prerequisiteId: string,
) {
  const prerequisites = new Map<string, string[]>();
  for (const edge of dependencies) {
    prerequisites.set(edge.ticketId, [
      ...(prerequisites.get(edge.ticketId) ?? []),
      edge.prerequisiteId,
    ]);
  }
  const visited = new Set<string>();
  const remaining = [prerequisiteId];
  while (remaining.length) {
    const current = remaining.pop();
    if (current === ticketId) return true;
    if (!current || visited.has(current)) continue;
    visited.add(current);
    remaining.push(...(prerequisites.get(current) ?? []));
  }
  return false;
}
