import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { CommandError } from "../../apps/factory/src/command-error";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { planningDesign } from "../fixtures/technical-planning";

test("compiled Ticket and Project commands validate exact input, bind the actor and detach cancellation without replay", async () => {
  const origin = "https://owned-tickets.test",
    actor = crypto.randomUUID(),
    ticket = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    change = crypto.randomUUID();
  const effects: unknown[][] = [];
  const admitted = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  let maintenance = true,
    authenticated = true,
    allowed = true;
  const authority = () => {
    if (!allowed) throw new CommandError("not-found", "Ticket not found");
  };
  const input = {
    commandId: crypto.randomUUID(),
    expectedVersion: 1,
    expectedDocumentId: null,
    requirementRevisionId: null,
    title: "Owned intent",
    description: "Keep exact human text",
    requirement: { summary: "A partial manual document", acceptanceCriteria: [], nonGoals: [] },
  };
  const implementation = {
    commandId: crypto.randomUUID(),
    revisionId: revision,
    codingReasoning: "high" as const,
    technicalDesignRevisionId: crypto.randomUUID(),
  };
  const technicalInput = {
    commandId: crypto.randomUUID(),
    expectedRevisionId: crypto.randomUUID(),
    content: planningDesign,
  };
  const project = {
    name: "Owned Project",
    slug: "owned-project",
    repositoryUrl: "https://forge.test/factory/owned.git",
    defaultBranch: "release",
    devcontainerPath: ".devcontainer/devcontainer.json",
  };
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("These commands do not change protected credentials");
    },
    services: {
      tickets: {
        async createRevision(...args: Parameters<FactoryServices["tickets"]["createRevision"]>) {
          authority();
          effects.push(["revision", ...args]);
          return { id: revision };
        },
        async approveRevision(...args: Parameters<FactoryServices["tickets"]["approveRevision"]>) {
          authority();
          effects.push(["approve-revision", ...args]);
          return { id: crypto.randomUUID(), requirementRevisionId: revision };
        },
        async startChange(...args: Parameters<FactoryServices["tickets"]["startChange"]>) {
          authority();
          effects.push(["start-change", ...args]);
          return { id: change };
        },
        async detail(...args: Parameters<FactoryServices["tickets"]["detail"]>) {
          authority();
          effects.push(["detail", ...args]);
          return { ticket: { id: ticket } };
        },
        async save(...args: Parameters<FactoryServices["tickets"]["save"]>) {
          authority();
          effects.push(["save", ...args]);
          return { id: input.commandId, ticketVersion: 2, requirementRevisionId: null };
        },
        async saveTechnicalDesign(
          ...args: Parameters<FactoryServices["tickets"]["saveTechnicalDesign"]>
        ) {
          authority();
          effects.push(["save-technical-design", ...args]);
          return { id: args[2].commandId };
        },
        async followUp(...args: Parameters<FactoryServices["tickets"]["followUp"]>) {
          authority();
          effects.push(["follow-up", ...args]);
          return { ticketId: args[2].commandId };
        },
        async trash(...args: Parameters<FactoryServices["tickets"]["trash"]>) {
          authority();
          effects.push(["trash", ...args]);
        },
        async restore(...args: Parameters<FactoryServices["tickets"]["restore"]>) {
          authority();
          effects.push(["restore", ...args]);
        },
        async implement(...args: Parameters<FactoryServices["tickets"]["implement"]>) {
          authority();
          effects.push(["implement", ...args]);
          admitted.resolve();
          await released.promise;
          return { id: change };
        },
      },
      projects: {
        async list(...args: Parameters<FactoryServices["projects"]["list"]>) {
          effects.push(["list-projects", ...args]);
          return { projects: [] };
        },
        async register(...args: Parameters<FactoryServices["projects"]["register"]>) {
          effects.push(["register", ...args]);
          return { id: crypto.randomUUID(), ...project };
        },
      },
    } as unknown as FactoryServices,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const writes: Array<[string, unknown[]]> = [
    [
      "createRequirementRevision",
      [
        ticket,
        { summary: "Approved work", acceptanceCriteria: ["One exact result"], nonGoals: [] },
      ],
    ],
    ["approveRequirementRevision", [ticket, revision]],
    ["startTicketChange", [ticket]],
    ["saveTicketDocument", [ticket, input]],
    ["saveTicketTechnicalDesign", [ticket, technicalInput]],
    [
      "createTicketFollowUp",
      [
        ticket,
        {
          commandId: crypto.randomUUID(),
          expectedDocumentId: null,
          requirementRevisionId: revision,
        },
      ],
    ],
    ["trashTicket", [ticket]],
    ["restoreTicket", [ticket, 2]],
    ["implementTicket", [ticket, implementation]],
    ["registerProject", [project]],
  ];
  for (const [name, args] of writes)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["getTicketDetail", ["bad-id"]],
    ["createRequirementRevision", [ticket, { summary: "", acceptanceCriteria: [] }]],
    ["approveRequirementRevision", [ticket, "bad-id"]],
    ["startTicketChange", ["bad-id"]],
    ["saveTicketDocument", [ticket, { ...input, expectedVersion: 0 }]],
    ["saveTicketDocument", [ticket, { ...input, createdBy: crypto.randomUUID() }]],
    [
      "saveTicketTechnicalDesign",
      [
        ticket,
        {
          ...technicalInput,
          content: {
            ...planningDesign,
            diagrams: [
              {
                title: "Denied",
                description: "External include",
                source: "@startuml\n!include secret\n@enduml",
              },
            ],
          },
        },
      ],
    ],
    ["createTicketFollowUp", [ticket, { commandId: "bad-id" }]],
    ["trashTicket", ["bad-id"]],
    ["restoreTicket", [ticket, -1]],
    ["implementTicket", [ticket, { ...implementation, codingReasoning: "low" }]],
    ["registerProject", [{ ...project, slug: "../bad" }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  allowed = false;
  expect(await call("getTicketDetail", [ticket])).toMatchObject({ ok: false, status: 404 });
  expect(await call("saveTicketDocument", [ticket, input])).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(
    await call("createRequirementRevision", [
      ticket,
      { summary: "Denied", acceptanceCriteria: ["No cross-Project effects"] },
    ]),
  ).toMatchObject({ ok: false, status: 404 });
  expect(await call("approveRequirementRevision", [ticket, revision])).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(await call("startTicketChange", [ticket])).toMatchObject({ ok: false, status: 404 });
  expect(await call("saveTicketTechnicalDesign", [ticket, technicalInput])).toMatchObject({
    ok: false,
    status: 404,
  });
  allowed = true;
  expect(await call("getTicketDetail", [ticket])).toMatchObject({ ok: true });
  for (const [name, args] of writes.filter(([name]) => name !== "implementTicket"))
    expect(await call(name, args)).toMatchObject({ ok: true });
  expect(await call("getProjects", [])).toMatchObject({ ok: true, value: { projects: [] } });
  expect(effects).toContainEqual(["save", actor, ticket, input]);
  expect(effects).toContainEqual(["save-technical-design", actor, ticket, technicalInput]);
  expect(effects).toContainEqual(["restore", actor, ticket, 2]);
  expect(effects).toContainEqual(["register", actor, project]);
  expect(effects).toContainEqual([
    "revision",
    actor,
    ticket,
    { summary: "Approved work", acceptanceCriteria: ["One exact result"], nonGoals: [] },
  ]);
  expect(effects).toContainEqual(["approve-revision", actor, ticket, revision]);
  expect(effects).toContainEqual(["start-change", actor, ticket]);
  const cancellation = new AbortController();
  const pending = endpoint(
    await factoryFunctionRequest(
      origin,
      "implementTicket",
      [ticket, implementation],
      {},
      cancellation.signal,
    ),
  );
  void pending.catch(() => {});
  await admitted.promise;
  cancellation.abort();
  released.resolve();
  await pending.catch(() => undefined);
  expect(effects.filter(([kind]) => kind === "implement")).toEqual([
    ["implement", actor, ticket, implementation],
  ]);
  authenticated = false;
  expect(
    (await endpoint(await factoryFunctionRequest(origin, "getTicketDetail", [ticket]))).status,
  ).toBe(401);
});
