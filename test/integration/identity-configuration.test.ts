import { expect, test } from "bun:test";
import { createIdentityConfiguration } from "../../apps/factory/src/access/identity-configuration";
import { identityConfiguration } from "../../packages/identity-domain/src/configuration";
import { factoryProcess } from "../fixtures/factory-process";
import { authenticatedBootstrap } from "../fixtures/server-functions";
import { oidcProviderFixture } from "../fixtures/oidc-provider";

test("protected sign-in intent recovers response loss, replays exactly, rejects untested activation and changes session policy live", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  type StoreValue = {
    commandID: string;
    fingerprint: string;
    configuration: ReturnType<typeof identityConfiguration.parse>;
  };
  const vault = new Map<string, StoreValue>();
  let loseResponse = true;
  const secrets = {
    configured: true,
    async read(key: string) {
      return vault.get(key);
    },
    async create(key: string, value: StoreValue) {
      if (vault.has(key)) throw new Error("CAS conflict");
      vault.set(key, value);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost acknowledgement");
      }
    },
  };
  try {
    await fixture.start();
    const cookie = await fixture.signIn();
    const { session } = await authenticatedBootstrap(fixture.base, { cookie });
    const admin = session.user.id;
    const control = createIdentityConfiguration(database, "controlled-hmac-secret", secrets, [
      "https://identity.example.test",
    ]);
    const input = {
      commandID: crypto.randomUUID(),
      version: 0,
      configuration: identityConfiguration.parse({ mode: "local", sessionDays: 30 }),
    };
    await expect(control.save(admin, input)).rejects.toThrow("Lost acknowledgement");
    expect((await control.view(admin)).version).toBe(0);
    await control.recover();
    expect((await control.view(admin)).candidates[0]?.state).toBe("saved");
    const replay = await control.save(admin, input);
    expect(replay.candidates).toHaveLength(1);
    expect(vault.size).toBe(1);
    const restarted = createIdentityConfiguration(database, "controlled-hmac-secret", secrets, [
      "https://identity.example.test",
    ]);
    await restarted.recover();
    expect((await restarted.activate(admin, input.commandID)).sessionDays).toBe(30);
    expect((await restarted.activate(admin, input.commandID)).version).toBe(1);
    expect((await control.view(admin)).sessionDays).toBe(30);
    await expect(
      control.save(admin, {
        ...input,
        configuration: identityConfiguration.parse({ mode: "local", sessionDays: 7 }),
      }),
    ).rejects.toThrow("reused");
    const oidc = {
      commandID: crypto.randomUUID(),
      version: 1,
      configuration: identityConfiguration.parse({
        mode: "oidc",
        sessionDays: 7,
        issuer: "https://identity.example.test",
        clientID: "client",
        clientSecret: "protected-provider-secret",
        domain: "company.test",
      }),
    };
    await control.save(admin, oidc);
    await expect(control.activate(admin, oidc.commandID)).rejects.toThrow(
      "Complete the sign-in check",
    );
    await expect(
      control.save(admin, {
        ...oidc,
        commandID: crypto.randomUUID(),
        configuration: { ...oidc.configuration, issuer: "http://127.0.0.1" },
      }),
    ).rejects.toThrow("HTTPS");
    const rows = await database.client`SELECT metadata::text FROM factory.identity_setup`;
    expect(JSON.stringify(rows)).not.toContain("protected-provider-secret");
    expect(JSON.stringify(await control.view(admin))).not.toContain("protected-provider-secret");
    expect(await database.client`SELECT * FROM auth."ssoProvider"`).toHaveLength(0);
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
}, 60_000);

