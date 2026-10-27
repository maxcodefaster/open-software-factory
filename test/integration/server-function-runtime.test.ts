import { expect, test } from "bun:test";
import type { APIRequestContext } from "@playwright/test";
import { decodeFactoryResponse as decodeResponse } from "../fixtures/server-functions";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { SystemContractError } from "../../packages/system-contract/src/system-contract";
import {
  compiledFactoryEndpoint,
  factoryFunctionRequest,
  requestFunction,
} from "../fixtures/server-functions";

test("native browser request fixtures mask credential-bearing transport errors and never replay", async () => {
  const credential = "owned-fixture-cookie-must-not-appear";
  let calls = 0;
  const client = {
    async fetch() {
      calls++;
      throw new Error(`Timeout: Cookie: factory.session_token=${credential}`);
    },
  } as unknown as APIRequestContext;
  const failure = await requestFunction(client, "getRuntimeAttempts", []).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    "Factory function response is unconfirmed: getRuntimeAttempts",
  );
  expect(String(failure)).not.toContain(credential);
  expect(calls).toBe(1);
});

test("compiled runtime commands retain trusted System Contract failures without leaking arbitrary errors", async () => {
  const origin = "https://owned-runtime-contract.test",
    actor = crypto.randomUUID(),
    project = crypto.randomUUID();
  let failure: Error = new SystemContractError(".factory/system.json is not valid JSON");
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async () => ({ user: { id: actor } }),
    maintenance: async () => false,
    requireFresh: async () => {},
    services: {
      runtime: {
        async startPersonal(userID: string, projectID: string) {
          expect([userID, projectID]).toEqual([actor, project]);
          throw failure;
        },
      },
    } as unknown as FactoryServices,
  });
  const call = async () =>
    decodeResponse(
      await endpoint(await factoryFunctionRequest(origin, "startPersonalWorkspace", [project])),
    );
  expect(await call()).toEqual({
    ok: false,
    status: 422,
    message: ".factory/system.json is not valid JSON",
  });
  failure = new Error("Internal credentials must not be exposed");
  expect(await call()).toEqual({
    ok: false,
    status: 500,
    message: "Factory command failed. Its outcome is unconfirmed.",
  });
  failure.name = "SystemContractError";
  expect(await call()).toMatchObject({ ok: false, status: 500 });
});
