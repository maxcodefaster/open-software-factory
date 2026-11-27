import { expect, spyOn, test } from "bun:test";
import {
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ownedMCPAuthProvider } from "../fixtures/mcp-authorization";

const grant = {
  clientID: "owned-registered-client",
  accessToken: "owned-access-original",
  refreshToken: "owned-refresh-original",
  issuer: "http://127.0.0.1",
};
const rotated = {
  access_token: "owned-access-rotated",
  refresh_token: "owned-refresh-rotated",
  token_type: "Bearer",
  expires_in: 300,
  scope: "factory:read factory:work offline_access",
};
const deliberateTool = {
  name: "deliberateEffect",
  arguments: { requestID: "owned-deliberate-operation" },
};
const explicitConsent = "Owned MCP authorization needs a new explicit consent";

function consentSpies(provider: OAuthClientProvider) {
  return [
    spyOn(provider, "redirectToAuthorization"),
    spyOn(provider, "codeVerifier"),
    spyOn(provider, "saveCodeVerifier"),
  ];
}

function ownedOAuthSource(refreshFailure?: "invalid_grant" | "server_error") {
  const events: string[] = [];
  const refreshes: Array<Record<string, string>> = [];
  const unexpected: string[] = [];
  const effects: string[] = [];
  const toolRequests: Array<{
    bearer: string | null;
    authorized: boolean;
    effectsBefore: number;
    message: unknown;
  }> = [];
  let validAccess = grant.accessToken;
  let base = "";
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "Owned refresh regression", version: "1.0.0" });
    mcp.registerTool(
      deliberateTool.name,
      {
        inputSchema: z.object({ requestID: z.string() }),
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      async ({ requestID }) => {
        // Record every dispatch, without deduplication that could hide a replay.
        effects.push(requestID);
        events.push("effect");
        return { content: [{ type: "text", text: requestID }] };
      },
    );
    return mcp;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/.well-known/oauth-protected-resource") {
        events.push("resource-metadata");
        return Response.json({
          resource: `${base}/api/mcp`,
          authorization_servers: [base],
          scopes_supported: ["factory:read", "factory:work"],
        });
      }
      if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") {
        events.push("authorization-metadata");
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/api/auth/oauth2/authorize`,
          token_endpoint: `${base}/api/auth/oauth2/token`,
          registration_endpoint: `${base}/api/auth/mcp/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["factory:read", "factory:work", "offline_access"],
        });
      }
      if (request.method === "POST" && path === "/api/auth/oauth2/token") {
        events.push("refresh");
        const body = new URLSearchParams(await request.text());
        refreshes.push(Object.fromEntries(body));
        if (refreshFailure)
          return Response.json(
            { error: refreshFailure, error_description: "Owned refresh refused" },
            { status: refreshFailure === "server_error" ? 500 : 400 },
          );
        if (
          body.get("grant_type") !== "refresh_token" ||
          body.get("client_id") !== grant.clientID ||
          body.get("refresh_token") !== grant.refreshToken
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        validAccess = rotated.access_token;
        return Response.json(rotated);
      }
      if (path === "/api/mcp") {
        const bearer = request.headers.get("authorization");
        const authorized = bearer === `Bearer ${validAccess}`;
        if (request.method === "POST") {
          const message = (await request.clone().json()) as { method?: string };
          if (message.method === "tools/call")
            toolRequests.push({ bearer, authorized, effectsBefore: effects.length, message });
        }
        // Reject before the native handler can instantiate or dispatch a tool.
        if (!authorized) {
          events.push("401");
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            },
          });
        }
        return handler.fetch(request);
      }
      unexpected.push(`${request.method} ${path}`);
      return new Response("No replacement registration or consent in this fixture", {
        status: 404,
      });
    },
  });
  base = server.url.origin;
  const client = new Client({ name: "owned-refresh-client", version: "1.0.0" });
  return {
    client,
    endpoint: new URL(`${base}/api/mcp`),
    events,
    refreshes,
    unexpected,
    effects,
    toolRequests,
    expire() {
      // Controlled server-side invalidation, not a shorter product token lifetime or a timer.
      validAccess = "owned-invalidated-access";
    },
    async dispose() {
      try {
        await client.close();
      } finally {
        try {
          await handler.close();
        } finally {
          await server.stop(true);
        }
      }
    },
  };
}

