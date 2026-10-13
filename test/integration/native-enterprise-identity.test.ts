import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createFactoryAuth } from "../../packages/auth/src/server";
import { forgeClientID } from "../../packages/auth/src/forge-issuer";
import { factoryProcess } from "../fixtures/factory-process";

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

test("native OIDC binds verified issuer/subject, rejects nonce/signature/replay/email collisions and disabled accounts", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const codes = new Map<
    string,
    {
      sub: string;
      email: string;
      nonce: string;
      codeChallenge: string;
      authTime: number;
      wrongSignature?: boolean;
    }
  >();
  const previousBase = process.env["FACTORY_BASE_URL"];
  process.env["FACTORY_BASE_URL"] = fixture.base;
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          jwks_uri: `${url.origin}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [
            {
              ...keys.publicKey.export({ format: "jwk" }),
              kid: "controlled-key",
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      if (url.pathname !== "/token") return new Response(null, { status: 404 });
      const form = await request.formData();
      const code = codes.get(String(form.get("code")));
      codes.delete(String(form.get("code")));
      if (!code || form.get("client_secret") !== "controlled-client-secret")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      const challenge = new Bun.CryptoHasher("sha256")
        .update(String(form.get("code_verifier")))
        .digest("base64url");
      if (challenge !== code.codeChallenge)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "controlled-key" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          iss: url.origin,
          aud: "factory-controlled",
          sub: code.sub,
          email: code.email,
          name: "Controlled user",
          nonce: code.nonce,
          auth_time: code.authTime,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString("base64url");
      const signingKey = code.wrongSignature
        ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
        : keys.privateKey;
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        signingKey,
      ).toString("base64url");
      return Response.json({
        token_type: "Bearer",
        access_token: "controlled-token-never-persist",
        id_token: `${header}.${payload}.${signature}`,
        expires_in: 300,
      });
    },
  });
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    let identity = createFactoryAuth(database, {
      sessionDays: 7,
      provider: {
        domain: "example.test",
        providerId: "company",
        oidcConfig: {
          issuer: issuer.url.origin,
          discoveryEndpoint: `${issuer.url.origin}/.well-known/openid-configuration`,
          clientId: "factory-controlled",
          clientSecret: "controlled-client-secret",
          pkce: true,
          scopes: ["openid", "email", "profile"],
        },
      },
    });
    await identity.bootstrap();
    authServer = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(fixture.base).port),
      fetch: (request) => identity.auth.handler(request),
    });
    async function login(input: {
      sub: string;
      email: string;
      badNonce?: boolean;
      wrongSignature?: boolean;
      oldAuth?: boolean;
      badState?: boolean;
      oauthQuery?: string;
    }) {
      const start = await fetch(`${fixture.base}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { origin: fixture.base, "content-type": "application/json" },
        body: JSON.stringify({
          callbackURL: fixture.base,
          providerId: "company",
          ...(input.oauthQuery ? { oauth_query: input.oauthQuery } : {}),
        }),
      });
      expect(start.status).toBe(200);
      const body = (await start.json()) as { url: string };
      const url = new URL(body.url);
      expect(url.searchParams.get("nonce")).toBeTruthy();
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      const code = crypto.randomUUID();
      codes.set(code, {
        sub: input.sub,
        email: input.email,
        nonce: input.badNonce ? "wrong" : (url.searchParams.get("nonce") ?? ""),
        codeChallenge: url.searchParams.get("code_challenge") ?? "",
        authTime: Math.floor(Date.now() / 1000) - (input.oldAuth ? 600 : 0),
        ...(input.wrongSignature ? { wrongSignature: true } : {}),
      });
      const callback = new URL(`${fixture.base}/api/auth/sso/callback/company`);
      callback.searchParams.set("code", code);
      callback.searchParams.set(
        "state",
        input.badState ? "wrong" : (url.searchParams.get("state") ?? ""),
      );
      const response = await fetch(callback, {
        redirect: "manual",
        headers: { cookie: cookies(start), accept: "text/html", "sec-fetch-mode": "navigate" },
      });
      return { response, callback, stateCookie: cookies(start) };
    }
    const first = await login({ sub: "subject-a", email: "a@example.test" });
    expect(first.response.headers.get("location")).toBe(fixture.base);
    const session = await identity.session(
      new Request(fixture.base, { headers: { cookie: cookies(first.response) } }),
    );
    expect(session?.user.email).toBe("a@example.test");
    if (!session) throw new Error("OIDC session missing");
    expect(session?.systemManager).toBe(false);
    expect(
      await database.client`SELECT * FROM factory.project_membership WHERE user_id=${session.user.id}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT * FROM auth.account WHERE user_id=${session.user.id} AND (access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL)`,
    ).toHaveLength(0);
    const adminLogin = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({
        email: process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local",
        password: process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password",
      }),
    });
    expect(adminLogin.status).toBe(200);
    const forgeCallback = "https://forge.example.test/user/oauth2/Factory/callback";
    await identity.ensureForgeClient(new Headers({ cookie: cookies(adminLogin) }), forgeCallback);
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`sso-forge-${projectID}`},'Owned SSO Forge','https://example.invalid/repo.git','main','.devcontainer/devcontainer.json',${session.user.id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${session.user.id},'developer',${session.user.id})`;
    const authorize = new URL(`${fixture.base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: forgeClientID,
      redirect_uri: forgeCallback,
      response_type: "code",
      scope: "openid profile email",
      state: "owned-sso-forge-state",
      code_challenge_method: "S256",
      code_challenge: new Bun.CryptoHasher("sha256")
        .update("owned-sso-forge-verifier")
        .digest("base64url"),
    }))
      authorize.searchParams.set(key, value);
    const signIn = await fetch(authorize, { redirect: "manual" });
    const signInURL = new URL(signIn.headers.get("location") ?? "", fixture.base);
    const continued = await login({
      sub: "subject-a",
      email: "a@example.test",
      oauthQuery: signInURL.search.slice(1),
    });
    const continuedURL = new URL(continued.response.headers.get("location") ?? "", fixture.base);
    expect(continuedURL.origin).toBe(new URL(forgeCallback).origin);
    expect(continuedURL.searchParams.get("state")).toBe("owned-sso-forge-state");
    expect(continuedURL.searchParams.get("code")).toBeTruthy();
    const replay = await fetch(first.callback, {
      redirect: "manual",
      headers: { cookie: first.stateCookie },
    });
    expect(replay.headers.get("set-cookie") ?? "").not.toContain("session_token");
    for (const failure of [
      { sub: "subject-b", email: "a@example.test" },
      { sub: "subject-c", email: "c@example.test", badNonce: true },
      { sub: "subject-d", email: "d@example.test", wrongSignature: true },
      { sub: "subject-e", email: "e@example.test", oldAuth: true },
      { sub: "subject-f", email: "f@example.test", badState: true },
      { sub: "subject-g", email: "g@outside.test" },
    ]) {
      const rejected = await login(failure);
      expect(rejected.response.headers.get("set-cookie") ?? "").not.toContain("session_token");
      expect(rejected.response.headers.get("location")).not.toBe(fixture.base);
    }
    expect(await database.client`SELECT * FROM factory.external_identity`).toHaveLength(1);
    const renamed = await login({ sub: "subject-a", email: "renamed@example.test" });
    const renamedSession = await identity.session(
      new Request(fixture.base, { headers: { cookie: cookies(renamed.response) } }),
    );
    expect(renamedSession?.user.id).toBe(session?.user.id);
    await database.client`UPDATE factory.account_access SET directory_disabled_at=now() WHERE user_id=${session.user.id}`;
    expect(
      await identity.session(
        new Request(fixture.base, { headers: { cookie: cookies(first.response) } }),
      ),
    ).toBeNull();
    const native = await fetch(`${fixture.base}/api/auth/get-session`, {
      headers: { cookie: cookies(first.response) },
    });
    expect(await native.json()).toBeNull();
    const disabled = await login({ sub: "subject-a", email: "a@example.test" });
    expect(disabled.response.headers.get("set-cookie") ?? "").not.toContain("session_token");
    const local = createFactoryAuth(database);
    const passwordUser = await local.createManagedUser({
      name: "Local",
      email: "local@example.test",
      password: "controlled-password-value",
    });
    const password = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({ email: passwordUser?.email, password: "controlled-password-value" }),
    });
    expect(password.status).toBe(403);
    await expect(
      identity.createManagedUser({
        name: "No fallback",
        email: "no@example.test",
        password: "controlled-password-value",
      }),
    ).rejects.toThrow("Accounts are provisioned");
    for (const path of ["sso/register", "link-social", "change-email"]) {
      expect(
        (
          await fetch(`${fixture.base}/api/auth/${path}`, {
            method: "POST",
            headers: { origin: fixture.base, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).not.toBe(200);
    }
    // The same verified subject must acquire its active native directory link.
    identity = createFactoryAuth(database, {
      sessionDays: 7,
      provider: {
        domain: "example.test",
        providerId: "company",
        oidcConfig: {
          issuer: issuer.url.origin,
          discoveryEndpoint: `${issuer.url.origin}/.well-known/openid-configuration`,
          clientId: "factory-controlled",
          clientSecret: "controlled-client-secret",
          pkce: true,
          scopes: ["openid", "email", "profile"],
        },
      },
      directory: { token: "controlled-scim-bearer-secret", subjectClaim: "sub" },
    });
    const unprovisioned = await login({ sub: "directory-a", email: "directory@example.test" });
    expect(unprovisioned.response.headers.get("set-cookie") ?? "").not.toContain("session_token");
    async function scimCommand(
      path: string,
      method: string,
      body?: unknown,
      token = "controlled-scim-bearer-secret",
    ) {
      return fetch(`${fixture.base}/api/auth/scim/v2/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const resource = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: "directory-a",
      userName: "directory@example.test",
      displayName: "Directory user",
      emails: [{ value: "directory@example.test", primary: true }],
      active: true,
    };
    expect((await scimCommand("Users", "POST", resource, "wrong")).status).toBe(401);
    const created = await scimCommand("Users", "POST", resource);
    expect(created.status).toBe(201);
    const provisioned = (await created.json()) as { id: string };
    const directoryLogin = await login({ sub: "directory-a", email: "directory@example.test" });
    const directorySession = await identity.session(
      new Request(fixture.base, { headers: { cookie: cookies(directoryLogin.response) } }),
    );
    expect(directorySession?.user.email).toBe("directory@example.test");
    if (!directorySession) throw new Error("Directory session missing");
    const patch = {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: "active", value: false }],
    };
    expect((await scimCommand(`Users/${provisioned.id}`, "PATCH", patch)).status).toBe(200);
    expect(
      await identity.session(
        new Request(fixture.base, { headers: { cookie: cookies(directoryLogin.response) } }),
      ),
    ).toBeNull();
    expect(
      await database.client`SELECT id FROM auth.session WHERE user_id=${directorySession.user.id}`,
    ).toHaveLength(0);
    const afterDisable = await login({ sub: "directory-a", email: "directory@example.test" });
    expect(afterDisable.response.headers.get("set-cookie") ?? "").not.toContain("session_token");
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${directorySession.user.id}`;
    expect(
      (
        await scimCommand(`Users/${provisioned.id}`, "PATCH", {
          ...patch,
          Operations: [{ op: "Replace", path: "active", value: true }],
        })
      ).status,
    ).toBe(200);
    const afterEnable = await login({ sub: "directory-a", email: "directory@example.test" });
    expect(afterEnable.response.headers.get("set-cookie") ?? "").not.toContain("session_token");
  } finally {
    await authServer?.stop(true);
    await issuer.stop(true);
    if (previousBase === undefined) delete process.env["FACTORY_BASE_URL"];
    else process.env["FACTORY_BASE_URL"] = previousBase;
    await database.client.end();
    await fixture.dispose();
  }
}, 60_000);
