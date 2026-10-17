import { expect, test } from "bun:test";
import type { ProjectAgentOutput } from "../../../../packages/conversation-domain/src/conversation";
import { createDatabase } from "../../../../packages/db/src/client";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { requirementsInterviewSkill } from "../skills/reviewed";
import { generateProjectResponse, projectModelConnection } from "./adapter";
import type { ConversationEntry } from "./conversation-store";
import {
  verifyExportPrerequisite,
  verifyProfilePlacement,
  verifyReadOnlyProfile,
} from "../../../../test/support/project-agent-quality";

// Explicit opt-in. Controlled source facts, real admitted provider configuration,
// no mutations to retained Tickets, no LLM grader and no automatic paid retries.
// FACTORY_AGENT_QUALITY_LIVE=1 bun test .../quality.test.ts
const live = process.env["FACTORY_AGENT_QUALITY_LIVE"] === "1";
function entry(ordinal: number, values: Partial<ConversationEntry>): ConversationEntry {
  return {
    id: crypto.randomUUID(),
    ordinal,
    kind: "user-message",
    actor: "user",
    mode: "plan",
    body: "",
    payload: {},
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdAt: "2026-10-13T00:00:00Z",
    ...values,
  };
}
const ticketID = crypto.randomUUID();
const prerequisiteID = crypto.randomUUID();
const scope =
  "Show the signed-in user's name and email read-only on the existing protected home page. Keep existing sign-out and authentication unchanged. No editing, new fields or new routes. The result is visible only to the signed-in user. The fields already exist. Confirmed acceptance: existing name/email render; no editing controls; sign-out still works. Write the final Ticket requirements now in English; no consequential decision is missing.";
const oldQuestion = entry(1, {
  kind: "question",
  actor: "project-agent",
  body: "How should data be presented?",
  payload: {
    question: {
      type: "single-select",
      prompt: "How should data be presented?",
      allowCustom: true,
      options: [
        { id: "a", label: "A", description: "Read-only display; never expose editing controls" },
        { id: "b", label: "B", description: "Editable profile" },
      ],
    },
  },
});
const cases: Array<{
  name: string;
  prompt: string;
  history: ConversationEntry[];
  research?: boolean;
  dependencies?: boolean;
  verify(output: ProjectAgentOutput): void;
}> = [
  {
    name: "one relevant question for unresolved placement",
    prompt:
      "Show the signed-in user's existing name and email read-only, with authentication and sign-out unchanged. These decisions are settled. The only unresolved decision is whether the summary belongs on the protected home page or in the existing account menu. Ask exactly one single-select question about that placement, with meaningful descriptions and a custom answer option. Do not ask about editing or new fields.",
    history: [],
    verify(output) {
      verifyProfilePlacement(output);
    },
  },
  {
    name: "read-only scope without redundant questions",
    prompt: scope,
    history: [],
    verify(output) {
      verifyReadOnlyProfile(output);
    },
  },
  {
    name: "option meanings and settled answers after 24 entries",
    prompt: scope,
    history: [
      oldQuestion,
      entry(2, {
        kind: "answer",
        body: "A",
        inReplyToEntryId: oldQuestion.id,
        payload: { selectedOptionIds: ["a"], customText: "" },
      }),
      ...Array.from({ length: 26 }, (_, i) =>
        entry(i + 3, { kind: "agent-message", actor: "project-agent", body: "Acknowledged." }),
      ),
    ],
    verify(output) {
      verifyReadOnlyProfile(output);
    },
  },
  {
    name: "correction replaces advisory proposal, not human scope",
    prompt: `Correction: discard the prior proposal to edit passwords. ${scope}`,
    history: [
      entry(1, {
        kind: "requirement",
        actor: "project-agent",
        body: "Prior draft",
        payload: {
          ticket: { title: "Edit passwords", description: "Allow password changes" },
          requirement: {
            summary: "Edit passwords",
            acceptanceCriteria: ["Save changed passwords"],
            nonGoals: [],
          },
        },
      }),
    ],
    verify(output) {
      verifyReadOnlyProfile(output);
      if (output.kind === "requirement")
        expect(output.requirement.acceptanceCriteria.join(" ")).not.toMatch(
          /save.*password|edit.*password/i,
        );
    },
  },
  {
    name: "directed relationships resolve prerequisite before dependent",
    prompt:
      "Which must finish first, Prepare export or Deliver export, and why? Use the actual Ticket dependency, not guess from the titles. Answer in English.",
    history: [],
    research: true,
    dependencies: true,
    verify(output) {
      verifyExportPrerequisite(output, ticketID);
    },
  },
  {
    name: "paused Interview research stays informational",
    prompt: "Where do release notes live? Answer only, keep my unfinished Interview intact.",
    history: [oldQuestion],
    research: true,
    verify(output) {
      expect(output.kind).toBe("answer");
      expect(output.message).toContain("[^1]");
      expect(output.citations.some((citation) => citation.id === ticketID)).toBe(true);
    },
  },
];

