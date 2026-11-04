import { expect, test } from "bun:test";
import { PasswordChangeError } from "../../packages/auth/src/policy";
import { createFactoryAuth } from "../../packages/auth/src/server";
import { factoryProcess } from "../fixtures/factory-process";

const initial = "initial-password-for-owned-test";
const rotated = "rotated-password-for-owned-test";

test("self-service password change rotates the hash, keeps this session, ends the others and never logs passwords", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const previousBase = process.env["FACTORY_BASE_URL"];
  process.env["FACTORY_BASE_URL"] = fixture.base;
  const identity = createFactoryAuth(database);
  const logged: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  for (const level of ["log", "error", "warn"] as const)
    console[level] = (...values: unknown[]) => {
      logged.push(values.map(String).join(" "));
    };
  const login = async (email: string, password: string) => {
    const response = await identity.auth.handler(
      new Request(`${fixture.base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: fixture.base, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    return {
      status: response.status,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
  };
  const sessionID = async (cookie: string) => {
    const session = await identity.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) throw new Error("Session missing");
    return session.session.id;
  };
  const input = (
    currentPassword: string,
    newPassword = rotated,
    confirmPassword = newPassword,
  ) => ({
    currentPassword,
    newPassword,
    confirmPassword,
  });
  async function refused(
    promise: Promise<unknown>,
    kind: PasswordChangeError["kind"],
    text: RegExp,
  ) {
    const cause = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(cause).toBeInstanceOf(PasswordChangeError);
    expect((cause as PasswordChangeError).kind).toBe(kind);
    expect((cause as PasswordChangeError).message).toMatch(text);
  }
  try {
    await identity.bootstrap();
    const person = await identity.createManagedUser({
      name: "Owned rotation",
      email: "rotation@password.test",
      password: initial,
    });
    if (!person) throw new Error("Account missing");
    const here = await login(person.email, initial);
    const other = await login(person.email, initial);
    expect([here.status, other.status]).toEqual([200, 200]);
    const current = await sessionID(here.cookie);
    const count = async () =>
      Number(
        (
          await database.client`SELECT count(*)::int AS n FROM auth.session WHERE user_id=${person.id}`
        )[0]?.["n"],
      );
    expect(await count()).toBe(2);

    await refused(
      identity.changePassword(person.id, current, input("wrong-current-password")),
      "wrong-password",
      /current password is incorrect/,
    );
    await refused(
      identity.changePassword(person.id, current, input(initial, "short")),
      "refused",
      /at least 12/,
    );
    await refused(
      identity.changePassword(person.id, current, input(initial, rotated, "another-password-123")),
      "refused",
      /confirmation differ/,
    );
    await refused(
      identity.changePassword(person.id, current, input(initial, initial)),
      "refused",
      /differs from the current/,
    );
    expect(await count()).toBe(2);
    expect((await login(person.email, initial)).status).toBe(200);
    expect(await count()).toBe(3);

    // A session that is not a fresh sign-in cannot rotate a password.
    await database.client`UPDATE auth.session SET authenticated_at=now() - interval '10 minutes' WHERE id=${current}`;
    await refused(
      identity.changePassword(person.id, current, input(initial)),
      "unavailable",
      /Sign in again/,
    );
    await database.client`UPDATE auth.session SET authenticated_at=now() WHERE id=${current}`;
    // Another person's session never authorizes this account.
    await refused(
      identity.changePassword(crypto.randomUUID(), current, input(initial)),
      "unavailable",
      /Sign in again/,
    );

    await identity.changePassword(person.id, current, input(initial));
    expect(await count()).toBe(1);
    expect(await sessionID(here.cookie)).toBe(current);
    expect(
      await identity.auth.api.getSession({ headers: new Headers({ cookie: other.cookie }) }),
    ).toBeNull();
    expect((await login(person.email, initial)).status).toBe(401);
    expect((await login(person.email, rotated)).status).toBe(200);

    // Native Better Auth password routes stay closed.
    for (const path of ["/change-password", "/set-password"]) {
      const response = await identity.auth.handler(
        new Request(`${fixture.base}/api/auth/${path.slice(1)}`, {
          method: "POST",
          headers: {
            origin: fixture.base,
            "content-type": "application/json",
            cookie: here.cookie,
          },
          body: JSON.stringify({ newPassword: "x".repeat(20), currentPassword: rotated }),
        }),
      );
      expect(response.status).toBe(404);
    }

    // Sign-in style lockout: five wrong current passwords stop attempts, even with the right one.
    const fresh = await login(person.email, rotated);
    const freshID = await sessionID(fresh.cookie);
    for (let attempt = 0; attempt < 5; attempt++)
      await refused(
        identity.changePassword(person.id, freshID, input("wrong-current-password")),
        "wrong-password",
        /incorrect/,
      );
    await refused(
      identity.changePassword(person.id, freshID, input(rotated, "unused-new-password-1")),
      "locked",
      /Too many incorrect.*minute/,
    );
    expect((await login(person.email, rotated)).status).toBe(200);

    // Accounts without a Factory password, and non-password sessions, never see this flow.
    const [singleSignOn] = await database.client<{ id: string }[]>`
      INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${crypto.randomUUID()},'Owned SSO','sso@password.test',true) RETURNING id`;
    if (!singleSignOn) throw new Error("SSO account missing");
    await database.client`INSERT INTO factory.account_access(user_id) VALUES(${singleSignOn.id}) ON CONFLICT DO NOTHING`;
    const ssoSession = crypto.randomUUID();
    await database.client`INSERT INTO auth.session(id,expires_at,token,user_id,login_method)
      VALUES(${ssoSession},now()+interval '1 day',${crypto.randomUUID()},${singleSignOn.id},'sso')`;
    await refused(
      identity.changePassword(singleSignOn.id, ssoSession, input("anything-at-all")),
      "refused",
      /company sign-in/,
    );
    const other2 = await identity.createManagedUser({
      name: "Owned SSO session",
      email: "sso2@password.test",
      password: initial,
    });
    if (!other2) throw new Error("Account missing");
    const methodSession = crypto.randomUUID();
    await database.client`INSERT INTO auth.session(id,expires_at,token,user_id,login_method)
      VALUES(${methodSession},now()+interval '1 day',${crypto.randomUUID()},${other2.id},'sso')`;
    await refused(
      identity.changePassword(other2.id, methodSession, input(initial)),
      "refused",
      /company sign-in/,
    );

    expect(logged.join("\n")).not.toContain(initial);
    expect(logged.join("\n")).not.toContain(rotated);
  } finally {
    Object.assign(console, originals);
    if (previousBase === undefined) delete process.env["FACTORY_BASE_URL"];
    else process.env["FACTORY_BASE_URL"] = previousBase;
    await database.client.end({ timeout: 2 });
    await fixture.dispose();
  }
}, 60_000);
