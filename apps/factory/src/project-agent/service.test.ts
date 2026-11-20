import { expect, test } from "bun:test";
import { ZodError } from "zod";
import type { ConversationStreamEvent } from "../api-contracts";
import { createConversationService } from "./service";

type Service = ReturnType<typeof createConversationService>;
type Controller = Parameters<typeof createConversationService>[0]["controller"];
type ControllerView = Awaited<ReturnType<Controller["get"]>>;

const userID = crypto.randomUUID();
const projectID = crypto.randomUUID();
const timestamp = "2026-11-20T10:00:00.000Z";
const unconfirmed =
  "Conversation response is unconfirmed. Refresh its saved history before retrying.";

function conversation(createdAt: Date | string) {
  return {
    id: crypto.randomUUID(),
    projectId: projectID,
    mode: "plan",
    version: "3",
    contexts: [
      {
        id: crypto.randomUUID(),
        kind: "research",
        title: "Owned conversation",
        ordinal: 1,
        original: true,
        createdAt,
      },
    ],
    entries: [
      {
        id: crypto.randomUUID(),
        ordinal: "1",
        kind: "user-message",
        actor: "user",
        mode: "plan",
        body: "Clarify the saved requirements",
        payload: {},
        citations: [],
        createdAt,
      },
    ],
  };
}

function serviceFor(value: unknown) {
  const result = async () => value as ControllerView;
  return createConversationService({
    access: { requireProject: async () => {} },
    controller: {
      get: result,
      newConversation: result,
      message: result,
      setMode: result,
      answer: result,
      confirmEpic: async () => {
        throw new Error("This proof confirms no Epic");
      },
    },
  });
}

function commands(service: Service) {
  return [
    () => service.newConversation(userID, projectID, { commandId: crypto.randomUUID() }),
    () => service.mode(userID, projectID, { mode: "plan" }),
    () =>
      service.answer(userID, projectID, {
        commandId: crypto.randomUUID(),
        questionEntryId: crypto.randomUUID(),
        answer: { selectedOptionIds: [], customText: "Keep the approved scope" },
      }),
  ];
}

async function messageEvents(service: Service) {
  const reader = (
    await service.message(
      userID,
      projectID,
      { commandId: crypto.randomUUID(), text: "Clarify the saved requirements" },
      new AbortController().signal,
    )
  ).getReader();
  const events: ConversationStreamEvent[] = [];
  for (;;) {
    const event = await reader.read();
    if (event.done) return events;
    events.push(event.value);
  }
}

test.each([
  ["Date", new Date(timestamp)],
  ["ISO string", timestamp],
] as const)(
  "conversation reads and confirmed commands normalize %s timestamps and validate their DTOs",
  async (_kind, createdAt) => {
    const service = serviceFor(conversation(createdAt));
    const view = await service.get(userID, projectID, {});
    if (!view) throw new Error("Owned conversation is missing");
    expect(view).toMatchObject({
      version: 3,
      contextId: null,
      activeCodingContextId: null,
      codingHistory: null,
      contexts: [{ createdAt: timestamp }],
      entries: [{ ordinal: 1, createdAt: timestamp }],
    });
    for (const command of commands(service)) expect(await command()).toEqual(view);
    expect(await messageEvents(service)).toEqual([{ type: "complete", conversation: view }]);
  },
);

test("a missing conversation read stays null but an unconfirmed command is unavailable", async () => {
  const service = serviceFor(null);
  expect(await service.get(userID, projectID, {})).toBeNull();
  for (const command of commands(service))
    await expect(command()).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
      message: unconfirmed,
    });
  expect(await messageEvents(service)).toEqual([{ type: "error", error: unconfirmed }]);
});

test.each([
  { ...conversation(timestamp), version: "invalid" },
  {
    ...conversation(timestamp),
    entries: [{ ...conversation(timestamp).entries[0], createdAt: null }],
  },
])("invalid conversation DTOs cannot become successful reads or commands: %#", async (value) => {
  const service = serviceFor(value);
  await expect(service.get(userID, projectID, {})).rejects.toBeInstanceOf(ZodError);
  for (const command of commands(service)) await expect(command()).rejects.toBeInstanceOf(ZodError);
  expect(await messageEvents(service)).toEqual([
    { type: "error", error: "The Project Agent could not finish its response." },
  ]);
});
