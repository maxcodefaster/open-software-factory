import { strict as assert } from "node:assert";
import { mock } from "bun:test";
import { createAgentCommandIds } from "../../apps/factory/src/agent-command-ids";
import {
  type ConversationView,
  conversationViewSchema,
} from "../../apps/factory/src/api-contracts";

// Each test runs this fixture in a separate process. Transport replacements must
// never leak into another test or the live Factory.
const scenario = process.argv[2] ?? "first";
const projectID = crypto.randomUUID();
const ticketID = crypto.randomUUID();
const contextID = crypto.randomUUID();
const otherContextID = crypto.randomUUID();
const turnID = crypto.randomUUID();
const initial = conversationViewSchema.parse({
  id: crypto.randomUUID(),
  projectId: projectID,
  ticketId: ticketID,
  mode: "plan",
  version: 1,
  contextId: contextID,
  entries: [],
});
const completed = conversationViewSchema.parse({
  ...initial,
  version: 2,
  entries: [
    {
      id: crypto.randomUUID(),
      ordinal: 1,
      kind: "question",
      actor: "project-agent",
      mode: "plan",
      body: "Which behavior should the help explain?",
      payload: {},
      citations: [],
      createdAt: new Date().toISOString(),
    },
  ],
});
let saved = completed;
let current: ConversationView | undefined;
let key = `assistant:${projectID}:${ticketID}:original`;
const pending = new Set<string>();
const publications: ConversationView[] = [];
const errors: string[] = [];
let commissions = 0;
let refreshes = 0;
let pendingAtAdmission = false;
let sentContext: string | undefined;
function switchContext() {
  current = { ...initial, contextId: otherContextID };
  key = `assistant:${projectID}:${ticketID}:${otherContextID}`;
}
mock.module("../../apps/factory/src/server-functions/conversations", () => ({
  setConversationMode: async () => {
    if (scenario === "before-mode") switchContext();
    return { ok: true, value: initial };
  },
  sendConversationMessage: async (args: {
    data: [string, { contextId?: string; commandId: string }];
  }) => {
    commissions++;
    sentContext = args.data[1].contextId;
    pendingAtAdmission = pending.has(key);
    saved = conversationViewSchema.parse({
      ...completed,
      turn: {
        id: turnID,
        commandId: args.data[1].commandId,
        state: "completed",
        engine: "mastra",
        mode: "plan",
        modelId: "owned-no-provider",
        skills: [],
      },
      entries: [
        {
          ...completed.entries[0],
          id: crypto.randomUUID(),
          kind: "user-message",
          actor: "user",
          payload: { commandId: args.data[1].commandId },
          ordinal: 1,
        },
        { ...completed.entries[0], ordinal: 2 },
      ],
    });
    return {
      ok: true,
      value: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "admitted", turnId: turnID });
          if (scenario === "recovered") {
            controller.error(new Error("Controlled stream disconnection after server completion"));
            return;
          }
          if (scenario === "before-completion") switchContext();
          controller.enqueue({ type: "complete", conversation: saved });
          controller.close();
        },
      }),
    };
  },
  getConversation: async () => ({ ok: true, value: saved }),
  answerConversationQuestion: () => {
    throw new Error("No answer was commissioned");
  },
}));
const { createConversationCommands } = await import(
  "../../apps/factory/src/desktop/conversation-commands"
);
const stored = new Map<string, string>();
const commands = createConversationCommands({
  assistantContextLoading: () => false,
  assistantPending: () => pending.has(key),
  canPromptBuild: () => false,
  promptAgent: async () => {},
  selectedProjectID: () => projectID,
  assistantTicketID: () => ticketID,
  detail: () => ({ ticket: { id: ticketID, state: "ready" } }),
  setAgentOpen: () => true,
  pauseClarification() {},
  pendingInterview: () => false,
  clarificationOrigins: new Set<string>(),
  assistantKey: () => key,
  selectedChange: () => undefined,
  moveTicket: async () => true,
  conversation: () => current,
  clarificationPaused: () => false,
  agentCommandScope: () => `${projectID}:${ticketID}:message`,
  publishProvisionalAnswer() {},
  clearProvisionalAnswer() {},
  workspaceDisposed: false,
  acknowledgeCommand() {},
  async mutate(operation: () => Promise<unknown>, _current: unknown, pendingKey: string) {
    pending.add(pendingKey);
    try {
      return { ok: true, value: await operation() };
    } catch (cause) {
      errors.push(String(cause));
      return { ok: false };
    } finally {
      pending.delete(pendingKey);
    }
  },
  publishConversation(value: ConversationView | undefined) {
    current = value;
    if (value) {
      publications.push(value);
      key = `assistant:${projectID}:${ticketID}:${value.contextId ?? "original"}`;
    }
  },
  agentCommandIds: createAgentCommandIds({
    userId: "isolated-first-planning",
    storage: {
      getItem: (name) => stored.get(name) ?? null,
      setItem: (name, value) => {
        stored.set(name, value);
      },
      removeItem: (name) => {
        stored.delete(name);
      },
    },
  }),
  trackConversationStream: () => () => {},
  refreshConversation: async () => {
    refreshes++;
  },
  selectedTicketID: () => ticketID,
  setSelectedTicketID: () => ticketID,
  refreshTicketDetail: async () => undefined,
  setError: (message: string) => {
    errors.push(message);
    return message;
  },
  setPendingInterviewAnswer: () => undefined,
  pendingInterviewAnswer: () => undefined,
} as unknown as Parameters<typeof createConversationCommands>[0]);
await commands.beginRequirementsInterview("full-planning");
if (scenario !== "recovered") assert.deepEqual(errors, []);
if (scenario === "first") {
  assert(
    current?.entries.some((entry) => entry.kind === "question"),
    "First Planning must display its completed question without reload",
  );
  assert.equal(commissions, 1, "Exactly one model commission");
  assert.equal(sentContext, contextID, "Bind the command to the newly prepared context");
  assert.equal(pendingAtAdmission, true, "Keep first Planning busy while its context is prepared");
  assert.equal(refreshes, 1, "Observe the admitted turn");
  assert.equal(
    publications.length,
    1,
    "Do not switch the visible context for an empty mode response",
  );
} else if (scenario === "recovered") {
  assert(
    current?.entries.some((entry) => entry.kind === "question"),
    "Recover the saved completed answer by observation",
  );
  assert.equal(
    errors.at(-1),
    "",
    "A recovered completed turn must clear the transport error, not claim Agent failure",
  );
  assert.equal(commissions, 1, "Recovery must not repeat inference");
} else {
  assert.equal(
    current?.contextId,
    otherContextID,
    "Do not overwrite a later human context selection",
  );
  assert.equal(commissions, scenario === "before-mode" ? 0 : 1);
}
assert.equal(pending.size, 0);
console.log(`PASS first-conversation ${scenario}`);
