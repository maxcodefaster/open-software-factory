import { expect, test } from "bun:test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { learningFixture } from "../fixtures/learning";

test("compiled work-review commands validate exact input, session and fresh-write maintenance without inferring on reads", async () => {
  const actor = crypto.randomUUID();
  const project = crypto.randomUUID();
  const effects: unknown[][] = [];
  let maintenance = true,
    authenticated = true,
    fresh = 0;
  const endpoint = await compiledFactoryEndpoint({
    origin: "https://owned-learning.test",
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      fresh++;
    },
    services: {
      learning: {
        get: async (...args: unknown[]) => {
          effects.push(["get", ...args]);
          return { ...learningFixture(true), projectId: project };
        },
        set: async (...args: unknown[]) => {
          effects.push(["set", ...args]);
          return { version: 1 };
        },
        decide: async (...args: unknown[]) => {
          effects.push(["decide", ...args]);
          return { ticketId: null };
        },
        rollback: async (...args: unknown[]) => {
          effects.push(["rollback", ...args]);
          return { revisionId: crypto.randomUUID(), version: 3 };
        },
      },
    } as unknown as FactoryServices,
  });
  const call = async (
    name: "getLearning" | "saveLearning" | "decideLearning" | "rollbackLearning",
    args: unknown[],
  ) =>
    decodeResponse(
      await endpoint(await factoryFunctionRequest("https://owned-learning.test", name, args)),
    );
  const command = {
    commandId: crypto.randomUUID(),
    projectId: project,
    scope: "project",
    expectedVersion: 0,
    enabled: false,
    automaticSkills: false,
  };
  expect(await call("saveLearning", [command])).toMatchObject({ ok: false, status: 503 });
  expect(effects).toHaveLength(0);
  maintenance = false;
  expect(await call("getLearning", ["not-a-project", false])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call("saveLearning", [{ ...command, actorId: crypto.randomUUID() }])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call("getLearning", [project, false])).toMatchObject({ ok: true });
  expect(fresh).toBe(0);
  expect(effects).toEqual([["get", actor, project, false]]);
  expect(await call("saveLearning", [command])).toMatchObject({ ok: true });
  expect(fresh).toBe(1);
  expect(effects[1]).toEqual(["set", actor, command]);
  expect(
    await call("rollbackLearning", [
      {
        commandId: crypto.randomUUID(),
        applicationId: "wrong",
        expectedRevisionId: crypto.randomUUID(),
      },
    ]),
  ).toMatchObject({ ok: false, status: 400 });
  const rollback = {
    commandId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    expectedRevisionId: crypto.randomUUID(),
  };
  expect(await call("rollbackLearning", [rollback])).toMatchObject({ ok: true });
  expect(effects.at(-1)).toEqual(["rollback", actor, rollback]);
  authenticated = false;
  expect(
    (
      await endpoint(
        await factoryFunctionRequest("https://owned-learning.test", "getLearning", [
          project,
          false,
        ]),
      )
    ).status,
  ).toBe(401);
});
