import {
  checkResourceAllowed,
  type FetchLike,
  type OAuthClientProvider,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/client";
import { and, eq, sql as expression, inArray, ne } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { CommandError } from "../command-error";
import {
  assertConnectionActive,
  completeOperation,
  type MCPConnectionContext,
  markConnectionReconnect,
} from "./connection-state";
import { createRemoteMCP } from "./remote";
import { persistMaterial, readMaterial } from "./secret-store";

async function startTokenRefresh(ctx: MCPConnectionContext, id: string, epoch: string) {
  const candidateId = crypto.randomUUID();
  await ctx.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const current = await ctx.library.connectionIn(sql, id);
    assertConnectionActive(current, epoch);
    const [pending] = await db
      .select({ id: operation.id })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "mcp.token_refresh"),
          eq(operation.scopeType, "connection"),
          eq(operation.scopeId, id),
          expression<boolean>`${operation.payload}->>'credentialEpoch' = ${epoch}`,
          inArray(operation.state, ["intended", "uncertain"]),
        ),
      );
    if (pending)
      throw new CommandError(
        "conflict",
        "MCP token renewal is pending or uncertain. Reconnect in Settings",
      );
    await db.insert(operation).values({
      id: candidateId,
      kind: "mcp.token_refresh",
      scopeType: "connection",
      scopeId: id,
      activeKey: `mcp.token_refresh:${id}`,
      state: "intended",
      payload: { credentialEpoch: epoch },
      createdBy: current.authorizedBy,
    });
  });
  return candidateId;
}

async function createOAuthProvider(
  ctx: MCPConnectionContext,
  id: string,
  epoch: string,
  beforeRequest: () => Promise<void>,
  state?: string,
) {
  let data = await readMaterial(ctx, id, epoch);
  let redirect: string | undefined;
  let refreshId: string | undefined;

  async function abandonRefresh() {
    const pending = refreshId;
    refreshId = undefined;
    if (!pending) return;
    await ctx.database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const changed = await completeOperation(
        db,
        and(
          eq(operation.id, pending),
          eq(operation.kind, "mcp.token_refresh"),
          ne(operation.state, "committed"),
        ),
        "uncertain",
        { clearActiveKey: true },
      );
      if (changed.length) await markConnectionReconnect(db, id, epoch);
    });
  }

  const save = async () => persistMaterial(ctx, id, data, epoch);
  const provider: OAuthClientProvider = {
    redirectUrl: ctx.callback,
    clientMetadata: {
      client_name: "Factory",
      redirect_uris: [ctx.callback],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    },
    state: () => {
      if (!state) throw new CommandError("conflict", "Reconnect this MCP connection in Settings");
      return state;
    },
    clientInformation: (context) => (context ? data.clients?.[context.issuer] : undefined),
    saveClientInformation: async (info, context) => {
      if (!context) throw new Error("OAuth client registration is missing its issuer");
      data = { ...data, clients: { ...data.clients, [context.issuer]: info } };
      await save();
    },
    tokens: (context) =>
      !context || data.tokens?.issuer === context.issuer ? data.tokens : undefined,
    saveTokens: async (tokens) => {
      if (data.tokens?.scope && tokens.scope) {
        const granted = new Set(data.tokens.scope.split(/\s+/).filter(Boolean));
        if (tokens.scope.split(/\s+/).some((scope) => scope && !granted.has(scope))) {
          if (refreshId)
            await completeOperation(
              ctx.database.db,
              and(eq(operation.id, refreshId), eq(operation.kind, "mcp.token_refresh")),
              "uncertain",
              { clearActiveKey: true, error: "OAuth permissions changed" },
            );
          await markConnectionReconnect(ctx.database.db, id, epoch);
          throw new CommandError(
            "forbidden",
            "OAuth permissions changed. Reconnect and review the connection in Settings",
          );
        }
      }
      data = { ...data, tokens };
      delete data.verifier;
      await persistMaterial(ctx, id, data, epoch, refreshId);
      refreshId = undefined;
    },
    redirectToAuthorization: (url) => {
      if (!state) throw new CommandError("conflict", "Reconnect this MCP connection in Settings");
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("OAuth authorization requires a secure URL");
      redirect = url.href;
    },
    saveCodeVerifier: async (verifier) => {
      data = { ...data, verifier };
      await save();
    },
    codeVerifier: () => {
      if (!data.verifier) throw new CommandError("conflict", "OAuth authorization has expired");
      return data.verifier;
    },
    saveDiscoveryState: async (discovery) => {
      data = { ...data, discovery };
      await save();
    },
    discoveryState: () => data.discovery,
    validateResourceURL: async (endpoint, resource) => {
      const expected = resourceUrlFromServerUrl(endpoint);
      if (
        resource &&
        !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })
      )
        throw new Error("OAuth resource does not match the MCP endpoint");
      return expected;
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "tokens") delete data.tokens;
      if (scope === "all" || scope === "client") delete data.clients;
      if (scope === "all" || scope === "verifier") delete data.verifier;
      if (scope === "all" || scope === "discovery") delete data.discovery;
      await save();
    },
  };

  const guardedFetch: FetchLike = async (input, options) => {
    await beforeRequest();
    const request = new Request(input instanceof URL ? input.href : input, options);
    const registrationEndpoint = data.discovery?.authorizationServerMetadata?.registration_endpoint;
    if (
      !state &&
      request.method === "POST" &&
      registrationEndpoint &&
      request.url === new URL(registrationEndpoint).href
    ) {
      const registration: unknown = await request
        .clone()
        .json()
        .catch(() => null);
      if (
        registration &&
        typeof registration === "object" &&
        "client_name" in registration &&
        registration.client_name === "Factory" &&
        "redirect_uris" in registration
      ) {
        await markConnectionReconnect(ctx.database.db, id, epoch);
        throw new CommandError(
          "conflict",
          "OAuth client registration changed. Reconnect explicitly in Settings",
        );
      }
    }
    if (request.method === "POST") {
      const body = await request.clone().text();
      if (new URLSearchParams(body).get("grant_type") === "refresh_token")
        refreshId = await startTokenRefresh(ctx, id, epoch);
    }
    try {
      const response = await ctx.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        redirect: "error",
        ...(request.body ? { body: await request.text() } : {}),
      });
      if (!response.ok && refreshId) await abandonRefresh();
      return response;
    } catch (cause) {
      await abandonRefresh();
      throw cause;
    }
  };
  return { provider, fetch: guardedFetch, redirect: () => redirect, abandonRefresh };
}