test("native company sign-in check survives restart and unrelated state cookies without granting a product session", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const provider = await oidcProviderFixture();
  const previousBase = process.env["FACTORY_BASE_URL"];
  process.env["FACTORY_BASE_URL"] = fixture.base;
  type Value = {
    commandID: string;
    fingerprint: string;
    configuration: ReturnType<typeof identityConfiguration.parse>;
  };
  const vault = new Map<string, Value>();
  const secrets = {
    configured: true,
    async read(key: string) {
      return vault.get(key);
    },
    async create(key: string, value: Value) {
      vault.set(key, value);
    },
  };
  let control = createIdentityConfiguration(database, "owned-key", secrets, [provider.issuer]);
  let server: ReturnType<typeof Bun.serve> | undefined;
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  async function post(path: string, body: unknown, cookie = "") {
    return fetch(`${fixture.base}/api/auth/${path}`, {
      method: "POST",
      headers: { origin: fixture.base, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  try {
    await control.bootstrap();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(fixture.base).port),
      fetch: (request) => control.handler(request),
    });
    const login = await post("sign-in/email", {
      email: process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local",
      password: process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password",
    });
    expect(login.status).toBe(200);
    const adminCookie = cookies(login);
    const admin = await control.session(
      new Request(fixture.base, { headers: { cookie: adminCookie } }),
    );
    if (!admin) throw new Error("Emergency session missing");
    const configuration = identityConfiguration.parse({
      mode: "oidc",
      sessionDays: 7,
      issuer: provider.issuer,
      clientID: "owned-factory",
      clientSecret: "owned-oidc-client-secret",
      domain: "company.test",
    });
    const firstID = crypto.randomUUID();
    const secondID = crypto.randomUUID();
    await control.save(admin.user.id, { commandID: firstID, version: 0, configuration });
    const first = await post("sign-in/sso", { setupCommandID: firstID }, adminCookie);
    expect(first.status, first.status === 200 ? undefined : await first.clone().text()).toBe(200);
    await control.save(admin.user.id, { commandID: secondID, version: 0, configuration });
    const second = await post("sign-in/sso", { setupCommandID: secondID }, adminCookie);
    expect(second.status).toBe(200);
    const { url } = (await second.json()) as { url: string };
    const callback = provider.callback(url, {
      subject: "company-a",
      email: "company-a@company.test",
    });
    control = createIdentityConfiguration(database, "owned-key", secrets, [provider.issuer]);
    await control.recover();
    const response = await fetch(callback, {
      redirect: "manual",
      headers: {
        cookie: `${adminCookie}; ${cookies(first)}; ${cookies(second)}; factory.state=unrelated`,
      },
    });
    expect(response.headers.get("location")).toBe(`${fixture.base}/?identity-check=${secondID}`);
    expect(provider.exchanges()).toBe(1);
    expect(
      (await control.view(admin.user.id)).candidates.find((row) => row.commandID === secondID)
        ?.tested,
    ).toBe(true);
    expect(
      (await control.view(admin.user.id)).candidates.find((row) => row.commandID === firstID)
        ?.tested,
    ).toBe(false);
    expect(
      await control.session(new Request(fixture.base, { headers: { cookie: cookies(response) } })),
    ).toBeNull();
    const [testSession] = await database.client<
      { userID: string }[]
    >`SELECT user_id AS "userID" FROM auth.session WHERE login_method='identity-test'`;
    expect(testSession).toBeDefined();
    expect(
      await database.client`SELECT user_id FROM factory.project_membership WHERE user_id=${testSession?.userID ?? admin.user.id}`,
    ).toHaveLength(0);
    expect((await control.activate(admin.user.id, secondID)).mode).toBe("oidc");
    expect(
      await database.client`SELECT id FROM auth.session WHERE login_method='identity-test'`,
    ).toHaveLength(0);
    expect(
      await control.session(new Request(fixture.base, { headers: { cookie: adminCookie } })),
    ).not.toBeNull();
    const normal = await post("sign-in/sso", {});
    expect(normal.status).toBe(200);
    const normalBody = (await normal.json()) as { url: string };
    const company = await fetch(
      provider.callback(normalBody.url, { subject: "company-a", email: "company-a@company.test" }),
      { redirect: "manual", headers: { cookie: cookies(normal) } },
    );
    const session = await control.session(
      new Request(fixture.base, { headers: { cookie: cookies(company) } }),
    );
    expect(session?.user.id).toBe(testSession?.userID);
    expect(session?.systemManager).toBe(false);
    if (!session) throw new Error("Company session missing");
    expect(new Date(session.session.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60_000,
    );
    await database.client`UPDATE auth.session SET authenticated_at=now()-interval '25 hours' WHERE id=${session.session.id}`;
    expect(
      await control.session(new Request(fixture.base, { headers: { cookie: cookies(company) } })),
    ).toBeNull();
    expect(
      await (
        await fetch(`${fixture.base}/api/auth/get-session`, {
          headers: { cookie: cookies(company) },
        })
      ).json(),
    ).toBeNull();
    const unavailable = createIdentityConfiguration(
      database,
      "owned-key",
      {
        configured: true,
        async read() {
          throw new Error("Owned protected store unavailable");
        },
        async create() {
          throw new Error("Owned protected store unavailable");
        },
      },
      [provider.issuer],
    );
    await unavailable.bootstrap();
    expect(unavailable.policy.companySignIn).toBe(true);
    expect(
      await unavailable.session(new Request(fixture.base, { headers: { cookie: adminCookie } })),
    ).not.toBeNull();
    const member = await post("sign-in/sso", {});
    expect(member.status).toBe(200);
    const memberBody = (await member.json()) as { url: string };
    const memberLogin = await fetch(
      provider.callback(memberBody.url, { subject: "company-a", email: "company-a@company.test" }),
      { redirect: "manual", headers: { cookie: cookies(member) } },
    );
    expect(
      await unavailable.session(
        new Request(fixture.base, { headers: { cookie: cookies(memberLogin) } }),
      ),
    ).toBeNull();
  } finally {
    await server?.stop(true);
    await provider.dispose();
    if (previousBase === undefined) delete process.env["FACTORY_BASE_URL"];
    else process.env["FACTORY_BASE_URL"] = previousBase;
    await database.client.end();
    await fixture.dispose();
  }
}, 60_000);
