import { expect, test } from "bun:test";
import { z } from "zod";
import { CommandError } from "../command-error";
import type { FactoryFunctionContext, FactoryServices } from "./context";
import { createServerFunctionEndpoint } from "./endpoint";
import { fixtureValue } from "../../../../test/fixtures/value";

const origin = "https://factory.test";
const usage = {} as FactoryFunctionContext["usage"];
const services = { usage } as FactoryServices;
function request(actor = "one", ownOrigin = origin, method = "POST") {
  return new Request("http://factory.test/_server/data/getUsage-fixture", {
    method,
    headers: { origin: ownOrigin, cookie: actor },
    ...(method === "POST" ? { body: JSON.stringify({ actorID: "forged" }) } : {}),
  });
}

test("server functions bind authenticated request actors and canonical origins without shared context", async () => {
  let handled = 0;
  const endpoint = createServerFunctionEndpoint({
    origin,
    services,
    session: async (request) =>
      request.headers.get("cookie")
        ? {
            user: {
              id: fixtureValue(request.headers.get("cookie"), 'request.headers.get("cookie")'),
            },
          }
        : null,
    maintenance: async () => false,
    requireFresh: async () => {},
    async handle(request, { context }) {
      handled++;
      if (context.factory.actorID === "one") await Bun.sleep(5);
      expect(request.url.startsWith(origin)).toBe(true);
      expect(context.factory.usage).toBe(usage);
      expect(context.factory.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ actorID: context.factory.actorID });
    },
  });
  const values = await Promise.all([endpoint(request("one")), endpoint(request("two"))]);
  expect(await values[0]?.json()).toEqual({ actorID: "one" });
  expect(await values[1]?.json()).toEqual({ actorID: "two" });
  expect(
    values.every((value) => value.headers.get("cache-control") === "no-store, no-transform"),
  ).toBe(true);
  expect(values.every((value) => value.headers.get("x-accel-buffering") === "no")).toBe(true);
  expect((await endpoint(request("", origin))).status).toBe(401);
  expect((await endpoint(request("one", "https://foreign.invalid"))).status).toBe(403);
  expect((await endpoint(request("one", origin, "GET"))).status).toBe(405);
  expect(handled).toBe(2);
});

test("writes retain maintenance and fresh-authentication gates and host error identities", async () => {
  let maintenance = false,
    fresh = true,
    effects = 0;
  const endpoint = createServerFunctionEndpoint({
    origin,
    services,
    session: async () => ({ user: { id: "actor" } }),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      if (!fresh) throw new Error("stale session");
    },
    async handle(_request, { context: { factory: context } }) {
      return Response.json(
        await context.run(async () => {
          await context.beforeWrite(true);
          effects++;
          throw new CommandError("conflict", "Original command changed input");
        }),
      );
    },
  });
  maintenance = true;
  expect(await (await endpoint(request())).json()).toMatchObject({ ok: false, status: 503 });
  maintenance = false;
  fresh = false;
  expect(await (await endpoint(request())).json()).toMatchObject({ ok: false, status: 403 });
  expect(effects).toBe(0);
  fresh = true;
  expect(await (await endpoint(request())).json()).toEqual({
    ok: false,
    status: 409,
    message: "Original command changed input",
  });
  expect(effects).toBe(1);
});

test("server-side schema rejection stays a safe invalid-command result", async () => {
  const endpoint = createServerFunctionEndpoint({
    origin,
    services,
    session: async () => ({ user: { id: "actor" } }),
    maintenance: async () => false,
    requireFresh: async () => {},
    async handle(_request, { context }) {
      return Response.json(await context.factory.run(async () => z.uuid().parse("bad")));
    },
  });
  expect(await (await endpoint(request())).json()).toEqual({
    ok: false,
    status: 400,
    message: "Invalid command. Check the entered values.",
  });
});

test("long-lived observations revalidate the same request session rather than retaining its first actor", async () => {
  let actor: string | null = "one";
  let assertSession: (() => Promise<void>) | undefined;
  let classify: FactoryFunctionContext["run"] | undefined;
  const endpoint = createServerFunctionEndpoint({
    origin,
    services,
    session: async () => (actor ? { user: { id: actor } } : null),
    maintenance: async () => false,
    requireFresh: async () => {},
    async handle(_request, { context }) {
      assertSession = context.factory.assertSession;
      classify = context.factory.run;
      return Response.json({ actor: context.factory.actorID });
    },
  });
  await endpoint(request("one"));
  if (!assertSession || !classify) throw new Error("Owned observation context is missing");
  expect(await classify(assertSession)).toMatchObject({ ok: true });
  actor = "two";
  expect(await classify(assertSession)).toMatchObject({ ok: false, status: 403 });
  actor = null;
  expect(await classify(assertSession)).toMatchObject({ ok: false, status: 403 });
});

test("anonymous dispatch is limited to exact compiled public IDs and has neither an actor nor write authority", async () => {
  let attempted = 0;
  const endpoint = createServerFunctionEndpoint({
    origin,
    services,
    publicFunctionIDs: new Set(["getBootstrap-fixture"]),
    session: async () => null,
    maintenance: async () => false,
    requireFresh: async () => {
      throw new Error("Anonymous requests cannot confirm identity");
    },
    async handle(input, { context: { factory: context } }) {
      attempted++;
      return Response.json(
        await context.run(async () => {
          if (input.headers.get("x-owned-probe") === "write") await context.beforeWrite(false);
          return context.actorID;
        }),
      );
    },
  });
  const publicRequest = (probe: string) =>
    new Request(`${origin}/_server/data/getBootstrap-fixture`, {
      method: "POST",
      headers: { origin, "x-owned-probe": probe },
    });
  for (const probe of ["actor", "write"])
    expect(await (await endpoint(publicRequest(probe))).json()).toMatchObject({
      ok: false,
      status: 403,
    });
  for (const path of [
    "/_server/data/getBootstrap-fixture-suffix",
    "/_server/data/getAccounts-fixture",
    "/_server/getBootstrap-fixture",
  ])
    expect(
      (await endpoint(new Request(`${origin}${path}`, { method: "POST", headers: { origin } })))
        .status,
    ).toBe(401);
  expect(attempted).toBe(2);
});
