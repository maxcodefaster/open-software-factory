import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";

test("compiled Inbox commands bind the authenticated actor, validate identities and honor write maintenance", async () => {
  const actor = crypto.randomUUID(),
    ticket = crypto.randomUUID(),
    project = crypto.randomUUID();
  const effects: unknown[][] = [];
  let maintenance = true,
    authenticated = true;
  const endpoint = await compiledFactoryEndpoint({
    origin: "https://owned-inbox.test",
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("Inbox does not grant credentials");
    },
    services: {
      inbox: {
        list: async (...args: unknown[]) => {
          effects.push(["list", ...args]);
          return { items: [], count: 0 };
        },
        people: async (...args: unknown[]) => {
          effects.push(["people", ...args]);
          return [];
        },
        ticket: async (...args: unknown[]) => {
          effects.push(["ticket", ...args]);
          return {};
        },
        responsibility: async (...args: unknown[]) => {
          effects.push(["responsibility", ...args]);
          return {};
        },
        follow: async (...args: unknown[]) => {
          effects.push(["follow", ...args]);
          return {};
        },
        receipt: async (...args: unknown[]) => {
          effects.push(["receipt", ...args]);
        },
      },
    } as unknown as FactoryServices,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(
      await endpoint(await factoryFunctionRequest("https://owned-inbox.test", name, args)),
    );
  const assignment = { commandId: crypto.randomUUID(), expectedVersion: 0, responsibleId: actor };
  for (const [name, args] of [
    ["setTicketResponsibility", [ticket, assignment]],
    ["setTicketFollowing", [ticket, true]],
    ["markInboxItem", [{ itemId: "question:owned", eventId: "owned", action: "read" }]],
  ] as const)
    expect(await call(name, [...args])).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["getTicketAttention", ["not-an-id"]],
    ["getAttentionPeople", ["not-an-id"]],
    ["setTicketResponsibility", [ticket, { ...assignment, actorId: crypto.randomUUID() }]],
    ["markInboxItem", [{ itemId: "owned", eventId: "owned", action: "approve" }]],
  ] as const)
    expect(await call(name, [...args])).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  for (const [name, args] of [
    ["getInbox", []],
    ["getTicketAttention", [ticket]],
    ["getAttentionPeople", [project]],
    ["setTicketResponsibility", [ticket, assignment]],
    ["setTicketFollowing", [ticket, false]],
    ["markInboxItem", [{ itemId: "owned", eventId: "owned", action: "read" }]],
  ] as const)
    expect(await call(name, [...args])).toMatchObject({ ok: true });
  expect(effects).toEqual([
    ["list", actor],
    ["ticket", actor, ticket],
    ["people", actor, project],
    ["responsibility", actor, ticket, assignment],
    ["follow", actor, ticket, false],
    ["receipt", actor, { itemId: "owned", eventId: "owned", action: "read" }],
  ]);
  authenticated = false;
  expect(
    (await endpoint(await factoryFunctionRequest("https://owned-inbox.test", "getInbox", [])))
      .status,
  ).toBe(401);
});
