import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import type { MCPSecret } from "../../apps/factory/src/mcp/secrets";
import { factoryProcess } from "../fixtures/factory-process";

test("MCP OAuth binds callbacks, refreshes and recovers stored tokens without replay, and rejects scope widening", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const manager = crypto.randomUUID();
  const other = crypto.randomUUID();
  const id = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const project = crypto.randomUUID();
  const secret = new Map<string, MCPSecret>();
  let exchanges = 0;
  let refreshes = 0;
  let expired = false;
  let loseRenewalWrite = false;
  let broadenScope = false;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "Owned OAuth source", version: "1" });
    server.registerTool(
      "read",
      { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => ({
        content: [{ type: "text", text: "Owned OAuth read" }],
      }),
    );
    return server;
  });
  let challenge = "";
  const connections = createMCPConnections(
    database,
    {
      configured: true,
      read: async (key) => secret.get(key),
      create: async (key, value) => {
        secret.set(key, value);
        const tokens = value.material["tokens"];
        if (
          loseRenewalWrite &&
          tokens &&
          typeof tokens === "object" &&
          "access_token" in tokens &&
          tokens.access_token === "owned-access-renewed-2"
        ) {
          loseRenewalWrite = false;
          throw new Error("Lost owned credential-write acknowledgement");
        }
      },
    },
    "owned-oauth-key",
    "https://factory.example",
    async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const reply = (value: unknown) => Response.json(value);
      if (url.pathname.includes("oauth-protected-resource"))
        return reply({
          resource: "https://source.example",
          authorization_servers: ["https://auth.source.example"],
        });
      if (url.pathname.includes("oauth-authorization-server"))
        return reply({
          issuer: "https://auth.source.example",
          authorization_endpoint: "https://auth.source.example/authorize",
          token_endpoint: "https://auth.source.example/token",
          registration_endpoint: "https://auth.source.example/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      if (url.pathname === "/register")
        return reply({
          ...((await request.json()) as object),
          client_id: "owned-client",
        });
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "authorization_code") {
          exchanges++;
          expect(body.get("redirect_uri")).toBe("https://factory.example/api/mcp/oauth/callback");
          expect(body.get("resource")).toBe("https://source.example/mcp");
          expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
            challenge,
          );
          return reply({
            access_token: "owned-access",
            token_type: "Bearer",
            refresh_token: "owned-refresh",
            expires_in: 3600,
            scope: "read",
          });
        }
        refreshes++;
        expect(body.get("refresh_token")).toBe(
          refreshes === 1 ? "owned-refresh" : `owned-refresh-rotated-${refreshes - 1}`,
        );
        expired = false;
        return reply({
          access_token: `owned-access-renewed-${refreshes}`,
          token_type: "Bearer",
          refresh_token: `owned-refresh-rotated-${refreshes}`,
          expires_in: 3600,
          scope: broadenScope ? "read write" : "read",
        });
      }
      if (url.pathname === "/mcp") {
        const bearer = request.headers.get("authorization");
        if (
          !bearer ||
          expired ||
          bearer !==
            (refreshes ? `Bearer owned-access-renewed-${refreshes}` : "Bearer owned-access")
        )
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://source.example/.well-known/oauth-protected-resource"',
            },
          });
        return handler.fetch(request);
      }
      return new Response(null, { status: 404 });
    },
  );
  try {
    for (const userId of [manager, other])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userId},'Owned OAuth account',${`${userId}@oauth.test`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    await connections.library.save(
      {
        libraryId: id,
        revisionId,
        expectedRevision: 0,
        scope: "personal",
        content: {
          name: "Owned OAuth",
          description: "Owned fixture",
          endpoint: "https://source.example/mcp",
          provider: "custom",
          authentication: "oauth",
          roles: ["planning"],
        },
      },
      manager,
    );
    const command = { commandId: crypto.randomUUID(), revisionId, expectedVersion: 0 };
    const result = await connections.connect(id, manager, command);
    expect(result.authorizationUrl).not.toBeNull();
    const redirect = new URL(result.authorizationUrl!);
    expect(redirect.origin).toBe("https://auth.source.example");
    challenge = redirect.searchParams.get("code_challenge")!;
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    const params = new URLSearchParams({
      state: redirect.searchParams.get("state")!,
      code: "owned-code",
      iss: "https://auth.source.example",
    });
    await expect(connections.callback(other, params)).rejects.toThrow("another session");
    expect(exchanges).toBe(0);
    expect(await connections.callback(manager, params)).toEqual({ connected: true });
    expect(exchanges).toBe(1);
    await expect(connections.callback(manager, params)).rejects.toThrow();
    expect(exchanges).toBe(1);
    const view = await connections.library.view(manager);
    expect(view.entries[0]?.connection?.state).toBe("review");
    expect(JSON.stringify(view)).not.toContain("owned-access");
    expect(JSON.stringify(view)).not.toContain("owned-refresh");
    expect(secret.size).toBeGreaterThan(3);
    const [row] = await database.client<
      Array<{ count: number }>
    >`SELECT count(*)::float8 AS count FROM factory.mcp_secret_write WHERE state='committed'`;
    expect(row?.count).toBe(secret.size);
    expect(refreshes).toBe(0);
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`oauth-${project}`},'Owned OAuth Project','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
    const connection = await database.client.begin((sql) =>
      connections.library.connectionIn(sql, id),
    );
    const tool = connection.tools[0]!;
    await connections.library.review(id, manager, connection.version, [
      { name: tool.name, digest: tool.digest },
    ]);
    const read = () =>
      connections.call(
        {
          connectionId: id,
          credentialEpoch: connection.credentialEpoch,
          revisionId,
          policyVersion: connection.version + 1,
          tools: [tool],
          required: true,
        },
        project,
        manager,
        "read",
        {},
        async () => {},
        new AbortController().signal,
      );
    expired = true;
    expect(
      await connections.call(
        {
          connectionId: id,
          credentialEpoch: connection.credentialEpoch,
          revisionId,
          policyVersion: connection.version + 1,
          tools: [tool],
          required: true,
        },
        project,
        manager,
        "read",
        {},
        async () => {},
        new AbortController().signal,
      ),
    ).toEqual({
      content: "Owned OAuth read",
      isError: false,
    });
    expect(refreshes).toBe(1);
    const [renewal] =
      await database.client`SELECT state FROM factory.mcp_token_refresh WHERE connection_id=${id}`;
    expect(renewal?.["state"]).toBe("committed");
    expired = true;
    loseRenewalWrite = true;
    await expect(read()).rejects.toThrow();
    expect(refreshes).toBe(2);
    expect(
      (await database.client.begin((sql) => connections.library.connectionIn(sql, id))).state,
    ).toBe("reconnect");
    await connections.recover();
    expect(
      (await database.client.begin((sql) => connections.library.connectionIn(sql, id))).state,
    ).toBe("ready");
    expect(await read()).toEqual({ content: "Owned OAuth read", isError: false });
    expect(refreshes).toBe(2);
    expired = true;
    broadenScope = true;
    await expect(read()).rejects.toThrow();
    expect(refreshes).toBe(3);
    await connections.recover();
    expect(
      (await database.client.begin((sql) => connections.library.connectionIn(sql, id))).state,
    ).toBe("reconnect");
  } finally {
    await handler.close();
    await database.client.end();
    await fixture.dispose();
  }
});