test("static requestInit Bearer reproduces post-expiry 401 without dispatch or hidden auth", async () => {
  const source = ownedOAuthSource();
  try {
    await source.client.connect(
      new StreamableHTTPClientTransport(source.endpoint, {
        requestInit: { headers: { authorization: `Bearer ${grant.accessToken}` } },
      }),
      { timeout: 2_000 },
    );
    await source.client.listTools();
    expect(source.events).toEqual([]);
    source.expire();

    await expect(source.client.callTool(deliberateTool, { timeout: 2_000 })).rejects.toMatchObject({
      status: 401,
    });
    expect(source.toolRequests).toEqual([
      {
        bearer: `Bearer ${grant.accessToken}`,
        authorized: false,
        effectsBefore: 0,
        message: expect.objectContaining({
          method: "tools/call",
          params: expect.objectContaining(deliberateTool),
        }),
      },
    ]);
    expect(source.events).toEqual(["401"]);
    expect(source.effects).toEqual([]);
    expect(source.refreshes).toEqual([]);
    expect(source.unexpected).toEqual([]);
  } finally {
    await source.dispose();
  }
});

test("owned SDK auth refreshes the same registration after 401 and dispatches the deliberate tool once", async () => {
  const source = ownedOAuthSource();
  const provider: OAuthClientProvider = ownedMCPAuthProvider({
    ...grant,
    issuer: source.endpoint.origin,
  });
  const consent = consentSpies(provider);
  try {
    expect(await provider.clientInformation()).toMatchObject({
      client_id: grant.clientID,
      issuer: source.endpoint.origin,
    });
    expect(await provider.tokens()).toMatchObject({
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      token_type: "Bearer",
      issuer: source.endpoint.origin,
    });
    await source.client.connect(
      new StreamableHTTPClientTransport(source.endpoint, { authProvider: provider }),
      { timeout: 2_000 },
    );
    await source.client.listTools();
    expect(source.events).toEqual([]);
    source.expire();

    const result = await source.client.callTool(deliberateTool, { timeout: 2_000 });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: deliberateTool.arguments.requestID }]);
    expect(source.events).toEqual([
      "401",
      "resource-metadata",
      "authorization-metadata",
      "refresh",
      "effect",
    ]);
    expect(source.refreshes).toEqual([
      {
        grant_type: "refresh_token",
        client_id: grant.clientID,
        refresh_token: grant.refreshToken,
        resource: source.endpoint.href,
      },
    ]);
    expect(source.toolRequests).toHaveLength(2);
    expect(source.toolRequests[0]).toMatchObject({
      bearer: `Bearer ${grant.accessToken}`,
      authorized: false,
      effectsBefore: 0,
    });
    expect(source.toolRequests[1]).toEqual({
      bearer: `Bearer ${rotated.access_token}`,
      authorized: true,
      effectsBefore: 0,
      message: source.toolRequests[0]?.message,
    });
    expect(source.effects).toEqual([deliberateTool.arguments.requestID]);
    expect(await provider.tokens()).toMatchObject(rotated);
    expect(await provider.clientInformation()).toMatchObject({ client_id: grant.clientID });

    // A real subsequent request must read the stored access token, not replay the tool.
    await source.client.listTools(undefined, { cacheMode: "bypass", timeout: 2_000 });
    expect(source.events).toEqual([
      "401",
      "resource-metadata",
      "authorization-metadata",
      "refresh",
      "effect",
    ]);
    expect(source.effects).toEqual([deliberateTool.arguments.requestID]);
    expect(source.unexpected).toEqual([]);
    for (const method of consent) expect(method).not.toHaveBeenCalled();
  } finally {
    for (const method of consent) method.mockRestore();
    await source.dispose();
  }
});

