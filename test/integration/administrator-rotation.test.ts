import { expect, test } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { emergencyAdministratorID } from "../../packages/auth/src/policy";
import { createFactoryAuth } from "../../packages/auth/src/server";
import { factoryProcess } from "../fixtures/factory-process";

const development = "factory-local-password";
const chosen = "a-chosen-administrator-password";

test("a configured administrator password replaces the retained development password", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const previousEmail = process.env["FACTORY_ADMIN_EMAIL"];
  const previous = process.env["FACTORY_ADMIN_PASSWORD"];
  let email = "";
  const signIn = async (auth: ReturnType<typeof createFactoryAuth>, password: string) =>
    (
      await auth.auth.handler(
        new Request(`${fixture.base}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: fixture.base, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      )
    ).status;
  try {
    await fixture.start();
    process.env["FACTORY_BASE_URL"] = fixture.base;
    const [administrator] = await database.client<{ email: string }[]>`
      SELECT email FROM auth."user" WHERE id = ${emergencyAdministratorID}`;
    email = administrator?.email ?? "";
    process.env["FACTORY_ADMIN_EMAIL"] = email;
    await database.client`UPDATE auth.account SET password = ${await hashPassword(development)}
      WHERE provider_id = 'credential' AND user_id = ${emergencyAdministratorID}`;
    process.env["FACTORY_ADMIN_PASSWORD"] = development;
    const initial = createFactoryAuth(database);
    await initial.bootstrap();
    expect(await signIn(initial, development)).toBe(200);
    process.env["FACTORY_ADMIN_PASSWORD"] = chosen;
    const configured = createFactoryAuth(database);
    await configured.bootstrap();
    expect(await signIn(configured, chosen)).toBe(200);
    expect(await signIn(configured, development)).not.toBe(200);
  } finally {
    if (previous === undefined) delete process.env["FACTORY_ADMIN_PASSWORD"];
    else process.env["FACTORY_ADMIN_PASSWORD"] = previous;
    if (previousEmail === undefined) delete process.env["FACTORY_ADMIN_EMAIL"];
    else process.env["FACTORY_ADMIN_EMAIL"] = previousEmail;
    await fixture.dispose();
  }
}, 120_000);
