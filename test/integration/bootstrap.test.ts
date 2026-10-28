import { expect, test } from "bun:test";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { factoryProcess } from "../fixtures/factory-process";
import {
  callFactoryFunction,
  decodeFactoryResponse,
  factoryFunctionRequest,
} from "../fixtures/server-functions";

test("compiled public Bootstrap is narrowly anonymous, strips native tokens, and is separate from HTTP readiness", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  try {
    await owned.start();
    const signedOut = await serverCall(callFactoryFunction(owned.base, "getBootstrap", []));
    expect(signedOut.session).toBeNull();
    expect(signedOut.identity).toEqual({ companySignIn: false, sessionDays: 7 });
    expect(await serverCall(callFactoryFunction(owned.base, "getBootstrap", []))).toMatchObject({
      session: null,
    });
    const forged = await fetch(
      await factoryFunctionRequest(owned.base, "getBootstrap", [
        {
          user: { id: "forged-admin", name: "Forged", email: "forged@fixture.test" },
          systemManager: true,
        },
      ]),
    );
    expect(await decodeFactoryResponse(forged)).toMatchObject({
      ok: true,
      value: { session: null },
    });
    expect(
      (await fetch(await factoryFunctionRequest(owned.base, "getModelAvailability", []))).status,
    ).toBe(401);
    expect((await fetch(await factoryFunctionRequest(owned.base, "getAccounts", []))).status).toBe(
      401,
    );
    expect(
      (
        await fetch(
          await factoryFunctionRequest(owned.base, "getBootstrap", [], {
            origin: "https://foreign.invalid",
          }),
        )
      ).status,
    ).toBe(403);
    const cookie = await owned.signIn();
    const signedIn = await serverCall(
      callFactoryFunction(owned.base, "getBootstrap", [], { cookie }),
    );
    expect(signedIn.session?.systemManager).toBe(true);
    expect(Object.keys(signedIn.session ?? {}).sort()).toEqual(["systemManager", "user"]);
    const [native] = await database.client<
      { token: string }[]
    >`SELECT token FROM auth.session LIMIT 1`;
    if (!native) throw new Error("Owned authenticated session missing");
    expect(JSON.stringify(signedIn)).not.toContain(native.token);
    const readiness = await fetch(`${owned.base}/health/ready`);
    expect(readiness.headers.get("x-open-factory")).toBe("ready");
    expect(readiness.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(await readiness.json()).sort()).toEqual(["planningCacheURL", "ready"]);
    expect((await fetch(`${owned.base}/health/ready`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${owned.base}/api/session`, { headers: { cookie } })).status).toBe(404);
  } finally {
    await database.client.end();
    await owned.dispose();
  }
});
