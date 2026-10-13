import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { forgeClientID, forgeClientSecret } from "../../packages/auth/src/forge-issuer";
import { createFactoryAuth } from "../../packages/auth/src/server";
import { factoryProcess } from "../fixtures/factory-process";

test("Factory native OIDC issuer registers one intended client and signs developer-only PKCE login", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const previousBase = process.env["FACTORY_BASE_URL"];
  process.env["FACTORY_BASE_URL"] = fixture.base;
  const identity = createFactoryAuth(database);
  let server: ReturnType<typeof Bun.serve> | undefined;
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  async function login(email: string, password: string) {
    const response = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(response.status).toBe(200);
    return cookies(response);
  }
  try {
    await identity.bootstrap();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(fixture.base).port),
      fetch: (request) => identity.auth.handler(request),
    });
    const administrator = await login(
      process.env["FACTORY_ADMIN_EMAIL"] ?? "admin@factory.local",
      process.env["FACTORY_ADMIN_PASSWORD"] ?? "factory-local-password",
    );
    const callback = "https://forge.example.test/user/oauth2/Factory/callback";
    const headers = new Headers({ cookie: administrator });
    expect(await identity.ensureForgeClient(headers, callback)).toBe(forgeClientID);
    // Recover a lost outcome from the exact native client, including after auth restart.
    await database.client`UPDATE factory.forge_identity_intent SET state='create-intended'`;
    expect(await createFactoryAuth(database).ensureForgeClient(headers, callback)).toBe(
      forgeClientID,
    );
    expect(
      await database.client`SELECT client_id FROM factory.forge_identity_intent WHERE state='ready'`,
    ).toHaveLength(1);
    expect(await database.client`SELECT id FROM auth."oauthClient"`).toHaveLength(1);
    const [client] = await database.client<
      { secret: string }[]
    >`SELECT "clientSecret" AS secret FROM auth."oauthClient"`;
    const signingKey =
      process.env["FACTORY_AUTH_SECRET"] ?? "local-development-secret-change-before-production";
    expect(client?.secret).not.toBe(forgeClientSecret(signingKey));
    await expect(
      identity.ensureForgeClient(headers, "http://127.0.0.1:33334/callback"),
    ).rejects.toThrow("differs");
    const password = "owned-developer-password";
    const developer = await identity.createManagedUser({
      name: "Owned developer",
      email: `${crypto.randomUUID()}@company.test`,
      password,
    });
    if (!developer) throw new Error("Developer missing");
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`issuer-${projectID}`},'Owned issuer','https://example.invalid/project.git','main','.devcontainer/devcontainer.json',${developer.id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${developer.id},'developer',${developer.id})`;
    const cookie = await login(developer.email, password);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const authorization = new URL(`${fixture.base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: forgeClientID,
      response_type: "code",
      redirect_uri: callback,
      scope: "openid profile email",
      state: "owned-client-state",
      nonce: "owned-client-nonce",
      code_challenge_method: "S256",
      code_challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
    }))
      authorization.searchParams.set(key, value);
    const authorized = await fetch(authorization, { redirect: "manual", headers: { cookie } });
    expect(authorized.status).toBe(302);
    const location = new URL(authorized.headers.get("location") ?? "");
    expect(location.origin).toBe(new URL(callback).origin);
    expect(location.searchParams.get("state")).toBe("owned-client-state");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    const prelogin = await fetch(authorization, { redirect: "manual" });
    expect(prelogin.status).toBe(302);
    const signinURL = new URL(prelogin.headers.get("location") ?? "", fixture.base);
    expect(signinURL.origin).toBe(fixture.base);
    const continued = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({
        email: developer.email,
        password,
        oauth_query: signinURL.search.slice(1),
      }),
      redirect: "manual",
    });
    expect(continued.status).toBe(200);
    const continuedBody = await continued.json();
    const continuedURL = new URL(z.object({ url: z.url() }).parse(continuedBody).url);
    expect(continuedURL.origin).toBe(new URL(callback).origin);
    expect(continuedURL.searchParams.get("code")).toBeTruthy();
    const token = await fetch(`${fixture.base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${forgeClientID}:${forgeClientSecret(signingKey)}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: forgeClientID,
        redirect_uri: callback,
        code: code ?? "",
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = z
      .object({ id_token: z.string(), access_token: z.string() })
      .parse(await token.json());
    const keys = await fetch(`${fixture.base}/api/auth/jwks`);
    expect(keys.status).toBe(200);
    const publicKeys = z
      .object({
        keys: z.array(
          z.object({ kty: z.literal("RSA"), n: z.string(), e: z.string(), kid: z.string() }),
        ),
      })
      .parse(await keys.json());
    const [encodedHeader, encodedClaims, signature] = tokens.id_token.split(".");
    const header = z
      .object({ alg: z.literal("RS256"), kid: z.string() })
      .parse(JSON.parse(Buffer.from(encodedHeader ?? "", "base64url").toString()));
    const key = publicKeys.keys.find((candidate) => candidate.kid === header.kid);
    if (!key || !signature) throw new Error("Native signing key missing");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const exchange = (requestedCode: string, requestedVerifier: string) =>
      fetch(`${fixture.base}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${forgeClientID}:${forgeClientSecret(signingKey)}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: forgeClientID,
          redirect_uri: callback,
          code: requestedCode,
          code_verifier: requestedVerifier,
        }),
      });
    const next = await fetch(authorization, { redirect: "manual", headers: { cookie } });
    const nextCode = new URL(next.headers.get("location") ?? "").searchParams.get("code");
    expect(nextCode).toBeTruthy();
    expect((await exchange(nextCode ?? "", "wrong-verifier")).status).not.toBe(200);
    const claims = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims).toMatchObject({
      sub: developer.id,
      aud: forgeClientID,
      nonce: "owned-client-nonce",
      iss: `${fixture.base}/api/auth`,
    });
    const info = await fetch(`${fixture.base}/api/auth/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      sub: developer.id,
      preferred_username: `factory-${developer.id.replaceAll("-", "")}`,
    });
    await database.client`UPDATE factory.account_access SET disabled_at=now() WHERE user_id=${developer.id}`;
    expect(
      (
        await fetch(`${fixture.base}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(authorization, { redirect: "manual", headers: { cookie } })).status,
    ).not.toBe(200);
    await database.client`UPDATE factory.account_access SET disabled_at=NULL WHERE user_id=${developer.id}`;
    const renewedCookie = await login(developer.email, password);
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE user_id=${developer.id}`;
    expect(
      (await fetch(authorization, { redirect: "manual", headers: { cookie: renewedCookie } }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(`${fixture.base}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${fixture.base}/api/auth/oauth2/register`, {
          method: "POST",
          headers: { cookie, origin: fixture.base, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).not.toBe(200);
    expect(JSON.stringify(publicKeys)).not.toContain("privateKey");
    // Native code-replay protection also revokes tokens issued by that authorization.
    expect((await exchange(code ?? "", verifier)).status).not.toBe(200);
  } finally {
    await server?.stop(true);
    if (previousBase === undefined) delete process.env["FACTORY_BASE_URL"];
    else process.env["FACTORY_BASE_URL"] = previousBase;
    await database.client.end();
    await fixture.dispose();
  }
}, 60_000);
