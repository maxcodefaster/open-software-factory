import { expect, spyOn, test } from "bun:test";
import type { APIRequestContext } from "@playwright/test";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { SystemContractError } from "#system-contract/system-contract";
import { createRuntimeService } from "../../apps/factory/src/runtime/service";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import {
  callFactoryFunction,
  compiledFactoryEndpoint,
  decodeFactoryResponse as decodeResponse,
  factoryFunctionRequest,
  requestFunction,
} from "../fixtures/server-functions";
import { substrateFixture } from "../fixtures/substrate";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

test("the native Stop client defers its socket idle budget to the lifecycle owner while preserving explicit cancellation and ordinary read bounds", async () => {
  let options: BunFetchRequestInit | undefined;
  let input: Request | undefined;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls++;
        input = request as Request;
        options = init;
        throw new Error("Owned transport disconnected; outcome unconfirmed");
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const cancellation = new AbortController();
  const origin = "https://owned-lifecycle-command.test";
  try {
    await expect(
      callFactoryFunction(
        origin,
        "stopRuntimeAttempt",
        [crypto.randomUUID()],
        {},
        cancellation.signal,
      ),
    ).rejects.toThrow("outcome unconfirmed");
    expect(calls).toBe(1);
    expect(options).toEqual({ timeout: false });
    cancellation.abort();
    expect(input?.signal.aborted).toBe(true);
    await expect(callFactoryFunction(origin, "getRuntimeAttempts", [])).rejects.toThrow(
      "outcome unconfirmed",
    );
    expect(options).toBeUndefined();
    expect(calls).toBe(2);
  } finally {
    mocked.mockRestore();
  }
});

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
    message:
      "Factory could not finish that action. Reload to see whether it was saved, then try again.",
  });
  failure.name = "SystemContractError";
  expect(await call()).toMatchObject({ ok: false, status: 500 });
});

test("compiled Stop confirms authorized isolated Staging without rejecting its settled outcome", async () => {
  const origin = "https://owned-staging-stop.test",
    actor = crypto.randomUUID(),
    project = crypto.randomUUID(),
    attemptID = crypto.randomUUID(),
    events: string[] = [];
  const stopped = {
    id: attemptID,
    projectId: project,
    runtimeKind: "staging",
    state: "stop-intended",
    generation: "1",
    revision: "a".repeat(40),
    createdAt: new Date("2026-10-28T00:00:00Z"),
    updatedAt: new Date("2026-10-28T00:01:00Z"),
  };
  const client = {
    unsafe(statement: string, parameters: unknown[]) {
      expect(statement).toContain('select "workspace_id" from "factory"."runtime_attempt"');
      expect(parameters).toEqual([attemptID]);
      return { values: async () => [[null]] };
    },
  } as unknown as ReturnType<typeof createDatabase>["client"];
  const runtime = createRuntimeService({
    database: { client, db: drizzleTransaction(client) },
    access: {
      async requireRuntime(userID: string, id: string, channel: string) {
        expect([userID, id, channel]).toEqual([actor, attemptID, "ide"]);
        events.push("authorize");
      },
    },
    runtime: {
      async stop(id: string) {
        expect(id).toBe(attemptID);
        events.push("stop");
        return stopped;
      },
    },
    revokeAttempt(id: string) {
      expect(id).toBe(attemptID);
      events.push("revoke");
    },
    suspendAttempt(id: string) {
      expect(id).toBe(attemptID);
      events.push("suspend");
    },
  } as unknown as Parameters<typeof createRuntimeService>[0]);
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async () => ({ user: { id: actor } }),
    maintenance: async () => false,
    requireFresh: async () => {},
    services: { runtime } as unknown as FactoryServices,
  });
  const result = await decodeResponse(
    await endpoint(await factoryFunctionRequest(origin, "stopRuntimeAttempt", [attemptID])),
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      id: attemptID,
      runtimeKind: "staging",
      state: "stop-intended",
      createdAt: stopped.createdAt.toISOString(),
      updatedAt: stopped.updatedAt.toISOString(),
    },
  });
  expect(events).toEqual(["authorize", "stop", "revoke", "suspend"]);
});

test("the public isolated Stop command cannot delete a retained Workspace or revoke its editor", async () => {
  const f = await substrateFixture();
  const events: string[] = [];
  try {
    await recordUncreatedWorkspaceAttempt(f.database, {
      workspaceID: f.workspaceID,
      generation: 1,
      createdBy: f.userID,
      parentHash: "a".repeat(64),
      childHash: "b".repeat(64),
      connectorURL: "wss://owned.factory.invalid/internal/runtime-connect",
    });
    const runtime = createRuntimeService({
      database: f.database,
      access: {
        async requireRuntime(userID: string, attemptID: string) {
          expect([userID, attemptID]).toEqual([f.userID, f.attemptID]);
          events.push("authorize");
        },
      },
      runtime: {
        async stop() {
          events.push("delete");
          throw new Error("Workspace deletion was dispatched");
        },
      },
      revokeAttempt: () => events.push("revoke"),
      suspendAttempt: () => events.push("suspend"),
    } as unknown as Parameters<typeof createRuntimeService>[0]);
    await expect(runtime.stop(f.userID, f.attemptID)).rejects.toMatchObject({
      code: "conflict",
      message: "Use Pause compute for this Workspace. Stop is reserved for isolated execution.",
    });
    expect(events).toEqual(["authorize"]);
    expect(
      await f.database
        .client`SELECT id FROM factory.runtime_attempt WHERE id=${f.attemptID} AND stop_intended_at IS NULL`,
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});
