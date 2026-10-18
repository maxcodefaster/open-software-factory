import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/client.ts";
import { createAuth } from "../src/auth.ts";

test("PostgreSQL signup, protected session, invalid password and logout", async () => {
  const database = createDatabase();
  const auth = createAuth(database, {
    secret: process.env.BETTER_AUTH_SECRET ?? "",
    baseURL: "http://localhost:4300",
  });
  const email = `verification-${crypto.randomUUID()}@starter.test`;
  const password = crypto.randomUUID();
  async function post(
    path: string,
    body: unknown,
    cookie?: string,
    origin = "http://localhost:4300",
  ) {
    return auth.handler(
      new Request(`http://localhost:4300/api/auth/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }
  try {
    const signup = await post("sign-up/email", { name: "Verification", email, password });
    assert.equal(signup.status, 200);
    const rows =
      await database.sql`SELECT account.password FROM account JOIN "user" ON "user".id=account.user_id WHERE "user".email=${email}`;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.password, password);
    assert.equal(
      (await post("sign-in/email", { email, password: "incorrect-password" })).status,
      401,
    );
    const signin = await post("sign-in/email", { email, password });
    assert.equal(signin.status, 200);
    assert.equal(
      (await post("sign-in/email", { email, password }, undefined, "http://127.0.0.1:4300")).status,
      200,
    );
    for (const origin of ["https://foreign.example", "http://127.0.0.1:4301"])
      assert.equal(
        (await post("sign-in/email", { email, password }, undefined, origin)).status,
        403,
      );
    const publicAuth = createAuth(database, {
      secret: process.env.BETTER_AUTH_SECRET ?? "",
      baseURL: "https://app.example.test",
    });
    assert.equal(
      (
        await publicAuth.handler(
          new Request("https://app.example.test/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://127.0.0.1:4300" },
            body: JSON.stringify({ email, password }),
          }),
        )
      ).status,
      403,
    );
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.equal(session?.user.email, email);
    assert.equal(await auth.api.getSession({ headers: new Headers() }), null);
    assert.equal((await post("sign-out", {}, cookie)).status, 200);
    assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
  } finally {
    await database.sql`DELETE FROM "user" WHERE email=${email}`;
    await database.sql.end({ timeout: 5 });
  }
});
