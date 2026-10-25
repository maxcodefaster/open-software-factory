import { expect, test } from "bun:test";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { CommandError } from "../../apps/factory/src/command-error";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { factoryFunctionRequest } from "../fixtures/server-functions";

test("compiled Access commands bind actors, retain Fresh Auth and maintenance, and reject forged account/membership inputs", async () => {
  const origin = "https://factory.test";
  const actorID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const targetID = crypto.randomUUID();
  const commandID = crypto.randomUUID();
  let fresh = false,
    maintenance = false;
  const effects: Array<{ method: string; args: unknown[] }> = [];
  const entryURL = pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href;
  const entry: typeof import("../../apps/factory/src/server-functions/entry") = await import(
    entryURL
  );
  const observe = (method: string, args: unknown[]) => {
    effects.push({ method, args });
  };
  const services = {
    access: {
      async authentication(actor, current) {
        return { fresh: current, email: `${actor}@fixture.test`, companySignIn: false };
      },
      async createUser(...args) {
        observe("create", args);
        return { id: targetID, name: "Owned account", email: "owned@fixture.test" };
      },
      async setAccountAccess(...args) {
        observe("access", args);
      },
      async endAccountSessions(...args) {
        observe("end-account-sessions", args);
      },
      async endOwnSessions(...args) {
        observe("end-own-sessions", args);
      },
      async setMember(...args) {
        observe("membership", args);
        return { userId: targetID, role: args[2].role, manageProject: args[2].manageProject };
      },
      async removeMember(...args) {
        observe("remove-member", args);
      },
      async saveIdentity(...args) {
        observe("identity", args);
        throw new CommandError("conflict", "Sign-in save identity was reused");
      },
      async activateIdentity(...args) {
        observe("activate", args);
        throw new CommandError("conflict", "Sign-in setup is not ready");
      },
    },
  } satisfies { [K in keyof FactoryServices]?: Partial<FactoryServices[K]> };
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: services as unknown as FactoryServices,
    session: async () => ({ user: { id: actorID } }),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      if (!fresh) throw new Error("Stale fixture session");
    },
    handle: entry.handleServerFunctionRequest,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  expect(await call("getAuthenticationState", [])).toMatchObject({
    ok: true,
    value: { fresh: false },
  });
  const account = {
    name: "Owned account",
    email: "owned@fixture.test",
    password: "owned-not-a-real-secret",
  };
  const identity = { commandID, version: 0, configuration: { mode: "local", sessionDays: 7 } };
  const commands: Array<[string, unknown[]]> = [
    ["createAccount", [account]],
    ["setAccountAccess", [targetID, true]],
    ["endAccountSessions", [targetID]],
    ["endOwnSessions", []],
    ["saveProjectMember", [projectID, { email: account.email, role: "developer" }]],
    ["removeProjectMember", [projectID, targetID]],
    ["saveIdentityConfiguration", [identity]],
    ["activateIdentityConfiguration", [commandID]],
  ];
  for (const [name, args] of commands)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 403 });
  expect(effects).toEqual([]);
  fresh = true;
  maintenance = true;
  for (const [name, args] of commands)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  expect(await call("createAccount", [{ ...account, actorID: targetID }])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(
    await call("saveProjectMember", [
      projectID,
      { email: account.email, role: "developer", userID: targetID },
    ]),
  ).toMatchObject({ ok: false, status: 400 });
  expect(await call("setAccountAccess", [targetID, "true"])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await call("removeProjectMember", ["not-a-project", targetID])).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(effects).toEqual([]);
  for (const [name, args] of commands) {
    const result = await call(name, args);
    expect(result).toMatchObject(
      name.includes("Identity") ? { ok: false, status: 409 } : { ok: true },
    );
  }
  expect(effects.map((effect) => effect.args[0])).toEqual(commands.map(() => actorID));
  expect(effects.find((effect) => effect.method === "membership")?.args).toEqual([
    actorID,
    projectID,
    { email: account.email, role: "developer", manageProject: false },
  ]);
  expect(effects.find((effect) => effect.method === "end-own-sessions")?.args).toEqual([actorID]);
});
