import { epicProposalInput } from "#conversation-domain/epic-proposal";

export const epicNonGoalsKey = "epic-proposal:isolated-user:non-goals";
export const correctedHomeCriterion = 'Home displays exactly "Welcome back to Factory."';
export const epicNonGoalsProposal = () =>
  epicProposalInput.parse({
    epic: { title: "Welcome improvements", description: "Clarify the signed-in Home experience." },
    members: [
      {
        key: "welcome",
        title: "Show a welcome message",
        description: "Explain the welcome message on signed-in Home.",
        requirement: {
          summary: "Show the requested welcome message.",
          acceptanceCriteria: ["Home displays the welcome message."],
          nonGoals: [
            "Do not change authentication behavior or routes.",
            "Do not implement or deliver this disposable planning exercise.",
          ],
        },
        dependsOn: [],
      },
      {
        key: "tip",
        title: "Add a dismissible tip",
        description: "Give signed-in users a dismissible welcome tip.",
        requirement: {
          summary: "Allow the user to dismiss the tip.",
          acceptanceCriteria: ["The user can dismiss the tip without leaving Home."],
          nonGoals: [
            "Do not change authentication behavior, routes or dependencies.",
            "Do not implement or deliver this planning exercise.",
          ],
        },
        dependsOn: ["welcome"],
      },
    ],
  });
