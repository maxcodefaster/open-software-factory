import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { decodeFactoryResponse, factoryFunctionRequest } from "../fixtures/server-functions";

test("compiled mirror commands require fresh authentication, validate consent and never replay a write", async () => {
  const origin = "https://factory.test",
    projectID = crypto.randomUUID();
  const entry: typeof import("../../apps/factory/src/start-server") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  let fresh = false,
    writes = 0,
    maintenance = false;
  const view = { projectID, mirrors: [], pending: null };
  const services = {
    repositoryMirrors: {
      create: async (actor: string) => {
        expect(actor).toBe("owned-actor");
        writes++;
        return view;
      },
    },
  } satisfies { [K in keyof FactoryServices]?: Partial<FactoryServices[K]> };
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: services as unknown as FactoryServices,
    session: async () => ({ user: { id: "owned-actor" } }),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      if (!fresh) throw new Error("Sign in again");
    },
    handle: async (request, options) => entry.default.fetch(request, options),
  });
  const input = {
    commandID: crypto.randomUUID(),
    targetURL: "https://github.com/team/copy.git",
    username: "user",
    token: "fixture-only-token",
    confirmOverwrite: true,
  };
  async function call(value: unknown = input) {
    return decodeFactoryResponse(
      await endpoint(
        await factoryFunctionRequest(origin, "createRepositoryMirror", [projectID, value]),
      ),
    );
  }
  expect(await call()).toMatchObject({ ok: false, status: 403 });
  fresh = true;
  expect(await call({ ...input, confirmOverwrite: false })).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call({ ...input, actorID: "forged" })).toMatchObject({ ok: false, status: 400 });
  maintenance = true;
  expect(await call()).toMatchObject({ ok: false, status: 503 });
  expect(writes).toBe(0);
  maintenance = false;
  expect(await call()).toMatchObject({ ok: true, value: view });
  expect(writes).toBe(1);
});
