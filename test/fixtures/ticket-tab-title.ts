import { ticketDetailSchema } from "../../apps/factory/src/change/contracts";

export const titleProjectID = "10000000-0000-4000-8000-000000000001";
export const titleTicketID = "10000000-0000-4000-8000-000000000002";
export const otherTitleTicketID = "10000000-0000-4000-8000-000000000003";
export const otherTitleProjectID = "10000000-0000-4000-8000-000000000004";
export const originalTitle = "Home welcome tip · planning acceptance 39d";
export const savedTitle = "Show a dismissible welcome tip on signed-in Home";
export const titleRequirement = {
  summary: "Show a welcome tip on signed-in Home.",
  acceptanceCriteria: ["The signed-in user can dismiss the tip."],
  nonGoals: [],
};

export function titleDetail(
  title = originalTitle,
  version = 1,
  id = titleTicketID,
  projectId = titleProjectID,
) {
  return ticketDetailSchema.parse({
    ticket: {
      id,
      projectId,
      title,
      version,
      description: "A dismissible welcome tip.",
      state: "ready",
    },
    revisions: [],
  });
}
