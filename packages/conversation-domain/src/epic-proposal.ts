import { z } from "zod";
import { requirementContentInput } from "../../requirement-domain/src/content";

const workText = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10000).default(""),
  })
  .strict();
export const epicProposalInput = z
  .object({
    epic: workText,
    members: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
            existingTicketId: z.uuid().nullable().default(null),
            expectedVersion: z.number().int().positive().nullable().default(null),
            ...workText.shape,
            requirement: requirementContentInput,
            dependsOn: z
              .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
              .max(12)
              .default([]),
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict()
  .superRefine((proposal, context) => {
    const members = new Map(proposal.members.map((member) => [member.key, member]));
    if (members.size !== proposal.members.length)
      context.addIssue({ code: "custom", message: "Member keys must be unique" });
    const reused = new Set<string>();
    for (const member of proposal.members) {
      if (Boolean(member.existingTicketId) !== Boolean(member.expectedVersion))
        context.addIssue({
          code: "custom",
          message: "Reused Tickets require their observed version",
        });
      if (member.existingTicketId && reused.has(member.existingTicketId))
        context.addIssue({ code: "custom", message: "Reuse each Ticket once" });
      if (member.existingTicketId) reused.add(member.existingTicketId);
      const visited = new Set<string>();
      function walk(key: string): boolean {
        if (key === member.key) return true;
        if (visited.has(key)) return false;
        visited.add(key);
        return members.get(key)?.dependsOn.some(walk) ?? false;
      }
      if (member.dependsOn.some((key) => !members.has(key) || walk(key)))
        context.addIssue({
          code: "custom",
          message: "Dependencies must name members and cannot cycle",
        });
    }
  });
export type EpicProposal = z.infer<typeof epicProposalInput>;
export const confirmEpicProposalInput = z
  .object({ commandId: z.uuid(), proposal: epicProposalInput })
  .strict();
