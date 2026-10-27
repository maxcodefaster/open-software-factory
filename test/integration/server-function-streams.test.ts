import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createConversationService } from "../../apps/factory/src/project-agent/service";
import { createAgentService } from "../../apps/factory/src/agent/service";
import { CommandError } from "../../apps/factory/src/command-error";
import type { ConversationView } from "../../apps/factory/src/api-contracts";
import { agentViewSchema } from "../../apps/factory/src/api-contracts";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { streamConversation } from "../../apps/factory/src/conversation-stream";
import {
  callFactoryFunction,
  compiledFactoryEndpoint,
  factoryFunctionRequest,
} from "../fixtures/server-functions";

test("native CSRF accepts only the configured canonical origin across proxy Fetch Metadata", async () => {
  const origin = "https://owned-canonical-factory.test",
    actor = crypto.randomUUID(),
    change = crypto.randomUUID();
  let reads = 0;
  const value = agentViewSchema.parse({
    state: "idle",
    messages: [],
    messagesAvailable: true,
    sessionAvailable: false,
    runtimeConnected: false,
    stopPending: false,
    stopId: null,
  });
  const endpoint = await compiledFactoryEndpoint({
    origin,
    services: {
      agent: {
        get: async () => {
          reads++;
          return value;
        },
      },
    } as unknown as FactoryServices,
    session: async () => ({ user: { id: actor } }),
    maintenance: async () => false,
    requireFresh: async () => {},
  });
  for (const site of ["same-site", "cross-site"]) {
    const response = await endpoint(
      await factoryFunctionRequest(origin, "getAgentView", [change], { "sec-fetch-site": site }),
    );
    expect(await decodeResponse(response)).toMatchObject({ ok: true });
  }
  expect(
    (
      await endpoint(
        await factoryFunctionRequest(origin, "getAgentView", [change], {
          origin: "https://foreign.test",
          "sec-fetch-site": "cross-site",
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await endpoint(
        await factoryFunctionRequest(origin, "getAgentView", [change], {
          "sec-fetch-site": "none",
        }),
      )
    ).status,
  ).toBe(403);
  expect(reads).toBe(2);
});

test("compiled Project message streams admit once before provisional text and finish after the browser disconnects", async () => {
  const actor = crypto.randomUUID(),
    project = crypto.randomUUID(),
    turn = crypto.randomUUID(),
    command = crypto.randomUUID(),
    release = Promise.withResolvers<void>(),
    finished = Promise.withResolvers<void>(),
    text = Promise.withResolvers<string>(),
    admitted = Promise.withResolvers<void>();
  let starts = 0,
    authenticated = true;
  const result: ConversationView = {
    id: crypto.randomUUID(),
    projectId: project,
    mode: "plan",
    version: 1,
    contextId: null,
    activeCodingContextId: null,
    isActiveCoding: false,
    contexts: [],
    codingHistory: null,
    entries: [],
  };
  const conversations = createConversationService({
    access: {
      async requireProject(userID, projectID) {
        expect([userID, projectID]).toEqual([actor, project]);
      },
    },
    controller: {
      async get() {
        return result as Awaited<ReturnType<FactoryServices["conversations"]["get"]>> as never;
      },
      async newConversation() {
        throw new Error("Not used");
      },
      async setMode() {
        throw new Error("Not used");
      },
      async answer() {
        throw new Error("Not used");
      },
      async confirmEpic() {
        throw new Error("Not used");
      },
      async message(projectID, ticketID, message, userID, commandID, intent, observer, contextID) {
        expect([projectID, ticketID, message, userID, commandID, intent, contextID]).toEqual([
          project,
          undefined,
          "Retain my message",
          actor,
          command,
          undefined,
          undefined,
        ]);
        starts++;
        observer?.admitted(turn);
        observer?.answerText(turn, "Grüße before completion");
        await release.promise;
        finished.resolve();
        return result as never;
      },
    },
  });
  let endpoint: Awaited<ReturnType<typeof compiledFactoryEndpoint>>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 180,
    fetch: (request) => endpoint(request),
  });
  endpoint = await compiledFactoryEndpoint({
    origin: server.url.origin,
    services: { conversations } as unknown as FactoryServices,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => false,
    requireFresh: async () => {},
  });
  const abort = new AbortController();
  const pending = streamConversation(
    async (signal) =>
      serverCall(
        callFactoryFunction(
          server.url.origin,
          "sendConversationMessage",
          [project, { commandId: command, text: "Retain my message" }],
          {},
          signal,
        ),
      ),
    { signal: abort.signal },
    (event) => {
      if (event.type === "admitted") admitted.resolve();
      if (event.type === "answer") text.resolve(event.text);
    },
  );
  void pending.catch(() => {});
  try {
    await admitted.promise;
    expect(
      await Promise.race([
        text.promise,
        Bun.sleep(500).then(() => {
          throw new Error("Admission arrived but the first answer was lost before completion");
        }),
      ]),
    ).toBe("Grüße before completion");
    expect(starts).toBe(1);
    abort.abort();
    await expect(pending).rejects.toThrow();
    release.resolve();
    await finished.promise;
    expect(starts).toBe(1);
    authenticated = false;
    expect(
      (
        await fetch(
          await factoryFunctionRequest(server.url.origin, "sendConversationMessage", [
            project,
            { commandId: command, text: "Retain my message" },
          ]),
        )
      ).status,
    ).toBe(401);
  } finally {
    abort.abort();
    release.resolve();
    await pending.catch(() => {});
    await server.stop(true);
  }
}, 15_000);

test("compiled Coding observations recheck current sessions and membership, reconnect by reading and never invoke commands", async () => {
  const actor = crypto.randomUUID(),
    change = crypto.randomUUID(),
    project = crypto.randomUUID();
  let authenticated = true,
    membership = true,
    developer = true,
    subscriptions = 0,
    detached = 0,
    commands = 0,
    reads = 0;
  let notify = () => {};
  const snapshot = () =>
    agentViewSchema.parse({
      state: "working",
      messagesAvailable: true,
      sessionAvailable: true,
      runtimeConnected: true,
      stopPending: false,
      stopId: null,
      messages: [
        {
          id: "file-tool",
          role: "tool",
          text: "Read file",
          at: 1,
          activity: {
            name: "read",
            status: "completed",
            navigation: { path: "private/source.ts" },
          },
        },
      ],
    });
  const unused = async () => {
    commands++;
    throw new Error("Read must not invoke a command");
  };
  const agent = createAgentService({
    access: {
      async requireChange(userID, changeID) {
        expect([userID, changeID]).toEqual([actor, change]);
        if (!membership) throw new CommandError("not-found", "Change not found");
        return project;
      },
      async canDevelop() {
        return developer;
      },
      requireDevelopment: unused,
    },
    controller: {
      get: async () => {
        reads++;
        return snapshot() as never;
      },
      start: unused,
      resume: unused,
      stop: unused,
      recheckStop: unused,
      newConversation: unused,
      prompt: unused,
      subscribeActivity(_id, wake) {
        subscriptions++;
        notify = wake;
        return () => {
          detached++;
        };
      },
    },
  });
  let endpoint: Awaited<ReturnType<typeof compiledFactoryEndpoint>>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 180,
    fetch: (request) => endpoint(request),
  });
  endpoint = await compiledFactoryEndpoint({
    origin: server.url.origin,
    services: { agent } as unknown as FactoryServices,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => false,
    requireFresh: async () => {},
  });
  const first = new AbortController(),
    second = new AbortController();
  try {
    const open = async (signal: AbortSignal) =>
      serverCall(callFactoryFunction(server.url.origin, "getAgentActivity", [change], {}, signal));
    const reader = (await open(first.signal)).getReader();
    expect((await reader.read()).value).toMatchObject({
      type: "snapshot",
      view: { messages: [{ activity: { navigation: { path: "private/source.ts" } } }] },
    });
    first.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && detached !== 1; i++) await Bun.sleep(10);
    expect(detached).toBe(1);
    developer = false;
    const reconnected = (await open(second.signal)).getReader();
    const replacement = await reconnected.read();
    expect(JSON.stringify(replacement.value)).not.toContain("private/source.ts");
    expect(subscriptions).toBe(2);
    authenticated = false;
    notify();
    await expect(reconnected.read()).rejects.toThrow();
    for (let i = 0; i < 50 && detached !== 2; i++) await Bun.sleep(10);
    expect(detached).toBe(2);
    authenticated = true;
    membership = false;
    expect(
      await callFactoryFunction(server.url.origin, "getAgentActivity", [change]),
    ).toMatchObject({ ok: false, status: 404 });
    expect(reads).toBe(2);
    expect(commands).toBe(0);
  } finally {
    first.abort();
    second.abort();
    await server.stop(true);
  }
}, 15_000);
