import { expect, test } from "bun:test";
import { createFactoryAuth } from "../../packages/auth/src/server";
import { factoryMCPResource } from "../../packages/auth/src/mcp-registration";
import { factoryProcess } from "../fixtures/factory-process";

test("native MCP OAuth registers a public PKCE client without changing the Forgejo identity", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const previous = process.env["FACTORY_BASE_URL"];
  process.env["FACTORY_BASE_URL"] = fixture.base;
  const identity = createFactoryAuth(database);
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await identity.bootstrap();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(fixture.base).port),
      fetch: (request) => identity.auth.handler(request),
    });
    const callback = "http://127.0.0.1:39999/callback";
    const registered = await fetch(`${fixture.base}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Owned MCP client",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as {
      client_id: string;
      client_secret?: string;
      require_pkce?: boolean;
    };
    expect(client.client_id).toStartWith("factory-mcp-");
    expect(client.client_secret).toBeUndefined();
    const [record] = await database.client<
      { pkce: boolean | null; method: string }[]
    >`SELECT "requirePKCE" AS pkce,"tokenEndpointAuthMethod" AS method FROM auth."oauthClient" WHERE "clientId"=${client.client_id}`;
    expect(record?.method).toBe("none");
    // Native public-client policy requires PKCE even when the optional stored flag is NULL.
    expect(record?.pkce).not.toBe(false);
    const forbidden = await fetch(`${fixture.base}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(forbidden.status).toBe(404);
    const invalid = await fetch(`${fixture.base}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://169.254.169.254/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(invalid.status).toBe(400);
    const password = "owned-mcp-developer-password";
    const user = await identity.createManagedUser({
      name: "Owned MCP developer",
      email: `${crypto.randomUUID()}@factory.invalid`,
      password,
    });
    if (!user) throw new Error("Owned MCP user creation failed");
    const projectID = crypto.randomUUID();
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`mcp-auth-${projectID}`},'Owned MCP OAuth','https://example.invalid/project.git','main','.devcontainer/devcontainer.json',${user.id})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${user.id},'developer',${user.id})`;
    const login = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const authorization = new URL(`${fixture.base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: callback,
      scope: "factory:read factory:work offline_access",
      resource: factoryMCPResource(fixture.base),
      state: "owned-mcp-state",
      code_challenge_method: "S256",
      code_challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
    }))
      authorization.searchParams.set(key, value);
    const missingPKCE = new URL(authorization);
    missingPKCE.searchParams.delete("code_challenge");
    missingPKCE.searchParams.delete("code_challenge_method");
    const rejected = await fetch(missingPKCE, { headers: { cookie }, redirect: "manual" });
    expect([302, 400]).toContain(rejected.status);
    if (rejected.status === 302) {
      const redirect = new URL(rejected.headers.get("location") ?? "", fixture.base);
      expect(redirect.searchParams.get("error")).toBe("invalid_request");
      expect(redirect.searchParams.get("code")).toBeNull();
    } else {
      const failure = (await rejected.json()) as { error?: string };
      expect(failure.error).toBe("invalid_request");
    }
    const prompted = await fetch(authorization, { headers: { cookie }, redirect: "manual" });
    expect(prompted.status).toBe(302);
    const consentURL = new URL(prompted.headers.get("location") ?? "", fixture.base);
    expect(consentURL.origin).toBe(fixture.base);
    const consent = await identity.mcpConsent(
      new Request(fixture.base, { headers: { cookie } }),
      consentURL.search.slice(1),
      true,
      true,
    );
    const result = new URL(consent.url);
    expect(result.searchParams.get("state")).toBe("owned-mcp-state");
    const code = result.searchParams.get("code");
    if (!code) throw new Error("No code from explicitly approved OAuth consent");
    const exchange = await fetch(`${fixture.base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: factoryMCPResource(fixture.base),
      }),
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json()) as { access_token: string; refresh_token: string };
    expect(typeof token.refresh_token).toBe("string");
    const request = new Request(factoryMCPResource(fixture.base), {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const authenticated = await identity.mcpSession(request);
    expect(authenticated.userID).toBe(user.id);
    expect(authenticated.clientID).toBe(client.client_id);
    expect(authenticated.scopes).toContain("factory:work");
    await database.client`UPDATE auth."oauthConsent" SET scopes=ARRAY['factory:read']::text[] WHERE "clientId"=${client.client_id} AND "userId"=${user.id}`;
    expect((await identity.mcpSession(request)).scopes).not.toContain("factory:work");
    await database.client`DELETE FROM auth."oauthConsent" WHERE "clientId"=${client.client_id} AND "userId"=${user.id}`;
    await expect(identity.mcpSession(request)).rejects.toThrow("revoked");
  } finally {
    await server?.stop(true);
    await database.client.end({ timeout: 2 });
    await fixture.dispose();
    if (previous === undefined) delete process.env["FACTORY_BASE_URL"];
    else process.env["FACTORY_BASE_URL"] = previous;
  }
}, 30000);
