import { createHmac, randomBytes } from "node:crypto";
import {
  UnauthorizedError,
  checkResourceAllowed,
  resourceUrlFromServerUrl,
  type FetchLike,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  mcpConnectInput,
  type MCPAssignment,
} from "../../../../packages/conversation-domain/src/mcp-library";
import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { canonicalMCPJSON, createMCPLibrary, mcpDigest } from "./controller";
import { secureMCPFetch } from "./network";
import { createRemoteMCP } from "./remote";
import type { MCPSecrets } from "./secrets";

type Material = {
  bearer?: string;
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: StoredOAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
};
type Write = {
  id: string;
  connectionId: string;
  baseKey: string | null;
  credentialEpoch: string;
  secretKey: string;
  digest: string;
  state: string;
};
export function createMCPConnections(
  database: ReturnType<typeof createDatabase>,
  secrets: MCPSecrets,
  signingKey: string,
  factoryOrigin: string,
  fetcher: FetchLike = secureMCPFetch,
) {
  const library = createMCPLibrary(database);
  const fingerprint = (value: unknown) =>
    createHmac("sha256", signingKey).update(canonicalMCPJSON(value)).digest("hex");
  const callback = new URL("/api/mcp/oauth/callback", factoryOrigin).href;
  async function material(id: string, epoch?: string): Promise<Material> {
    const connection = await database.client.begin((sql) => library.connectionIn(sql, id));
    if (epoch && connection.credentialEpoch !== epoch)
      throw new CommandError("conflict", "MCP authorization was replaced");
    if (connection.state === "revoked")
      throw new CommandError("forbidden", "MCP connection was disconnected");
    if (!connection.secretKey) return {};
    const stored = await secrets.read(connection.secretKey);
    if (!stored || stored.connectionId !== id || fingerprint(stored.material) !== stored.digest)
      throw new CommandError("unavailable", "The MCP credential is unavailable");
    return stored.material as Material;
  }
  async function settle(write: Write) {
    const stored = await secrets.read(write.secretKey);
    if (!stored) return false;
    if (
      stored.connectionId !== write.connectionId ||
      stored.commandId !== write.id ||
      stored.digest !== write.digest ||
      fingerprint(stored.material) !== write.digest
    )
      throw new CommandError("unavailable", "MCP secret does not match its durable write intent");
    const committed = await database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-secret:${write.connectionId}`}))`;
      const [current] =
        await sql`SELECT state FROM factory.mcp_secret_write WHERE id=${write.id} FOR UPDATE`;
      if (current?.["state"] !== "intended") return current?.["state"] === "committed";
      const [actor] = await sql<
        Array<{ id: string }>
      >`SELECT authorized_by AS id FROM factory.mcp_connection WHERE id=${write.connectionId}`;
      try {
        if (!actor) throw new CommandError("not-found", "MCP connection not found");
        await library.authorizeIn(sql, write.connectionId, actor.id);
      } catch (cause) {
        if (!(cause instanceof CommandError) || !["forbidden", "not-found"].includes(cause.code))
          throw cause;
        await sql`UPDATE factory.mcp_secret_write SET state='superseded' WHERE id=${write.id}`;
        return false;
      }
      const updated =
        await sql`UPDATE factory.mcp_connection SET secret_key=${write.secretKey},updated_at=now()
        WHERE id=${write.connectionId} AND secret_key IS NOT DISTINCT FROM ${write.baseKey}
        AND credential_epoch=${write.credentialEpoch} AND state != 'revoked' RETURNING id`;
      await sql`UPDATE factory.mcp_secret_write SET state=${updated.length ? "committed" : "superseded"} WHERE id=${write.id}`;
      if (updated.length) {
        const renewed = await sql`UPDATE factory.mcp_token_refresh SET state='committed'
          WHERE id=${write.id} AND connection_id=${write.connectionId} AND credential_epoch=${write.credentialEpoch} RETURNING id`;
        if (renewed.length)
          await sql`UPDATE factory.mcp_connection SET state='ready' WHERE id=${write.connectionId}
            AND credential_epoch=${write.credentialEpoch} AND state='reconnect' AND jsonb_array_length(allowed_tools)>0`;
      }
      return updated.length > 0;
    });
    if (!committed)
      throw new CommandError("conflict", "MCP credentials changed or were disconnected");
    return true;
  }
  async function persist(
    id: string,
    value: Material,
    epoch: string,
    commandId: string = crypto.randomUUID(),
  ) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 131072)
      throw new CommandError("conflict", "MCP authorization metadata exceeds its storage limit");
    const snapshot = JSON.parse(encoded) as Material;
    const digest = fingerprint(snapshot);
    const write = await database.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-secret:${id}`}))`;
      const connection = await library.connectionIn(sql, id);
      if (connection.state === "revoked" || connection.credentialEpoch !== epoch)
        throw new CommandError("forbidden", "MCP connection was disconnected or replaced");
      const [pending] =
        await sql`SELECT id FROM factory.mcp_secret_write WHERE connection_id=${id} AND state='intended'`;
      if (pending) throw new CommandError("conflict", "An MCP credential write needs recovery");
      const secretKey = `mcp/${id}/${commandId}`;
      await sql`INSERT INTO factory.mcp_secret_write(id,connection_id,base_key,credential_epoch,secret_key,digest,state)
        VALUES(${commandId},${id},${connection.secretKey},${epoch},${secretKey},${digest},'intended')`;
      return {
        id: commandId,
        connectionId: id,
        baseKey: connection.secretKey,
        credentialEpoch: epoch,
        secretKey,
        digest,
        state: "intended",
      };
    });
    await secrets.create(write.secretKey, {
      commandId,
      connectionId: id,
      digest,
      material: snapshot,
    });
    await settle(write);
  }
  async function oauthProvider(
    id: string,
    epoch: string,
    beforeRequest: () => Promise<void>,
    state?: string,
  ) {
    let data = await material(id, epoch);
    let redirect: string | undefined;
    let refreshId: string | undefined;
    async function abandonRefresh() {
      const pending = refreshId;
      refreshId = undefined;
      if (!pending) return;
      await database.client.begin(async (sql) => {
        const changed = await sql`UPDATE factory.mcp_token_refresh SET state='uncertain'
          WHERE id=${pending} AND state!='committed' RETURNING id`;
        if (changed.length)
          await sql`UPDATE factory.mcp_connection SET state='reconnect'
            WHERE id=${id} AND credential_epoch=${epoch} AND state!='revoked'`;
      });
    }
    const save = async () => persist(id, data, epoch);
    const provider: OAuthClientProvider = {
      redirectUrl: callback,
      clientMetadata: {
        client_name: "Factory",
        redirect_uris: [callback],
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
              await database.client`UPDATE factory.mcp_token_refresh SET state='uncertain' WHERE id=${refreshId}`;
            await database.client`UPDATE factory.mcp_connection SET state='reconnect'
              WHERE id=${id} AND credential_epoch=${epoch} AND state!='revoked'`;
            throw new CommandError(
              "forbidden",
              "OAuth permissions changed. Reconnect and review the connection in Settings",
            );
          }
        }
        data = { ...data, tokens };
        delete data.verifier;
        await persist(id, data, epoch, refreshId);
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
      const registrationEndpoint =
        data.discovery?.authorizationServerMetadata?.registration_endpoint;
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
          await database.client`UPDATE factory.mcp_connection SET state='reconnect'
            WHERE id=${id} AND credential_epoch=${epoch} AND state!='revoked'`;
          throw new CommandError(
            "conflict",
            "OAuth client registration changed. Reconnect explicitly in Settings",
          );
        }
      }
      if (request.method === "POST") {
        const body = await request.clone().text();
        if (new URLSearchParams(body).get("grant_type") === "refresh_token") {
          const candidateId = crypto.randomUUID();
          await database.client.begin(async (sql) => {
            const current = await library.connectionIn(sql, id);
            if (current.credentialEpoch !== epoch || current.state === "revoked")
              throw new CommandError("forbidden", "MCP authorization was replaced or disconnected");
            const [pending] =
              await sql`SELECT id FROM factory.mcp_token_refresh WHERE connection_id=${id} AND credential_epoch=${epoch} AND state IN ('intended','uncertain')`;
            if (pending)
              throw new CommandError(
                "conflict",
                "MCP token renewal is pending or uncertain. Reconnect in Settings",
              );
            await sql`INSERT INTO factory.mcp_token_refresh(id,connection_id,credential_epoch,state) VALUES(${candidateId},${id},${epoch},'intended')`;
          });
          refreshId = candidateId;
        }
      }
      try {
        const response = await fetcher(request.url, {
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
  async function remote(
    id: string,
    state: string | undefined,
    expectedEpoch: string,
    beforeRequest?: () => Promise<void>,
  ) {
    const connection = await database.client.begin((sql) => library.connectionIn(sql, id));
    if (connection.credentialEpoch !== expectedEpoch || connection.state === "revoked")
      throw new CommandError("forbidden", "MCP authorization was replaced or disconnected");
    const guard =
      beforeRequest ??
      (() =>
        database.client.begin(async (sql) => {
          await library.authorizeIn(sql, id, connection.authorizedBy);
          const current = await library.connectionIn(sql, id);
          if (current.credentialEpoch !== expectedEpoch || current.state === "revoked")
            throw new CommandError("forbidden", "MCP authorization was replaced or disconnected");
        }));
    const revision = await database.client.begin((sql) =>
      library.revisionIn(sql, connection.revisionId),
    );
    if (revision.content.authentication === "oauth") {
      const oauth = await oauthProvider(id, connection.credentialEpoch, guard, state);
      const client = createRemoteMCP(revision.content.endpoint, oauth.provider, oauth.fetch);
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
    const data = await material(id, connection.credentialEpoch);
    return {
      ...createRemoteMCP(
        revision.content.endpoint,
        revision.content.authentication === "bearer"
          ? { token: async () => data.bearer }
          : undefined,
        async (url, init) => {
          await guard();
          return fetcher(url, init);
        },
      ),
      redirect: () => undefined,
    };
  }
  const authorizeAssignment = (assignment: MCPAssignment, projectId: string, userId: string) =>
    database.client.begin(async (sql) => {
      const connection = await library.connectionIn(sql, assignment.connectionId);
      await library.usableIn(sql, connection, projectId, userId);
      if (
        connection.revisionId !== assignment.revisionId ||
        connection.credentialEpoch !== assignment.credentialEpoch ||
        assignment.tools.some(
          (selected) =>
            !connection.allowedTools.some(
              (tool) => tool.name === selected.name && tool.digest === selected.digest,
            ),
        )
      )
        throw new CommandError("forbidden", "MCP access was changed or revoked");
    });
  return {
    library,
    authorizeAssignment,
    async recover() {
      const writes = await database.client<
        Write[]
      >`SELECT id,connection_id AS "connectionId",base_key AS "baseKey",credential_epoch AS "credentialEpoch",
        secret_key AS "secretKey",digest,state FROM factory.mcp_secret_write WHERE state='intended'`;
      for (const write of writes) {
        try {
          await settle(write);
        } catch (cause) {
          if (
            !(cause instanceof CommandError) ||
            !["conflict", "forbidden", "not-found"].includes(cause.code)
          )
            throw cause;
        }
      }
      // Never replay an authorization-code exchange or rotating refresh after a
      // crash. A new explicit Connect creates a new authorization intent.
    },
    async connect(id: string, userId: string, value: unknown) {
      const input = mcpConnectInput.parse(value);
      const commandFingerprint = fingerprint({ id, userId, input });
      const admission = await database.client.begin(async (sql) => {
        await library.authorizeIn(sql, id, userId);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-connect:${id}`}))`;
        const [previous] =
          await sql`SELECT connection_id AS "connectionId",revision_id AS "revisionId",created_by AS "createdBy",fingerprint,
          state,authorization_url AS "authorizationUrl" FROM factory.mcp_connect_intent WHERE id=${input.commandId}`;
        if (previous) {
          if (
            previous["connectionId"] !== id ||
            previous["revisionId"] !== input.revisionId ||
            previous["createdBy"] !== userId ||
            previous["fingerprint"] !== commandFingerprint
          )
            throw new CommandError("conflict", "MCP command identity was reused");
          if (previous["state"] !== "completed")
            throw new CommandError(
              "conflict",
              "This connection attempt is incomplete. Start a new explicit connection",
            );
          const current = await library.connectionIn(sql, id);
          if (
            current.credentialEpoch !== input.commandId ||
            ["reconnect", "revoked"].includes(current.state)
          )
            throw new CommandError(
              "conflict",
              "This authorization was replaced or failed. Start a new explicit connection",
            );
          return {
            replay: true,
            authorizationUrl:
              current.state === "authorizing"
                ? (previous["authorizationUrl"] as string | null)
                : null,
            authentication: null,
          };
        }
        const revision = await library.revisionIn(sql, input.revisionId);
        if (revision.libraryId !== id)
          throw new CommandError("conflict", "MCP revision belongs to another entry");
        const [existing] =
          await sql`SELECT version::float8 AS version FROM factory.mcp_connection WHERE id=${id}`;
        if ((existing?.["version"] ?? 0) !== input.expectedVersion)
          throw new CommandError(
            "conflict",
            "The MCP connection changed. Reload before connecting",
          );
        if (revision.content.authentication === "bearer" && !input.token)
          throw new CommandError("conflict", "Enter the read-only access token");
        if (revision.content.authentication !== "bearer" && input.token)
          throw new CommandError("conflict", "This MCP connection does not accept a bearer token");
        await sql`INSERT INTO factory.mcp_connection(id,revision_id,state,authorized_by,credential_epoch)
          VALUES(${id},${input.revisionId},'authorizing',${userId},${input.commandId})
          ON CONFLICT(id) DO UPDATE SET revision_id=EXCLUDED.revision_id,state='authorizing',
            version=factory.mcp_connection.version+1,secret_key=NULL,tools='[]',allowed_tools='[]',
            authorized_by=EXCLUDED.authorized_by,credential_epoch=EXCLUDED.credential_epoch,updated_at=now()`;
        await sql`UPDATE factory.mcp_secret_write SET state='superseded' WHERE connection_id=${id} AND state='intended'`;
        await sql`UPDATE factory.mcp_oauth_flow SET state='failed' WHERE connection_id=${id} AND state IN ('pending','exchanging')`;
        await sql`UPDATE factory.mcp_connect_intent SET state='uncertain' WHERE connection_id=${id} AND state='running'`;
        await sql`UPDATE factory.mcp_token_refresh SET state='uncertain' WHERE connection_id=${id} AND state='intended'`;
        await sql`INSERT INTO factory.mcp_connect_intent(id,connection_id,revision_id,created_by,fingerprint,state)
          VALUES(${input.commandId},${id},${input.revisionId},${userId},${commandFingerprint},'running')`;
        return {
          replay: false,
          authorizationUrl: null,
          authentication: revision.content.authentication,
        };
      });
      if (admission.replay) return { authorizationUrl: admission.authorizationUrl };
      let client: Awaited<ReturnType<typeof remote>> | undefined;
      try {
        if (input.token) await persist(id, { bearer: input.token }, input.commandId);
        const state =
          admission.authentication === "oauth" ? randomBytes(32).toString("base64url") : undefined;
        if (state)
          await database.client`INSERT INTO factory.mcp_oauth_flow(id,connection_id,created_by,state_digest,state,expires_at)
            VALUES(${input.commandId},${id},${userId},${mcpDigest(state)},'pending',now()+interval '10 minutes')`;
        client = await remote(id, state, input.commandId);
        try {
          await client.connect();
          const tools = await client.tools();
          await database.client`UPDATE factory.mcp_connection SET state='review',tools=${JSON.stringify(tools)}::jsonb,
            version=version+1 WHERE id=${id} AND state='authorizing' AND credential_epoch=${input.commandId}`;
        } catch (cause) {
          if (!(cause instanceof UnauthorizedError) || !client.redirect()) throw cause;
        }
        const authorizationUrl = client.redirect() ?? null;
        await database.client`UPDATE factory.mcp_connect_intent SET state='completed',authorization_url=${authorizationUrl} WHERE id=${input.commandId}`;
        return { authorizationUrl };
      } catch {
        await database.client`UPDATE factory.mcp_connect_intent SET state='failed' WHERE id=${input.commandId}`;
        await database.client`UPDATE factory.mcp_connection SET state='reconnect' WHERE id=${id} AND state='authorizing' AND credential_epoch=${input.commandId}`;
        throw new CommandError(
          "unavailable",
          "Could not connect to the MCP server. Check its endpoint, account access and OAuth callback allowlist",
        );
      } finally {
        await client?.close().catch(() => {});
      }
    },
    async callback(userId: string, params: URLSearchParams) {
      const state = params.get("state");
      if (!state || !params.get("code") || params.has("error"))
        throw new CommandError("conflict", "MCP authorization was cancelled or is invalid");
      const flow = await database.client.begin(async (sql) => {
        const [flow] = await sql<
          Array<{ id: string; connectionId: string }>
        >`SELECT id,connection_id AS "connectionId"
          FROM factory.mcp_oauth_flow WHERE state_digest=${mcpDigest(state)} AND created_by=${userId}
          AND state='pending' AND expires_at>now() FOR UPDATE`;
        if (!flow)
          throw new CommandError(
            "forbidden",
            "MCP authorization has expired or belongs to another session",
          );
        await library.authorizeIn(sql, flow.connectionId, userId);
        const connection = await library.connectionIn(sql, flow.connectionId);
        if (connection.credentialEpoch !== flow.id || connection.state !== "authorizing")
          throw new CommandError("conflict", "MCP authorization was replaced");
        await sql`UPDATE factory.mcp_oauth_flow SET state='exchanging' WHERE id=${flow.id}`;
        return flow;
      });
      let client: Awaited<ReturnType<typeof remote>> | undefined;
      try {
        client = await remote(flow.connectionId, undefined, flow.id);
        await client.transport.finishAuth(params);
        const connected = await remote(flow.connectionId, undefined, flow.id);
        try {
          await connected.connect();
          const tools = await connected.tools();
          await database.client.begin(async (sql) => {
            await library.authorizeIn(sql, flow.connectionId, userId);
            const [active] =
              await sql`SELECT id FROM factory.mcp_oauth_flow WHERE id=${flow.id} AND state='exchanging' FOR UPDATE`;
            if (!active) throw new CommandError("conflict", "MCP authorization was replaced");
            await sql`UPDATE factory.mcp_connection SET state='review',tools=${JSON.stringify(tools)}::jsonb,version=version+1
              WHERE id=${flow.connectionId} AND state='authorizing' AND credential_epoch=${flow.id}`;
            await sql`UPDATE factory.mcp_oauth_flow SET state='completed' WHERE id=${flow.id}`;
          });
        } finally {
          await connected.close().catch(() => {});
        }
        return { connected: true };
      } catch {
        await database.client`UPDATE factory.mcp_oauth_flow SET state='failed' WHERE id=${flow.id}`;
        await database.client`UPDATE factory.mcp_connection SET state='reconnect' WHERE id=${flow.connectionId} AND state='authorizing' AND credential_epoch=${flow.id}`;
        throw new CommandError(
          "unavailable",
          "MCP authorization could not be completed. Start a new connection in Settings",
        );
      } finally {
        await client?.close().catch(() => {});
      }
    },
    async call(
      assignment: MCPAssignment,
      projectId: string,
      userId: string,
      name: string,
      args: Record<string, unknown>,
      authorize: () => Promise<void>,
      signal: AbortSignal,
    ) {
      const expected = assignment.tools.find((tool) => tool.name === name);
      if (!expected) throw new CommandError("forbidden", "This MCP tool was not admitted");
      const validate = () => authorizeAssignment(assignment, projectId, userId);
      await authorize();
      await validate();
      const client = await remote(
        assignment.connectionId,
        undefined,
        assignment.credentialEpoch,
        async () => {
          await authorize();
          await validate();
        },
      );
      try {
        await client.connect();
        const tools = await client.tools();
        if (!tools.some((tool) => tool.name === name && tool.digest === expected.digest)) {
          await authorize();
          await validate();
          await database.client`UPDATE factory.mcp_connection SET state='review',tools=${JSON.stringify(tools)}::jsonb,
            allowed_tools='[]',version=version+1,updated_at=now()
            WHERE id=${assignment.connectionId} AND credential_epoch=${assignment.credentialEpoch} AND state='ready'`;
          throw new CommandError(
            "conflict",
            "The MCP tool changed. Review the connection in Settings",
          );
        }
        await authorize();
        await validate();
        const result = await client.client.callTool(
          { name, arguments: args },
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          },
        );
        await authorize();
        await validate();
        // Tool results are untrusted source data, not instructions or authority.
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (Buffer.byteLength(text) > 64000)
          throw new CommandError("conflict", "MCP result exceeds the context limit");
        return { content: text, isError: result.isError === true };
      } catch (cause) {
        if (cause instanceof CommandError) throw cause;
        throw new CommandError(
          "unavailable",
          "MCP lookup failed. Check connection status in Settings",
        );
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