test.each(["invalid_grant", "server_error"] as const)(
  "owned SDK refresh %s remains a failure without a replacement grant or tool effect",
  async (failure) => {
    const source = ownedOAuthSource(failure);
    const provider = ownedMCPAuthProvider({ ...grant, issuer: source.endpoint.origin });
    const consent = consentSpies(provider);
    try {
      await source.client.connect(
        new StreamableHTTPClientTransport(source.endpoint, { authProvider: provider }),
        { timeout: 2_000 },
      );
      await source.client.listTools();
      source.expire();

      const call = source.client.callTool(deliberateTool, { timeout: 2_000 });
      if (failure === "invalid_grant")
        await expect(call).rejects.toMatchObject({ code: "invalid_grant" });
      else await expect(call).rejects.toThrow(explicitConsent);
      // SDK 2.4 retries invalid_grant once; no fixture-owned refresh loop.
      expect(source.refreshes).toHaveLength(failure === "invalid_grant" ? 2 : 1);
      for (const request of source.refreshes)
        expect(request).toEqual({
          grant_type: "refresh_token",
          client_id: grant.clientID,
          refresh_token: grant.refreshToken,
          resource: source.endpoint.href,
        });
      expect(source.toolRequests).toHaveLength(1);
      expect(source.toolRequests[0]).toMatchObject({
        bearer: `Bearer ${grant.accessToken}`,
        authorized: false,
        effectsBefore: 0,
      });
      expect(source.effects).toEqual([]);
      expect(source.unexpected).toEqual([]);
      expect(await provider.clientInformation()).toMatchObject({ client_id: grant.clientID });
      expect(await provider.tokens()).toMatchObject({
        access_token: grant.accessToken,
        refresh_token: grant.refreshToken,
      });
      expect(consent.map((method) => method.mock.calls.length)).toEqual([
        0,
        0,
        failure === "server_error" ? 1 : 0,
      ]);
    } finally {
      for (const method of consent) method.mockRestore();
      await source.dispose();
    }
  },
);

test("owned provider refuses every new-consent entrypoint and retains its explicit grant", async () => {
  const provider = ownedMCPAuthProvider(grant);
  const before = await provider.tokens();
  expect(provider.redirectUrl).toBe("http://127.0.0.1:39999/owned-mcp-callback");
  await expect(
    Promise.resolve().then(() =>
      provider.redirectToAuthorization(new URL("http://127.0.0.1/owned-authorize")),
    ),
  ).rejects.toThrow(explicitConsent);
  await expect(
    Promise.resolve().then(() => provider.saveCodeVerifier("owned-new-verifier")),
  ).rejects.toThrow(explicitConsent);
  await expect(Promise.resolve().then(() => provider.codeVerifier())).rejects.toThrow(
    explicitConsent,
  );
  expect(await provider.tokens()).toEqual(before);
  expect(await provider.clientInformation()).toMatchObject({ client_id: grant.clientID });
});

test("owned SDK refuses credentials stamped for another issuer before refresh or tool dispatch", async () => {
  const source = ownedOAuthSource();
  const provider = ownedMCPAuthProvider({
    ...grant,
    accessToken: "owned-invalid-issuer-probe",
    issuer: "http://127.0.0.1:1/foreign",
  });
  try {
    await expect(
      source.client.connect(
        new StreamableHTTPClientTransport(source.endpoint, { authProvider: provider }),
        { timeout: 2_000 },
      ),
    ).rejects.toThrow();
    expect(source.refreshes).toEqual([]);
    expect(source.effects).toEqual([]);
    expect(source.unexpected).toEqual([]);
  } finally {
    await source.dispose();
  }
});