for (const scenario of cases)
  test.skipIf(!live)(
    `native semantic quality: ${scenario.name}`,
    async () => {
      const database = createDatabase(1);
      const connections = createModelConnections(
        database,
        createOpenBaoModelSecrets(),
        process.env["FACTORY_AUTH_SECRET"] ?? "local-development-secret-change-before-production",
        process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]?.split(",").filter(Boolean) ?? [],
      );
      try {
        const defaults = await createModelSettingsController(database).get();
        const reference = await database.client.begin((sql) =>
          connections.reference("planning", sql),
        );
        const connection = reference
          ? await connections.resolve(reference.connectionID, reference.version)
          : projectModelConnection();
        let providerRounds = 0,
          firstFeedbackMs: number | null = null;
        const readSources = new Set<string>();
        const start = performance.now();
        const current = entry(100, {
          body: scenario.prompt,
          payload: { projectContext: { project: { id: crypto.randomUUID() } } },
        });
        const output = await generateProjectResponse({
          mode: scenario.research ? "investigate" : "plan",
          requirementsInterview: !scenario.research,
          modelId: defaults.planningModelId,
          connection,
          prompt: scenario.prompt,
          inputEntryId: current.id,
          history: [...scenario.history, current],
          signal: AbortSignal.timeout(60_000),
          skills: [
            {
              id: crypto.randomUUID(),
              revision: 1,
              digest: "a".repeat(64),
              published: true,
              content: requirementsInterviewSkill,
            },
          ],
          progress: (value) => {
            if (value.completedLookups && firstFeedbackMs === null)
              firstFeedbackMs = Math.round(performance.now() - start);
          },
          usageSink: {
            begin: async () => {},
            record: async (value) => {
              if (value.source === "step") providerRounds++;
            },
            settle: async () => {},
          },
          research: {
            search: async () =>
              scenario.dependencies
                ? [
                    {
                      source: "ticket",
                      id: ticketID,
                      label: "Deliver export",
                      excerpt: "Delivery step for the export feature",
                    },
                  ]
                : [
                    {
                      source: "knowledge",
                      id: ticketID,
                      label: "Release guide",
                      excerpt: "Release notes live in Project overview.",
                    },
                  ],
            read: async (source, id) => {
              readSources.add(id);
              if (scenario.dependencies) {
                expect<string[]>([ticketID, prerequisiteID]).toContain(id);
                return {
                  source,
                  id,
                  label: id === ticketID ? "Deliver export" : "Prepare export",
                  excerpt: "Export step",
                  body:
                    id === ticketID
                      ? "Deliver export ships the prepared output."
                      : "Prepare export creates the output format.",
                  version: 1,
                  truncated: false,
                  nextOffset: null,
                  relationships: [
                    {
                      source: "ticket" as const,
                      id: id === ticketID ? prerequisiteID : ticketID,
                      label: id === ticketID ? "Prepare export" : "Deliver export",
                      relationship:
                        id === ticketID ? ("prerequisite" as const) : ("dependent" as const),
                    },
                  ],
                };
              }
              expect(id).toBe(ticketID);
              return {
                source,
                id,
                label: "Release guide",
                excerpt: "Release notes live in Project overview.",
                body: "Release notes live in the Project overview. No external release portal exists.",
                version: 1,
                truncated: false,
                nextOffset: null,
                relationships: [],
              };
            },
          },
        });
        const totalMs = Math.round(performance.now() - start);
        console.log(
          JSON.stringify({
            suite: "project-agent-quality",
            case: scenario.name,
            model: defaults.planningModelId,
            firstMeaningfulFeedbackMs: firstFeedbackMs ?? totalMs,
            totalMs,
            providerRounds,
            result: output.kind,
          }),
        );
        scenario.verify(output);
        for (const citation of output.citations) expect(readSources.has(citation.id)).toBe(true);
        expect(providerRounds).toBeLessThanOrEqual(scenario.research ? 4 : 2);
      } catch (cause) {
        // SDK errors may include request bodies/credentials. Keep the test verdict,
        // never rethrow or attach a raw provider error to the reporter.
        if (cause instanceof Error && cause.name === "AssertionError") throw cause;
        throw new Error(`Quality case failed: ${scenario.name}. Provider details withheld.`);
      } finally {
        await database.client.end();
      }
    },
    65_000,
  );