export async function createRemoteConnection(
  ctx: MCPConnectionContext,
  id: string,
  state: string | undefined,
  expectedEpoch: string,
  beforeRequest?: () => Promise<void>,
  signal?: AbortSignal,
) {
  const connection = await ctx.database.client.begin((sql) => ctx.library.connectionIn(sql, id));
  assertConnectionActive(connection, expectedEpoch);
  const guard =
    beforeRequest ??
    (() =>
      ctx.database.client.begin(async (sql) => {
        await ctx.library.authorizeIn(sql, id, connection.authorizedBy);
        const current = await ctx.library.connectionIn(sql, id);
        assertConnectionActive(current, expectedEpoch);
      }));
  const revision = await ctx.database.client.begin((sql) =>
    ctx.library.revisionIn(sql, connection.revisionId),
  );
  if (revision.content.authentication === "oauth") {
    const oauth = await createOAuthProvider(ctx, id, connection.credentialEpoch, guard, state);
    const client = createRemoteMCP(revision.content.endpoint, oauth.provider, oauth.fetch, signal);
    return {
      ...client,
      close: async () => {
        try {
          await client.close();
        } finally {
          await oauth.abandonRefresh();
        }
      },
      redirect: oauth.redirect,
    };
  }
  const data = await readMaterial(ctx, id, connection.credentialEpoch);
  return {
    ...createRemoteMCP(
      revision.content.endpoint,
      revision.content.authentication === "bearer" ? { token: async () => data.bearer } : undefined,
      async (url, init) => {
        await guard();
        return ctx.fetcher(url, init);
      },
      signal,
    ),
    redirect: () => undefined,
  };
}
